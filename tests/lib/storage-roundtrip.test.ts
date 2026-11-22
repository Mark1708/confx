import { webcrypto } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_EDITABLE_MARKDOWN_BYTES } from "@/lib/editor-markdown";
import {
  applyStorageMarkdown,
  createStorageMarkdown,
  createStorageMarkdownExport,
  readStorageMarkdown,
  storageIdentity,
  type StorageSnapshot,
} from "@/lib/storage-roundtrip";

const target = { host: "https://wiki.example.test/confluence", pageId: "123" };
const opaque =
  '<ac:structured-macro ac:name="code" ac:macro-id="fixed" data-extra=\'keep\'>' +
  '<ac:parameter ac:name="language">xml</ac:parameter>' +
  "<ac:plain-text-body><![CDATA[<unsafe-looking>&raw;\nexact bytes]]></ac:plain-text-body>" +
  "</ac:structured-macro>";
const resource = '<ac:link ac:anchor="section"><ri:page ri:content-title="Other" /></ac:link>';
const source =
  "<p class='intro' data-custom=\"preserve\">Original paragraph.</p>\n" +
  opaque +
  "\n" +
  '<table class="confluenceTable"><tbody><tr><th>Key</th><th>Value</th></tr>' +
  '<tr data-row="one"><td>One</td><td>Original cell</td></tr></tbody></table>\n' +
  '<pre class="sample"><code class="language-text">original code\n</code></pre>\n' +
  resource;
const snapshot: StorageSnapshot = {
  representation: "storage",
  html: source,
  title: "Storage page",
  pageId: "123",
  version: 7,
};
const prefix = "<!-- confx:storage-markdown ";

function changeMetadata(file: string, edit: (value: Record<string, unknown>) => void): string {
  const offset = file.lastIndexOf(prefix);
  const value = JSON.parse(file.slice(offset + prefix.length).replace(/ -->\n?$/, ""));
  edit(value);
  return file.slice(0, offset) + prefix + JSON.stringify(value) + " -->\n";
}

function replaceRegion(markdown: string, before: string, after: string): string {
  return markdown.replace(`${before}\n\n<!-- confx:end`, `${after}\n\n<!-- confx:end`);
}

async function load(html = source) {
  return readStorageMarkdown(await createStorageMarkdown({ ...snapshot, html }, target));
}

beforeAll(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Network forbidden");
    }),
  );
});
afterAll(() => vi.unstubAllGlobals());

