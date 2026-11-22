import { describe, expect, it } from "vitest";

import { applyRules, exportRules, getExportTemplate, importRules } from "../../src/lib/rule-engine";
import type { ExtractionRule } from "../../src/types";

function parseMainHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function makeRule(overrides: Partial<ExtractionRule>): ExtractionRule {
  return {
    id: "test-rule",
    name: "Test rule",
    type: "selector",
    matcher: ".target",
    action: "to-md",
    enabled: true,
    ...overrides,
  };
}

describe("applyRules", () => {
  it("returns HTML unchanged with no tables when rules array is empty", () => {
    const html = '<article><h1>Title</h1><p class="body">Text</p></article>';

    const result = applyRules(html, []);

    expect(result).toEqual({ mainHtml: html, tables: [] });
  });

  it('removes matching elements for selector rules with action "skip"', () => {
    const html = '<main><p>Keep</p><aside class="noise">Drop</aside></main>';

    const result = applyRules(html, [makeRule({ action: "skip", matcher: ".noise" })]);
    const doc = parseMainHtml(result.mainHtml);

    expect(doc.querySelector(".noise")).toBeNull();
    expect(doc.querySelector("main")?.textContent).toContain("Keep");
    expect(result.tables).toEqual([]);
  });

  it('extracts a matching selector table to CSV and keeps the table in HTML for action "to-csv"', () => {
    const html = `
      <h1>API Component</h1>
      <table class="confluenceTable target">
        <tr><th>Prop</th><th>Type</th></tr>
        <tr><td>disabled</td><td>boolean</td></tr>
      </table>
    `;

    const result = applyRules(html, [makeRule({ action: "to-csv", matcher: "table.target" })]);
    const doc = parseMainHtml(result.mainHtml);

    expect(doc.querySelector("table.target")).not.toBeNull();
    expect(result.tables).toEqual([
      {
        csv: "Prop,Type\ndisabled,boolean",
        name: "api-component-01.csv",
        section: "api-component",
      },
    ]);
  });

  it("finds matching section headings by regex and extracts content tables", () => {
    const html = `
      <h2>API компонента</h2>
      <p>Intro</p>
      <table class="api-table"><tr><td>Name</td><td>Value</td></tr></table>
      <h2>Other section</h2>
      <table class="other-table"><tr><td>Skip</td></tr></table>
    `;

    const result = applyRules(html, [
      makeRule({ type: "section", matcher: "API\\s+компонента", action: "to-csv" }),
    ]);

    expect(result.tables).toEqual([
      {
        csv: "Name,Value",
        name: "api-компонента-01.csv",
        section: "api-компонента",
      },
    ]);
  });

  it('processes .expand-container elements for spoiler rules with action "to-csv"', () => {
    const html = `
      <h1>Details</h1>
      <div class="expand-container">
        <p>Collapsed content</p>
        <table><tr><td>Hidden</td><td>Value</td></tr></table>
      </div>
    `;

    const result = applyRules(html, [
      makeRule({ type: "spoiler", matcher: "ignored", action: "to-csv" }),
    ]);

    expect(result.tables).toEqual([
      {
        csv: "Hidden,Value",
        name: "details-01.csv",
        section: "details",
      },
    ]);
  });

  it("filters table rules to TABLE elements only", () => {
    const html = `
      <h1>Mixed Nodes</h1>
      <div class="target"><table><tr><td>Wrapped</td></tr></table></div>
      <table class="target"><tr><td>Direct</td></tr></table>
    `;

    const result = applyRules(html, [
      makeRule({ type: "table", matcher: ".target", action: "to-csv" }),
    ]);

    expect(result.tables).toEqual([
      {
        csv: "Direct",
        name: "mixed-nodes-01.csv",
        section: "mixed-nodes",
      },
    ]);
  });

  it('strips tablesorter classes for action "gfm-table"', () => {
    const html = `
      <table class="tablesorter tablesorter-default stickyTableHeaders confluenceTable">
        <tr><td>Cell</td></tr>
      </table>
    `;

    const result = applyRules(html, [
      makeRule({ type: "table", matcher: "table", action: "gfm-table" }),
    ]);
    const table = parseMainHtml(result.mainHtml).querySelector("table");

    expect(table?.className).toBe("confluenceTable");
    expect(result.tables).toEqual([]);
  });

  it('sets data-keep-html for action "keep-html"', () => {
    const html = '<section class="target"><p>Raw HTML block</p></section>';

    const result = applyRules(html, [makeRule({ action: "keep-html", matcher: ".target" })]);
    const section = parseMainHtml(result.mainHtml).querySelector("section");

    expect(section?.getAttribute("data-keep-html")).toBe("1");
    expect(result.tables).toEqual([]);
  });

  it('sets data-image-group for action "extract-images"', () => {
    const html = '<figure class="target"><img src="image.png" alt="Preview"></figure>';

    const result = applyRules(html, [
      makeRule({ id: "gallery-images", action: "extract-images", matcher: ".target" }),
    ]);
    const figure = parseMainHtml(result.mainHtml).querySelector("figure");

    expect(figure?.getAttribute("data-image-group")).toBe("gallery-images");
    expect(result.tables).toEqual([]);
  });

  it('leaves matching nodes unchanged for action "to-md"', () => {
    const html = '<div class="target"><strong>Markdown content</strong></div>';

    const result = applyRules(html, [makeRule({ action: "to-md", matcher: ".target" })]);

    expect(result).toEqual({ mainHtml: html, tables: [] });
  });

  it("skips disabled rules", () => {
    const html = '<main><p class="target">Should stay</p></main>';

    const result = applyRules(html, [
      makeRule({ action: "skip", matcher: ".target", enabled: false }),
    ]);

    expect(result).toEqual({ mainHtml: html, tables: [] });
  });

  it("handles invalid section regex without crashing", () => {
    const html = '<section><h2>API</h2><p class="target">Cell</p></section>';

    expect(() =>
      applyRules(html, [makeRule({ type: "section", matcher: "(", action: "to-csv" })]),
    ).not.toThrow();
    expect(
      applyRules(html, [makeRule({ type: "section", matcher: "(", action: "to-csv" })]),
    ).toEqual({
      mainHtml: html,
      tables: [],
    });
  });

  it("handles invalid CSS selectors without crashing", () => {
    const html = '<main><p class="target">Should stay</p></main>';

    expect(() => applyRules(html, [makeRule({ action: "skip", matcher: "[" })])).not.toThrow();
    expect(applyRules(html, [makeRule({ action: "skip", matcher: "[" })])).toEqual({
      mainHtml: html,
      tables: [],
    });
  });

  it("deduplicates CSV output when the same table is matched by multiple rules", () => {
    const html = `
      <h1>Duplicate CSV</h1>
      <table class="target confluenceTable"><tr><td>Only once</td></tr></table>
    `;

    const result = applyRules(html, [
      makeRule({ id: "first", action: "to-csv", matcher: "table.target" }),
      makeRule({ id: "second", type: "table", action: "to-csv", matcher: ".confluenceTable" }),
    ]);

    expect(result.tables).toEqual([
      {
        csv: "Only once",
        name: "duplicate-csv-01.csv",
        section: "duplicate-csv",
      },
    ]);
  });

  it("extracts every table in a selected wrapper once even when wrappers and table selectors overlap", () => {
    const html = `
      <h1>Lorem tables</h1>
      <section class="target">
        <div class="target"><table><tr><td>Lorem</td></tr></table></div>
        <table><tr><td>Ipsum</td></tr></table>
      </section>
    `;

    const result = applyRules(html, [
      makeRule({ id: "wrappers", action: "to-csv", matcher: ".target" }),
      makeRule({ id: "overlap", action: "to-csv", matcher: ".target table" }),
    ]);

    expect(result.tables.map((table) => table.csv)).toEqual(["Lorem", "Ipsum"]);
    expect(new Set(result.tables.map((table) => table.name)).size).toBe(2);
    expect(parseMainHtml(result.mainHtml).querySelectorAll("table")).toHaveLength(2);
  });

  it("does not lose later tables when an imported rule matches only their enclosing wrapper", () => {
    const { preset, customRules } = importRules(
      JSON.stringify({
        version: 1,
        preset: {
          id: "md-only",
          name: "Lorem wrapper rules",
          description: "Synthetic imported rules",
          rules: [makeRule({ action: "to-csv", matcher: ".target" })],
        },
        customRules: [],
      }),
    );

    const result = applyRules(
      '<div class="target"><table><tr><td>Lorem</td></tr></table>' +
        "<table><tr><td>Ipsum</td></tr></table></div>",
      [...preset.rules, ...customRules],
    );

    expect(result.tables.map((table) => table.csv)).toEqual(["Lorem", "Ipsum"]);
    expect(parseMainHtml(result.mainHtml).querySelectorAll("table")).toHaveLength(2);
  });

  it("does not export Confluence attachments macro tables as CSV", () => {
    const html = `
      <h1>Other blocks</h1>
      <div class="conf-macro" data-macro-name="attachments">
        <table class="confluenceTable">
          <tr><th></th><th>Файл</th><th>Изменено</th></tr>
          <tr><td colspan="3">Файлов еще нет. Загрузить файл</td></tr>
        </table>
      </div>
      <table class="confluenceTable target">
        <tr><th>Columnt 1</th><th>Columnt 2</th><th>Columnt 3</th></tr>
        <tr><td>1</td><td>2</td><td>3</td></tr>
      </table>
    `;

    const result = applyRules(html, [makeRule({ action: "to-csv", matcher: "table" })]);

    expect(result.tables).toEqual([
      {
        csv: "Columnt 1,Columnt 2,Columnt 3\n1,2,3",
        name: "other-blocks-01.csv",
        section: "other-blocks",
      },
    ]);
  });

  it("extracts tables-only CSV additively and leaves package filtering to the producer", () => {
    const html = `
      <h1>Lorem tables</h1>
      <p>Ipsum body</p>
      <table class="confluenceTable">
        <tr><th>Lorem</th><th>Ipsum</th></tr>
        <tr><td>1</td><td>2</td></tr>
      </table>
    `;

    const result = applyRules(html, getExportTemplate("tables-only").rules);
    const doc = parseMainHtml(result.mainHtml);

    expect(result.tables.map((table) => table.csv)).toEqual(["Lorem,Ipsum\n1,2"]);
    expect(doc.querySelector("table")?.textContent).toContain("Lorem");
    expect(doc.querySelector("p")?.textContent).toBe("Ipsum body");
  });
});

