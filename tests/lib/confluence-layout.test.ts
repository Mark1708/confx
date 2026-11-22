import { describe, expect, it } from "vitest";

import {
  CONFX_LAYOUT_MARKER_VERSION,
  extractConfluenceLayout,
  formatConfluenceLayoutMarkdown,
} from "../../src/lib/confluence-layout";

const VIEW_LAYOUT = `
  <div class="contentLayout2">
    <div class="columnLayout two-equal" data-layout="two-equal">
      <div class="cell normal"><div class="innerCell"><h2>Left</h2><p>Alpha</p></div></div>
      <div class="cell normal"><div class="innerCell"><p><a href="https://www.plantuml.com/plantuml/uml/abc">Diagram</a></p></div></div>
    </div>
    <div class="columnLayout single" data-layout="single">
      <div class="cell normal"><div class="innerCell"><h2>Bottom</h2></div></div>
    </div>
  </div>
`;

const STORAGE_LAYOUT = `
  <ac:layout>
    <ac:layout-section ac:type="two_equal">
      <ac:layout-cell><h2>Left</h2><p>Alpha</p></ac:layout-cell>
      <ac:layout-cell><p>Diagram</p></ac:layout-cell>
    </ac:layout-section>
    <ac:layout-section ac:type="single">
      <ac:layout-cell><h2>Bottom</h2></ac:layout-cell>
    </ac:layout-section>
  </ac:layout>
`;

describe("Confluence layout extraction", () => {
  it("extracts synthetic rendered cells and validates them against storage", () => {
    const result = extractConfluenceLayout(VIEW_LAYOUT, STORAGE_LAYOUT);

    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;
    expect(result.layout.sections.map(({ type, cells }) => [type, cells.length])).toEqual([
      ["two_equal", 2],
      ["single", 1],
    ]);
    expect(result.layout.sections[0].cells[0].innerHTML).toContain("<h2>Left</h2>");
  });

  it.each([
    ["single", 1],
    ["two_equal", 2],
    ["two_left_sidebar", 2],
    ["two_right_sidebar", 2],
    ["three_equal", 3],
    ["three_with_sidebars", 3],
  ] as const)("accepts %s with its required cell count", (type, count) => {
    const cells = Array.from(
      { length: count },
      (_, index) => `<div class="cell"><div class="innerCell"><p>${index}</p></div></div>`,
    ).join("");
    const view = `<div class="contentLayout2"><div class="columnLayout ${type.replaceAll("_", "-")}" data-layout="${type.replaceAll("_", "-")}">${cells}</div></div>`;

    const result = extractConfluenceLayout(view);

    expect(result.kind).toBe("valid");
  });

  it("rejects storage and view shape mismatches", () => {
    const mismatchedStorage = STORAGE_LAYOUT.replace('ac:type="two_equal"', 'ac:type="single"');

    expect(extractConfluenceLayout(VIEW_LAYOUT, mismatchedStorage)).toMatchObject({
      kind: "invalid",
      sections: 2,
    });
  });

  it("returns none for ordinary content", () => {
    expect(extractConfluenceLayout("<h2>Plain</h2>", "<h2>Plain</h2>")).toEqual({
      kind: "none",
      sections: 0,
    });
  });
});

describe("Confluence layout Markdown contract", () => {
  it("formats invisible markers in section and cell order", () => {
    const extracted = extractConfluenceLayout(VIEW_LAYOUT, STORAGE_LAYOUT);
    expect(extracted.kind).toBe("valid");
    if (extracted.kind !== "valid") return;

    const markdown = formatConfluenceLayoutMarkdown(extracted.layout, (cell) =>
      cell.innerHTML
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    );
    expect(markdown).toBe(
      [
        `<!-- confx:layout:start version="${CONFX_LAYOUT_MARKER_VERSION}" -->`,
        "",
        '<!-- confx:section:start type="two_equal" -->',
        "",
        "<!-- confx:cell:start -->",
        "",
        "Left Alpha",
        "",
        "<!-- confx:cell:end -->",
        "",
        "<!-- confx:cell:start -->",
        "",
        "Diagram",
        "",
        "<!-- confx:cell:end -->",
        "",
        "<!-- confx:section:end -->",
        "",
        '<!-- confx:section:start type="single" -->',
        "",
        "<!-- confx:cell:start -->",
        "",
        "Bottom",
        "",
        "<!-- confx:cell:end -->",
        "",
        "<!-- confx:section:end -->",
        "",
        "<!-- confx:layout:end -->",
      ].join("\n"),
    );
  });
});