describe("self-contained reversible Storage Markdown", () => {
  it("loads offline, regenerates a trusted baseline, and returns every original source byte on no-op", async () => {
    const exported = await createStorageMarkdownExport(snapshot, target);
    const loaded = await readStorageMarkdown(exported.markdown);
    expect(loaded.target).toEqual(target);
    expect(loaded.package.snapshot).toEqual(snapshot);
    expect(loaded.package.sourceHash).toBe(exported.sourceHash);
    expect(exported.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(loaded.markdown).toBe(loaded.package.baselineMarkdown);
    expect(await applyStorageMarkdown(loaded.package, loaded.markdown)).toMatchObject({
      status: "unchanged",
      html: source,
      changes: [],
      issues: [],
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("edits ordinary text without serializing macros, CDATA, resource links or untouched attributes", async () => {
    const loaded = await load();
    const result = await applyStorageMarkdown(
      loaded.package,
      loaded.markdown.replace("Original paragraph", "Updated paragraph"),
    );
    expect(result.status).toBe("ready");
    expect(result.html).toBe(source.replace("Original paragraph", "Updated paragraph"));
    expect(result.html).toContain(opaque);
    expect(result.html).toContain(resource);
  });

  it("deletes an ordinary paragraph only when its mandatory source marker remains", async () => {
    const loaded = await load();
    const result = await applyStorageMarkdown(
      loaded.package,
      replaceRegion(loaded.markdown, "Original paragraph.", ""),
    );
    expect(result.status).toBe("ready");
    expect(result.html).toBe(source.slice(source.indexOf("\n")));
  });

  it.each([
    ["Original cell", "Updated cell"],
    ["original code", "updated code"],
  ])("patches native tables and pre/code text: %s", async (before, after) => {
    const loaded = await load();
    const result = await applyStorageMarkdown(
      loaded.package,
      loaded.markdown.replace(before, after),
    );
    expect(result.status).toBe("ready");
    expect(result.html).toBe(source.replace(before, after));
  });

  it("adds a table row and inline formatting without rewriting existing cells or protected neighbors", async () => {
    const loaded = await load();
    const markdown = loaded.markdown.replace(
      "| One | Original cell |",
      "| One | Original cell |\n| Two | **New cell** |",
    );
    const result = await applyStorageMarkdown(loaded.package, markdown);
    expect(result.status).toBe("ready");
    expect(result.html).toContain('<tr data-row="one"><td>One</td><td>Original cell</td></tr>');
    expect(result.html).toContain("<strong>New cell</strong>");
    expect(result.html).toContain(opaque);
    expect(() => storageIdentity(result.html!)).not.toThrow();
  });

  it("supports inline formatting, heading changes and structural splits at an ordinary boundary", async () => {
    const html = '<h2 id="anchor">Heading</h2><p class="keep">Alpha beta</p>' + opaque;
    const loaded = await load(html);
    const markdown = replaceRegion(
      loaded.markdown.replace("## Heading", "#### Heading"),
      "Alpha beta",
      "Alpha **beta**\n\nSecond paragraph\n\n- First\n- Second",
    );
    const result = await applyStorageMarkdown(loaded.package, markdown);
    expect(result.status).toBe("ready");
    expect(result.html).toContain('<h4 id="anchor">Heading</h4>');
    expect(result.html).toContain('<p class="keep">Alpha <strong>beta</strong></p>');
    expect(result.html).toContain("<p>Second paragraph</p>");
    expect(result.html).toContain("<ul>");
    expect(result.html?.endsWith(opaque)).toBe(true);
    expect(() => storageIdentity(result.html!)).not.toThrow();
  });

  it("inserts paragraphs beside mapped boundaries and emits valid XML for new void elements", async () => {
    const loaded = await load("<p>First</p>" + opaque);
    const marker = '<!-- confx:block id="b0000" -->';
    const markdown = loaded.markdown.replace(marker, `Before<br>line\n\n${marker}`) + "\nAfter\n";
    const result = await applyStorageMarkdown(loaded.package, markdown);
    expect(result.status).toBe("ready");
    expect(result.html).toContain("<br");
    expect(result.html).toContain("<p>After</p>");
    expect(result.html).toContain(opaque);
    expect(() => storageIdentity(result.html!)).not.toThrow();
  });

  it("exposes layout-cell children while preserving the exact layout wrapper and protected siblings", async () => {
    const html =
      '<ac:layout data-layout="keep"><ac:layout-section ac:type="two_equal">\n' +
      "<ac:layout-cell><p class='cell'>Layout text</p>" +
      opaque +
      "</ac:layout-cell>" +
      "<ac:layout-cell><p>Other cell</p></ac:layout-cell>\n</ac:layout-section></ac:layout>";
    const loaded = await load(html);
    expect(loaded.markdown).toContain("Layout text");
    expect(loaded.markdown).toContain("Other cell");
    const result = await applyStorageMarkdown(
      loaded.package,
      loaded.markdown.replace("Layout text", "Edited layout"),
    );
    expect(result.status).toBe("ready");
    expect(result.html).toBe(html.replace("Layout text", "Edited layout"));
  });

  it("blocks a gap between layout cells atomically instead of choosing a column", async () => {
    const html =
      '<ac:layout><ac:layout-section ac:type="two_equal">' +
      "<ac:layout-cell><p>Left cell</p></ac:layout-cell>" +
      "<ac:layout-cell><p>Right cell</p></ac:layout-cell>" +
      "</ac:layout-section></ac:layout>";
    const loaded = await load(html);
    const marker = '<!-- confx:block id="b0001" -->';
    const markdown = loaded.markdown
      .replace("Left cell", "Otherwise valid edit")
      .replace(marker, `Ambiguous insertion\n\n${marker}`);
    const result = await applyStorageMarkdown(loaded.package, markdown);
    expect(result.status).toBe("blocked");
    expect(result.html).toBeUndefined();
    expect(result.issues.some((item) => /ambiguous|container|boundary/i.test(item.message))).toBe(
      true,
    );
  });

  it("allows an insertion between two mapped siblings in the same layout cell", async () => {
    const html =
      '<ac:layout><ac:layout-section ac:type="two_equal">' +
      "<ac:layout-cell><p>Left first</p><p>Left second</p></ac:layout-cell>" +
      "<ac:layout-cell><p>Right cell</p></ac:layout-cell>" +
      "</ac:layout-section></ac:layout>";
    const loaded = await load(html);
    const marker = '<!-- confx:block id="b0001" -->';
    const result = await applyStorageMarkdown(
      loaded.package,
      loaded.markdown.replace(marker, `Inserted into left\n\n${marker}`),
    );
    expect(result.status).toBe("ready");
    expect(result.html).toContain("<ac:layout-cell><p>Right cell</p></ac:layout-cell>");
    const inserted = result.html!.indexOf("<p>Inserted into left</p>");
    expect(inserted).toBeGreaterThan(result.html!.indexOf("<p>Left first</p>"));
    expect(inserted).toBeLessThan(result.html!.indexOf("<p>Left second</p>"));
    expect(inserted).toBeLessThan(result.html!.indexOf("</ac:layout-cell>"));
  });

  it.each(["before", "after"])(
    "blocks an ambiguous gap crossing the root/layout boundary: %s",
    async (position) => {
      const layout =
        '<ac:layout><ac:layout-section ac:type="single">' +
        "<ac:layout-cell><p>Cell text</p></ac:layout-cell>" +
        "</ac:layout-section></ac:layout>";
      const html =
        position === "before" ? "<p>Root text</p>" + layout : layout + "<p>Root text</p>";
      const loaded = await load(html);
      const marker = '<!-- confx:block id="b0001" -->';
      const result = await applyStorageMarkdown(
        loaded.package,
        loaded.markdown.replace(marker, `Ambiguous insertion\n\n${marker}`),
      );
      expect(result.status).toBe("blocked");
      expect(result.html).toBeUndefined();
    },
  );

  it.each(["before", "after"])(
    "does not guess a layout-cell target for a file-edge insertion: %s",
    async (position) => {
      const html =
        '<ac:layout><ac:layout-section ac:type="single">' +
        "<ac:layout-cell><p>Cell text</p></ac:layout-cell>" +
        "</ac:layout-section></ac:layout>";
      const loaded = await load(html);
      const marker = '<!-- confx:block id="b0000" -->';
      const markdown =
        position === "before"
          ? loaded.markdown.replace(marker, `Ambiguous insertion\n\n${marker}`)
          : loaded.markdown + "\nAmbiguous insertion\n";
      const result = await applyStorageMarkdown(loaded.package, markdown);
      expect(result.status).toBe("blocked");
      expect(result.html).toBeUndefined();
    },
  );

  it("supports named HTML entities losslessly and does not change their untouched encoding", async () => {
    const html =
      '<p title="A&nbsp;B">A&nbsp;B &copy; &euro; &#x1f600;</p>' + opaque + "<p>Change</p>";
    const loaded = await load(html);
    expect((await applyStorageMarkdown(loaded.package, loaded.markdown)).html).toBe(html);
    const result = await applyStorageMarkdown(
      loaded.package,
      loaded.markdown.replace("Change", "Changed"),
    );
    expect(result.html).toBe(html.replace("Change", "Changed"));
  });

  it("blocks protected source edits, identity removal and mixed safe/unsupported edits atomically", async () => {
    const loaded = await load();
    const protectedLabel = /\[Confx protected [^\n]+\]/.exec(loaded.markdown)?.[0];
    expect(protectedLabel).toBeTruthy();
    for (const markdown of [
      loaded.markdown.replace(protectedLabel!, "Deleted macro"),
      loaded.markdown.replace('<!-- confx:block id="b0001" -->', ""),
      loaded.markdown.replace("Original paragraph", "Valid edit").replace(protectedLabel!, ""),
      loaded.markdown.replace('id="b0000"', 'id="b9999"'),
    ]) {
      const result = await applyStorageMarkdown(loaded.package, markdown);
      expect(result.status).toBe("blocked");
      expect(result.html).toBeUndefined();
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it("protects unknown ordinary and namespaced structures rather than dropping them", async () => {
    const html =
      '<custom data-unknown="yes">Unknown</custom><xyz:future xmlns:xyz="urn:future" xyz:flag="a">Secret</xyz:future>';
    const loaded = await load(html);
    expect(loaded.markdown).toContain("Confx protected");
    expect((await applyStorageMarkdown(loaded.package, loaded.markdown)).html).toBe(html);
  });

  it("keeps Confluence links and foreign script-named elements opaque without confusing their namespaces with HTML", async () => {
    const foreign =
      '<xyz:script xmlns:xyz="urn:future" data-private="keep">inert source</xyz:script>';
    const html = resource + foreign + "<p>Editable neighbor</p>";
    const loaded = await load(html);
    expect(loaded.markdown).not.toContain("inert source");
    expect((await applyStorageMarkdown(loaded.package, loaded.markdown)).html).toBe(html);
    const edited = await applyStorageMarkdown(
      loaded.package,
      loaded.markdown.replace("Editable neighbor", "Changed neighbor"),
    );
    expect(edited.status).toBe("ready");
    expect(edited.html).toBe(html.replace("Editable neighbor", "Changed neighbor"));
    const removed = await applyStorageMarkdown(
      loaded.package,
      loaded.markdown.replace("[Confx protected xyz:script: b0001]", ""),
    );
    expect(removed.status).toBe("blocked");
    expect(removed.html).toBeUndefined();
  });

  it("does not mistake a foreign default namespace or rebound ac prefix for native editable Storage", async () => {
    const html =
      '<p xmlns="urn:future">Foreign paragraph</p>' +
      '<ac:layout xmlns:ac="urn:future"><ac:layout-section><ac:layout-cell><p>Foreign layout</p></ac:layout-cell></ac:layout-section></ac:layout>';
    const loaded = await load(html);
    expect(loaded.markdown).not.toContain("Foreign paragraph");
    expect(loaded.markdown).not.toContain("Foreign layout");
    expect((await applyStorageMarkdown(loaded.package, loaded.markdown)).html).toBe(html);
  });

  it("preserves literal reserved mapping comments in native paragraph text", async () => {
    const html = '<p>&lt;!-- confx:block id="fake" --&gt;</p>' + opaque;
    const loaded = await load(html);
    expect((await applyStorageMarkdown(loaded.package, loaded.markdown)).html).toBe(html);
  });

  it.each([
    "<script>alert(1)</script>",
    '<p onclick="alert(1)">Event</p>',
    '<p><a href="jav&#x61;script:alert(1)">Link</a></p>',
    '<iframe src="https://example.test" />',
    '<p style="background:url(javascript:evil)">Style</p>',
    "<p>Broken",
    "<p><b>Wrong</p></b>",
    '<!DOCTYPE x [<!ENTITY ext SYSTEM "file:///etc/passwd">]><p>&ext;</p>',
    "<p>&unknownEntity;</p>",
    "<p>&notit;</p>",
    '<p x="a" x="b">duplicate</p>',
    '<ac:image><ri:url ri:value="javascript:evil" /></ac:image>',
    '<x:script xmlns:x="http://www.w3.org/1999/xhtml">active</x:script>',
    '<link href="https://example.test/style.css" />',
    '<x:link xmlns:x="http://www.w3.org/1999/xhtml" href="https://example.test/style.css" />',
    '<x:g xmlns:x="http://www.w3.org/2000/svg" />',
  ])("refuses malformed or unsafe archived source: %s", async (html) => {
    await expect(createStorageMarkdown({ ...snapshot, html }, target)).rejects.toThrow();
    expect(() => storageIdentity(html)).toThrow();
  });

  it("blocks raw active HTML inserted into an otherwise supported paragraph", async () => {
    const loaded = await load();
    const result = await applyStorageMarkdown(
      loaded.package,
      replaceRegion(loaded.markdown, "Original paragraph.", "<script>alert(1)</script>"),
    );
    expect(result.status).toBe("blocked");
    expect(result.html).toBeUndefined();
  });

  it("blocks mixed ordinary and unknown raw structures instead of dropping the unknown content", async () => {
    const loaded = await load();
    const markdown = replaceRegion(
      loaded.markdown,
      "Original paragraph.",
      'Valid edit\n\n<custom data-future="preserve">Unsupported</custom>',
    );
    const result = await applyStorageMarkdown(loaded.package, markdown);
    expect(result.status).toBe("blocked");
    expect(result.html).toBeUndefined();
  });

  it("keeps an empty page reversible and supports insertion into its root boundary", async () => {
    const loaded = await load("");
    expect((await applyStorageMarkdown(loaded.package, loaded.markdown)).html).toBe("");
    const result = await applyStorageMarkdown(
      loaded.package,
      loaded.markdown + "\nNew paragraph\n",
    );
    expect(result.status).toBe("ready");
    expect(result.html).toContain("<p>New paragraph</p>");
  });

  it("regenerates source mappings instead of trusting a caller-modified package", async () => {
    const loaded = await load();
    const result = await applyStorageMarkdown(
      { ...loaded.package, baselineMarkdown: "Tampered" },
      loaded.markdown,
    );
    expect(result.status).toBe("blocked");
    expect(result.html).toBeUndefined();
  });
});

describe("strict Storage Markdown file reader", () => {
  it("accepts a BOM/CRLF file without normalizing the archived source bytes", async () => {
    const file = await createStorageMarkdown(
      { ...snapshot, html: "<p>A\r\nB</p>" + opaque },
      target,
    );
    const loaded = await readStorageMarkdown("\uFEFF" + file.replace(/\n/g, "\r\n"));
    expect(loaded.package.snapshot.html).toBe("<p>A\r\nB</p>" + opaque);
  });

  it("ignores footer-looking code content but never accepts a footer inside a fence", async () => {
    const html = "<pre>&lt;!-- confx:storage-markdown {} --&gt;\n</pre>";
    const loaded = await load(html);
    expect((await applyStorageMarkdown(loaded.package, loaded.markdown)).html).toBe(html);
    await expect(readStorageMarkdown("```\n" + prefix + "{} -->\n```")).rejects.toThrow(
      /metadata|footer/i,
    );
  });

  it("rejects ordinary Markdown, duplicate/truncated metadata and content after the footer", async () => {
    const file = await createStorageMarkdown(snapshot, target);
    const footer = file.slice(file.lastIndexOf(prefix));
    for (const value of ["# Ordinary", file.slice(0, -12), file + footer, file + "Extra"]) {
      await expect(readStorageMarkdown(value)).rejects.toThrow(/metadata|footer/i);
    }
  });

  it.each([
    ["format", "confx-editor-markdown/1"],
    ["pageId", "456"],
    ["pageId", "0"],
    ["version", 0],
    ["version", 1.5],
    ["host", "https://user:pass@wiki.example.test"],
    ["sourceHash", "0".repeat(64)],
    ["source", "!!!!"],
    ["source", "Zh=="],
    ["source", Buffer.from([0xc3, 0x28]).toString("base64")],
    ["extra", true],
  ])("rejects metadata identity, integrity or encoding corruption: %s", async (field, value) => {
    const file = await createStorageMarkdown(snapshot, target);
    await expect(
      readStorageMarkdown(
        changeMetadata(file, (meta) => {
          meta[field] = value;
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects source tampering without trusting the archived hash", async () => {
    const file = await createStorageMarkdown(snapshot, target);
    const changed = changeMetadata(file, (meta) => {
      meta.source = Buffer.from(source.replace("Original", "Tampered")).toString("base64");
    });
    await expect(readStorageMarkdown(changed)).rejects.toThrow(/hash|integrity|source/i);
  });

  it("rejects source and whole-file limits before expensive parsing or decoding", async () => {
    const decode = vi.spyOn(globalThis, "atob");
    try {
      await expect(
        readStorageMarkdown("x".repeat(MAX_EDITABLE_MARKDOWN_BYTES + 1)),
      ).rejects.toThrow(/size|limit/i);
      expect(decode).not.toHaveBeenCalled();
    } finally {
      decode.mockRestore();
    }
    await expect(
      createStorageMarkdown(
        { ...snapshot, html: "<p>" + "x".repeat(5 * 1024 * 1024) + "</p>" },
        target,
      ),
    ).rejects.toThrow(/size|limit/i);
  });

  it.each([{ pageId: "0" }, { pageId: "abc" }, { version: 0 }, { version: -1 }, { version: 1.5 }])(
    "requires a positive page/version identity: %j",
    async (fields) => {
      await expect(
        createStorageMarkdown(
          { ...snapshot, ...fields },
          { ...target, pageId: fields.pageId ?? target.pageId },
        ),
      ).rejects.toThrow(/identity|page|version/i);
    },
  );
});

describe("validated XML structural identity", () => {
  it("ignores only attribute order, entity spelling, empty syntax and CDATA-vs-text", () => {
    const before =
      "<p z=\"last\" a='A&nbsp;B'>One &amp; two<![CDATA[ <three>]]><br /></p>" +
      '<ac:structured-macro ac:name="toc" ac:macro-id="same" />';
    const after =
      '<p a="A&#160;B" z="last">One &#38; two &lt;three&gt;<br></br></p>' +
      '<ac:structured-macro ac:macro-id="same" ac:name="toc"></ac:structured-macro>';
    expect(storageIdentity(before)).toBe(storageIdentity(after));
  });

  it.each([
    ["<p> A </p>", "<p>A</p>"],
    ['<p data-unknown="one">Text</p>', '<p data-unknown="two">Text</p>'],
    ["<p>Text</p>", "<p>Changed</p>"],
    [opaque, opaque.replace("fixed", "other")],
    [opaque, opaque.replace("&raw;", "&changed;")],
  ])("retains text, whitespace and every macro/unknown attribute mutation", (before, after) => {
    expect(storageIdentity(before)).not.toBe(storageIdentity(after));
  });
});
