import { webcrypto } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applyRoundtripMarkdown, createRoundtripPackage } from "@/lib/offline-roundtrip/roundtrip";
import { createEditorMarkdown, readEditorMarkdown } from "@/lib/editor-markdown";
import type { RoundtripPackage } from "@/lib/offline-roundtrip/contracts";

const macro =
  '<p><img class="editor-inline-macro" data-macro-name="toc" data-macro-id="fixed-id" src="/macro?definition=original"></p>';
const hidden = '<p class="enh-settings hidden" data-editor="preserve">{ "private": true }</p>';
const tail = `<!-- preserve original whitespace -->\n${macro}\n${hidden}`;

async function fixture(html: string): Promise<RoundtripPackage> {
  return createRoundtripPackage({
    representation: "editor",
    html,
    title: "Structural fixture",
    pageId: "123",
  });
}

function replaceRegion(pkg: RoundtripPackage, index: number, markdown: string): string {
  const block = pkg.blocks[index];
  const closing = `\n\n<!-- confx:end id="${block.id}" -->`;
  return pkg.baselineMarkdown.replace(`${block.markdown}${closing}`, `${markdown}${closing}`);
}

function documentOf(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

beforeAll(() => vi.stubGlobal("crypto", webcrypto));
afterAll(() => vi.unstubAllGlobals());

describe("ordinary Markdown edits in source-mapped regions", () => {
  it("adds bold, emphasis and inline code while retaining original outer and unchanged inline attributes", async () => {
    const html = `<p id="intro" class="original" style="margin-left: 12px"><span style="color: red">Alpha</span> plain words.</p>${tail}`;
    const pkg = await fixture(html);
    const result = await applyRoundtripMarkdown(
      pkg,
      replaceRegion(pkg, 0, "Alpha **plain** _words_ and `code`."),
    );
    expect(result.status).toBe("ready");
    const doc = documentOf(result.html!);
    expect(doc.querySelector("p#intro")?.getAttribute("style")).toBe("margin-left: 12px");
    expect(doc.querySelector("p#intro")?.className).toBe("original");
    expect(result.html).toContain('<span style="color: red">Alpha</span>');
    expect(doc.querySelector("p strong")?.textContent).toBe("plain");
    expect(doc.querySelector("p em")?.textContent).toBe("words");
    expect(doc.querySelector("p code")?.textContent).toBe("code");
    expect(result.html?.endsWith(tail)).toBe(true);
  });

  it("changes safe link destinations without losing editor link attributes or retaining a stale data-mce-href", async () => {
    const html = `<p><a class="external-link" target="_blank" href="https://example.com/old" data-mce-href="https://example.com/old" title="Before">Read</a></p>${tail}`;
    const pkg = await fixture(html);
    const result = await applyRoundtripMarkdown(
      pkg,
      replaceRegion(pkg, 0, '[Read](https://example.com/new "After")'),
    );
    expect(result.status).toBe("ready");
    const link = documentOf(result.html!).querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://example.com/new");
    expect(link.getAttribute("data-mce-href")).toBe("https://example.com/new");
    expect(link.getAttribute("title")).toBe("After");
    expect(link.className).toBe("external-link");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(result.html?.endsWith(tail)).toBe(true);
  });

  it("changes a heading level without dropping its anchor, style or compatible inline attributes", async () => {
    const html = `<h2 id="original-anchor" class="heading" style="text-align: center"><strong data-editor="bold">Title</strong></h2>${tail}`;
    const pkg = await fixture(html);
    const result = await applyRoundtripMarkdown(pkg, replaceRegion(pkg, 0, "#### **Title**"));
    expect(result.status).toBe("ready");
    const heading = documentOf(result.html!).querySelector("h4")!;
    expect(heading.id).toBe("original-anchor");
    expect(heading.className).toBe("heading");
    expect(heading.getAttribute("style")).toBe("text-align: center");
    expect(heading.querySelector("strong")?.getAttribute("data-editor")).toBe("bold");
    expect(result.html?.endsWith(tail)).toBe(true);
  });

  it("splits a paragraph and inserts nested lists inside its existing identity", async () => {
    const html = `<p id="editable" class="intro">Alpha beta</p>${tail}`;
    const pkg = await fixture(html);
    const markdown = "Alpha\n\nbeta\n\n- First\n- Second\n  - Nested\n\n1. Ordered";
    const result = await applyRoundtripMarkdown(pkg, replaceRegion(pkg, 0, markdown));
    expect(result.status).toBe("ready");
    const doc = documentOf(result.html!);
    expect(doc.querySelector("p#editable")?.textContent).toBe("Alpha");
    expect(doc.querySelectorAll("#editable")).toHaveLength(1);
    expect(
      Array.from(doc.querySelectorAll("body > p"))
        .slice(0, 2)
        .map((node) => node.textContent),
    ).toEqual(["Alpha", "beta"]);
    expect(doc.querySelectorAll("ul li")).toHaveLength(3);
    expect(doc.querySelector("ol li")?.textContent).toBe("Ordered");
    expect(result.html?.endsWith(tail)).toBe(true);
  });

  it("can empty an ordinary mapped region without deleting its mandatory identity or unrelated source", async () => {
    const html = `<p id="remove">Remove this</p>\n${tail}`;
    const pkg = await fixture(html);
    const result = await applyRoundtripMarkdown(pkg, replaceRegion(pkg, 0, ""));
    expect(result.status).toBe("ready");
    expect(result.html).toBe(`\n${tail}`);
  });

  it("inserts ordinary paragraphs and lists between identities, including beside a protected macro", async () => {
    const html = `<p id="first">First</p>\n${macro}\n<p id="last">Last</p>\n${hidden}`;
    const pkg = await fixture(html);
    const beforeMacro = `<!-- confx:block id="${pkg.blocks[1].id}" -->`;
    const beforeLast = `<!-- confx:block id="${pkg.blocks[2].id}" -->`;
    const markdown = pkg.baselineMarkdown
      .replace(beforeMacro, `## Inserted heading\n\n${beforeMacro}`)
      .replace(beforeLast, `Inserted paragraph\n\n- One\n- Two\n\n${beforeLast}`);
    const result = await applyRoundtripMarkdown(pkg, markdown);
    expect(result.status).toBe("ready");
    const doc = documentOf(result.html!);
    expect(doc.querySelector("h2")?.textContent).toBe("Inserted heading");
    expect(doc.querySelector("ul")?.textContent).toContain("One");
    expect(result.html).toContain(macro);
    expect(result.html).toContain('<p id="first">First</p>');
    expect(result.html).toContain('<p id="last">Last</p>');
    expect(result.html?.endsWith(hidden)).toBe(true);
  });

  it("inserts content before the first and after the last identity without moving hidden trailing source", async () => {
    const html = `<p>Original</p>\n${hidden}`;
    const pkg = await fixture(html);
    const marker = `<!-- confx:block id="${pkg.blocks[0].id}" -->`;
    const markdown = pkg.baselineMarkdown.replace(marker, `Before\n\n${marker}`) + "\nAfter\n";
    const result = await applyRoundtripMarkdown(pkg, markdown);
    expect(result.status).toBe("ready");
    expect(result.html).toContain("<p>Before</p>");
    expect(result.html).toContain("<p>After</p>");
    expect(result.html!.indexOf("<p>Before</p>")).toBeLessThan(
      result.html!.indexOf("<p>Original</p>"),
    );
    expect(result.html!.indexOf("<p>After</p>")).toBeLessThan(result.html!.indexOf(hidden));
    expect(result.html?.endsWith(`\n${hidden}`)).toBe(true);
  });
});

const table =
  '<table id="grid" class="confluenceTable custom-grid" style="width: 75%"><colgroup><col style="width: 30%"><col style="width: 70%"></colgroup><thead class="table-head"><tr class="header-row"><th class="confluenceTh" style="width: 30%">Key</th><th class="confluenceTh" style="width: 70%">Value</th></tr></thead><tbody class="table-body"><tr data-row="a"><td class="confluenceTd" style="width: 30%">A</td><td class="confluenceTd" style="width: 70%"><span style="color: blue">Original</span>&nbsp;<code data-editor="inline">x&lt;y</code></td></tr><tr data-row="b"><td class="confluenceTd" style="width: 30%">B</td><td class="confluenceTd" style="width: 70%">Second</td></tr></tbody></table>';
const unchangedCell =
  '<td class="confluenceTd" style="width: 70%"><span style="color: blue">Original</span>&nbsp;<code data-editor="inline">x&lt;y</code></td>';

describe("structural table edits retain Confluence formatting", () => {
  it("adds a row while retaining exact existing cells, row attributes, widths and macro/hidden bytes", async () => {
    const pkg = await fixture(`${table}${tail}`);
    const markdown = `${pkg.blocks[0].markdown}\n| C | **Third** |`;
    const result = await applyRoundtripMarkdown(pkg, replaceRegion(pkg, 0, markdown));
    expect(result.status).toBe("ready");
    const doc = documentOf(result.html!);
    const grid = doc.querySelector("table")!;
    expect(grid.id).toBe("grid");
    expect(grid.className).toBe("confluenceTable custom-grid");
    expect(grid.getAttribute("style")).toBe("width: 75%");
    expect(grid.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(grid.querySelector('tr[data-row="a"]')).not.toBeNull();
    expect(grid.querySelector("tbody")?.className).toBe("table-body");
    expect(grid.querySelectorAll("col")).toHaveLength(2);
    expect(grid.querySelectorAll("tbody tr:last-child .confluenceTd")).toHaveLength(2);
    expect(grid.querySelector("tbody tr:last-child td")?.getAttribute("style")).toBe("width: 30%");
    expect(result.html).toContain(unchangedCell);
    expect(result.html?.endsWith(tail)).toBe(true);
  });

  it("inserts a column between existing columns without shifting their formatting or unchanged cell bytes", async () => {
    const pkg = await fixture(`${table}${tail}`);
    const markdown = pkg.blocks[0].markdown
      .split("\n")
      .map((line, index) => {
        const position = line.indexOf(" | ");
        const inserted =
          index === 0 ? "Added" : index === 1 ? "---" : index === 2 ? "New A" : "New B";
        return `${line.slice(0, position)} | ${inserted}${line.slice(position)}`;
      })
      .join("\n");
    const result = await applyRoundtripMarkdown(pkg, replaceRegion(pkg, 0, markdown));
    expect(result.status).toBe("ready");
    const grid = documentOf(result.html!).querySelector("table")!;
    expect(grid.querySelectorAll("th")).toHaveLength(3);
    expect(grid.querySelectorAll("col")).toHaveLength(3);
    expect(grid.querySelector("th:last-child")?.getAttribute("style")).toBe("width: 70%");
    expect(grid.querySelector("tbody tr td:last-child")?.getAttribute("style")).toBe("width: 70%");
    expect(grid.querySelectorAll("th.confluenceTh")).toHaveLength(3);
    expect(result.html).toContain(unchangedCell);
    expect(result.html?.endsWith(tail)).toBe(true);
  });

  it("removes a row and column, keeping the surviving original row and cell source", async () => {
    const pkg = await fixture(`${table}${tail}`);
    const result = await applyRoundtripMarkdown(
      pkg,
      replaceRegion(pkg, 0, "| Value |\n| --- |\n| Second |"),
    );
    expect(result.status).toBe("ready");
    const grid = documentOf(result.html!).querySelector("table")!;
    expect(grid.querySelectorAll("th")).toHaveLength(1);
    expect(grid.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(grid.querySelector("tbody tr")?.getAttribute("data-row")).toBe("b");
    expect(grid.querySelector("td")?.getAttribute("style")).toBe("width: 70%");
    expect(result.html).toContain('<td class="confluenceTd" style="width: 70%">Second</td>');
    expect(result.html?.endsWith(tail)).toBe(true);
  });

  it("changes cell formatting and links without rewriting unrelated cell source", async () => {
    const pkg = await fixture(`${table}${tail}`);
    const result = await applyRoundtripMarkdown(
      pkg,
      replaceRegion(
        pkg,
        0,
        pkg.blocks[0].markdown.replace("Second", "[**Second**](https://example.com/new)"),
      ),
    );
    expect(result.status).toBe("ready");
    const cell = documentOf(result.html!).querySelector('tr[data-row="b"] td:last-child')!;
    expect(cell.className).toBe("confluenceTd");
    expect(cell.getAttribute("style")).toBe("width: 70%");
    expect(cell.querySelector("a")?.getAttribute("href")).toBe("https://example.com/new");
    expect(cell.querySelector("strong")?.textContent).toBe("Second");
    expect(result.html).toContain(unchangedCell);
    expect(result.html?.endsWith(tail)).toBe(true);
  });
});

describe("losslessness, compatibility and atomic safety", () => {
  it("accepts syntax-only Markdown changes as exact HTML identity", async () => {
    const html = `<h2 id='anchor'>Title</h2><p><strong class='bold'>bold</strong> and <em>italic</em></p>${tail}`;
    const pkg = await fixture(html);
    const markdown = pkg.baselineMarkdown
      .replace("## Title", "Title\n-----")
      .replace(/\*\*bold\*\*/g, "__bold__")
      .replace(/_italic_/g, "*italic*");
    const result = await applyRoundtripMarkdown(pkg, markdown);
    expect(result.status).toBe("unchanged");
    expect(result.html).toBe(html);
  });

  it("changes fenced-code language and payload whitespace without losing pre/code attributes", async () => {
    const html = `<pre id="code" class="code-fence" style="white-space: pre"><code class="editor-code language-text extra" data-editor="code">  first\nlast  </code></pre>${tail}`;
    const pkg = await fixture(html);
    const result = await applyRoundtripMarkdown(
      pkg,
      replaceRegion(pkg, 0, "```typescript\n  first\n\n  inserted  \nlast  \n```"),
    );
    expect(result.status).toBe("ready");
    const pre = documentOf(result.html!).querySelector("pre")!;
    expect(pre.id).toBe("code");
    expect(pre.className).toBe("code-fence");
    expect(pre.getAttribute("style")).toBe("white-space: pre");
    expect(pre.querySelector("code")?.className).toBe("editor-code language-typescript extra");
    expect(pre.querySelector("code")?.getAttribute("data-editor")).toBe("code");
    expect(pre.textContent).toBe("  first\n\n  inserted  \nlast  ");
    expect(result.html?.endsWith(tail)).toBe(true);
  });

  it("changes only the code language while preserving exact payload entity bytes and whitespace", async () => {
    const html = `<pre class='keep'><code class='language-text custom'>\tA&nbsp;&lt;B\n\n</code></pre>${tail}`;
    const pkg = await fixture(html);
    const result = await applyRoundtripMarkdown(
      pkg,
      replaceRegion(pkg, 0, pkg.blocks[0].markdown.replace("```text", "```json")),
    );
    expect(result.status).toBe("ready");
    expect(result.html).toBe(html.replace("language-text", "language-json"));
  });

  it("loads an already-exported single editable file through its embedded original map", async () => {
    const html = `<p class="original">Change me</p>${tail}`;
    const file = await createEditorMarkdown(
      { representation: "editor", html, title: "Fixture", pageId: "123" },
      { host: "https://example.com", pageId: "123" },
    );
    const loaded = await readEditorMarkdown(file.replace("Change me", "**Changed**\n\n- Added"));
    const result = await applyRoundtripMarkdown(loaded.package, loaded.markdown);
    expect(result.status).toBe("ready");
    expect(documentOf(result.html!).querySelector("strong")?.textContent).toBe("Changed");
    expect(documentOf(result.html!).querySelector("li")?.textContent).toBe("Added");
    expect(result.html?.endsWith(tail)).toBe(true);
  });

  it.each([
    "<script>alert(1)</script>",
    '<img src="/x" onerror="alert(1)">',
    "[unsafe](javascript:alert%281%29)",
    '<a href="java&#x73;cript:alert(1)">unsafe</a>',
    '<form><form onsubmit="alert(1)"></form></form>',
    '<span style="background: url(https://example.com)">unsafe</span>',
  ])(
    "rejects active content atomically, including source discarded by parsing: %s",
    async (unsafe) => {
      const html = `<p>First</p><p>Second</p>${tail}`;
      const pkg = await fixture(html);
      const markdown = replaceRegion(pkg, 0, "**Valid edit**").replace("Second", unsafe);
      const result = await applyRoundtripMarkdown(pkg, markdown);
      expect(result.status).toBe("blocked");
      expect(result.html).toBeUndefined();
      expect(result.changes.some((change) => change.supported)).toBe(true);
      expect(pkg.snapshot.html).toBe(html);
    },
  );

  it("rejects active gap insertions and newly manufactured macro HTML atomically", async () => {
    const pkg = await fixture(`<p>Original</p>${tail}`);
    for (const inserted of [
      '<img onerror="alert(1)" src="/x">',
      '<img data-macro-name="toc" data-macro-id="fake" src="/macro">',
    ]) {
      const marker = `<!-- confx:block id="${pkg.blocks[1].id}" -->`;
      const result = await applyRoundtripMarkdown(
        pkg,
        pkg.baselineMarkdown.replace(marker, `${inserted}\n\n${marker}`),
      );
      expect(result.status).toBe("blocked");
      expect(result.html).toBeUndefined();
    }
  });

  it("still blocks removed/reordered identities and opaque edits even alongside valid structural edits", async () => {
    const pkg = await fixture(`<p>Original</p>${tail}`);
    const changed = replaceRegion(pkg, 0, "**Valid**\n\nAdded paragraph");
    const result = await applyRoundtripMarkdown(
      pkg,
      changed.replace(pkg.blocks[1].markdown, "Removed macro"),
    );
    expect(result.status).toBe("blocked");
    expect(result.html).toBeUndefined();
    expect(result.changes.some((change) => change.supported)).toBe(true);
    const missing = await applyRoundtripMarkdown(
      pkg,
      changed.replace(
        `<!-- confx:block id="${pkg.blocks[1].id}" -->`,
        '<!-- confx:block id="unknown" -->',
      ),
    );
    expect(missing.status).toBe("blocked");
    expect(missing.html).toBeUndefined();
  });

  it("does not use structural regeneration to bypass ambiguous colored-span text boundaries", async () => {
    const html = `<p><span style="color:red">be</span><span style="color:blue">ta</span></p>${tail}`;
    const pkg = await fixture(html);
    const result = await applyRoundtripMarkdown(pkg, replaceRegion(pkg, 0, "replacement"));
    expect(result.status).toBe("blocked");
    expect(result.html).toBeUndefined();
    expect(result.issues[0]?.message).toMatch(/ambiguous inline-formatting boundary/i);
  });
});