describe("import/export", () => {
  it("throws for invalid JSON", () => {
    expect(() => importRules("{")).toThrow();
  });

  it("imports the existing versionless Options payload without losing base rules or their options", () => {
    const baseRule = makeRule({
      id: "lorem-legacy-base",
      action: "to-csv",
      matcher: "table.selected",
      options: { removeAfterCsv: false, columnLimit: 3 },
    });
    const customRule = makeRule({
      id: "ipsum-legacy-custom",
      action: "skip",
      matcher: ".private",
      options: { retained: true },
    });
    const payload = {
      preset: {
        id: "generic",
        name: "Lorem original base",
        description: "Ipsum original description",
        rules: [baseRule],
      },
      customRules: [customRule],
    };

    const imported = importRules(JSON.stringify(payload));
    const upgraded = JSON.parse(exportRules(imported.preset, imported.customRules));
    const reimported = importRules(JSON.stringify(upgraded));
    const result = applyRules(
      '<p>Lorem public body</p><aside class="private">Private</aside>' +
        '<table class="selected"><tr><td>Ipsum</td></tr></table>' +
        "<table><tr><td>Not selected</td></tr></table>",
      [...reimported.preset.rules, ...reimported.customRules],
    );

    expect(upgraded).toEqual({
      ...payload,
      version: 1,
      preset: { ...payload.preset, id: "md-only" },
    });
    expect(result.tables.map((table) => table.csv)).toEqual(["Ipsum"]);
    const doc = parseMainHtml(result.mainHtml);
    expect(doc.querySelectorAll("table")).toHaveLength(2);
    expect(doc.querySelector(".private")).toBeNull();
    expect(doc.querySelector("p")?.textContent).toBe("Lorem public body");
  });

  it.each([0, 2, "1", null])("rejects an explicit unsupported rules version %j", (version) => {
    const json = JSON.stringify({
      version,
      preset: { id: "md-only", name: "Lorem", description: "Ipsum", rules: [] },
      customRules: [],
    });

    expect(() => importRules(json)).toThrow();
  });

  it.each([
    ["generic", "md-only"],
    ["all-csv", "md-attachments"],
    ["full-page", "md-attachments"],
    ["api-doc", "md-attachments"],
    ["unknown-preset", "md-attachments"],
  ])("normalizes imported %s output policy without replacing its real rules", (id, presetId) => {
    const baseRule = makeRule({
      id: "lorem-base",
      matcher: "table.base",
      action: "to-csv",
      options: { delimiter: ";", columnLimit: 4, removeAfterCsv: false },
    });
    const customRule = makeRule({
      id: "ipsum-custom",
      matcher: ".private",
      action: "skip",
      options: { retained: true },
    });
    const imported = importRules(
      JSON.stringify({
        version: 1,
        preset: { id, name: "Lorem rules", description: "Ipsum payload", rules: [baseRule] },
        customRules: [customRule],
      }),
    );
    const result = applyRules(
      '<p>Lorem body</p><aside class="private">Private</aside>' +
        '<table class="base"><tr><td>Ipsum</td></tr></table>' +
        "<table><tr><td>Not selected</td></tr></table>",
      [...imported.preset.rules, ...imported.customRules],
    );

    expect(imported).toEqual({
      preset: {
        id: presetId,
        name: "Lorem rules",
        description: "Ipsum payload",
        rules: [baseRule],
      },
      customRules: [customRule],
    });
    expect(result.tables.map((table) => table.csv)).toEqual(["Ipsum"]);
    const doc = parseMainHtml(result.mainHtml);
    expect(doc.querySelectorAll("table")).toHaveLength(2);
    expect(doc.querySelector(".private")).toBeNull();
  });

  it("roundtrips the actual base and custom payload through version 1 without hidden template rules", () => {
    const preset = {
      id: "tables-only",
      name: "Lorem selected tables",
      description: "Ipsum selection",
      rules: [makeRule({ id: "base", matcher: "table.selected", action: "to-csv" })],
    };
    const customRules = [
      makeRule({ id: "overlap", matcher: "table.selected", action: "to-csv" }),
      makeRule({ id: "extra", matcher: "table.extra", action: "to-csv" }),
      makeRule({ id: "private", matcher: ".private", action: "skip" }),
    ];

    const json = exportRules(preset, customRules);
    const imported = importRules(json);
    const result = applyRules(
      '<p>Lorem public body</p><aside class="private">Private</aside>' +
        '<table class="selected"><tr><td>Lorem</td></tr></table>' +
        '<table class="extra"><tr><td>Ipsum</td></tr></table>' +
        "<table><tr><td>Not selected</td></tr></table>",
      [...imported.preset.rules, ...imported.customRules],
    );

    expect(JSON.parse(json)).toEqual({ version: 1, preset, customRules });
    expect(imported).toEqual({ preset, customRules });
    expect(result.tables.map((table) => table.csv)).toEqual(["Lorem", "Ipsum"]);
    const doc = parseMainHtml(result.mainHtml);
    expect(doc.querySelectorAll("table")).toHaveLength(3);
    expect(doc.querySelector(".private")).toBeNull();
    expect(doc.querySelector("p")?.textContent).toBe("Lorem public body");
  });

  it("preserves explicit legacy destructive rule options instead of silently making filtered exports editable", () => {
    const imported = importRules(
      exportRules({ id: "md-only", name: "Lorem", description: "Ipsum", rules: [] }, [
        makeRule({
          action: "to-csv",
          matcher: "table",
          options: { removeAfterCsv: true },
        }),
      ]),
    );
    const result = applyRules("<p>Lorem body</p><table><tr><td>Ipsum</td></tr></table>", [
      ...imported.preset.rules,
      ...imported.customRules,
    ]);

    expect(result.tables.map((table) => table.csv)).toEqual(["Ipsum"]);
    expect(parseMainHtml(result.mainHtml).querySelector("table")).toBeNull();
    expect(parseMainHtml(result.mainHtml).querySelector("p")?.textContent).toBe("Lorem body");
  });
});
