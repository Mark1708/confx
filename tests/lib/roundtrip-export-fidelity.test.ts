import { createHash, webcrypto } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { marked } from "marked";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createEditorMarkdown, readEditorMarkdown } from "@/lib/editor-markdown";
import {
  applyRoundtripMarkdown,
  createRoundtripPackage,
  readEditorSnapshot,
  readRoundtripArchive,
  type EditorSnapshot,
  type RoundtripBlock,
  type RoundtripPackage,
} from "@/lib/offline-roundtrip";
import {
  applyStorageMarkdown,
  createStorageMarkdownExport,
  readStorageMarkdown,
  type StorageSnapshot,
  type StorageRoundtripPackage,
} from "@/lib/storage-roundtrip";

const target = { host: "https://wiki.example.test/confluence", pageId: "123" };
const editor = (html: string): EditorSnapshot => ({
  representation: "editor",
  html,
  title: "Derived export fixture",
  pageId: target.pageId,
});
const storage = (html: string): StorageSnapshot => ({
  ...editor(html),
  representation: "storage",
  pageId: target.pageId,
  version: 4,
});
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const region = (id: string, markdown: string): string =>
  `<!-- confx:block id="${id}" -->\n\n${markdown}\n\n<!-- confx:end id="${id}" -->`;
const rendered = (markdown: string): Document =>
  new DOMParser().parseFromString(marked.parse(markdown, { gfm: true, async: false }), "text/html");

// Minimal, readable persisted v1 data: never regenerate these baselines using the current producer.
const legacyParagraph = "<p>\u00a0\u00a0List&lt;DictionaryElement&gt; result;</p>";
const adjacentParagraph = '<p class="keep">Adjacent paragraph.</p>';
const codeText = "\t<DictionaryElement> value;\n\n  end  \n";
const legacyCode =
  '<pre class="native"><code class="language-java">' +
  codeText.replace(/</g, "&lt;").replace(/>/g, "&gt;") +
  "</code></pre>";
const legacySource = legacyParagraph + adjacentParagraph + legacyCode;
const legacyMarkdown = [
  "\u00a0\u00a0List<DictionaryElement> result;",
  "Adjacent paragraph.",
  "```java\n" + codeText + "```",
];
const legacyParts = [legacyParagraph, adjacentParagraph, legacyCode];
const legacyBlocks: RoundtripBlock[] = legacyParts.map((part, index) => ({
  id: `b000${index}`,
  kind: index === 2 ? "code" : "paragraph",
  start: legacyParts.slice(0, index).join("").length,
  end: legacyParts.slice(0, index + 1).join("").length,
  markdown: legacyMarkdown[index],
  ...(index === 2 ? { codeEndsWithNewline: true } : {}),
}));
const legacyBody = legacyBlocks.map((block) => region(block.id, block.markdown)).join("\n\n");
const legacyEditorBaseline = `<!-- confx:roundtrip version="1" source="${hash(legacySource)}" -->\n\n${legacyBody}\n`;
const legacyStorageBaseline = `<!-- confx:storage-roundtrip version="1" page="123" revision="4" source="${hash(legacySource)}" -->\n\n${legacyBody}\n`;

function legacyArchive(baseline = legacyEditorBaseline): Uint8Array {
  const entries = {
    "index.md": baseline,
    "manifest.json": JSON.stringify({
      format: "confx-roundtrip/1",
      snapshot: { representation: "editor", title: editor("").title, pageId: "123" },
      sourceHash: hash(legacySource),
    }),
    ".confx/source.html": legacySource,
    ".confx/baseline.md": baseline,
    ".confx/mapping.json": JSON.stringify(legacyBlocks),
  };
  return zipSync(
    Object.fromEntries(Object.entries(entries).map(([name, text]) => [name, strToU8(text)])),
  );
}
function legacyEditorFile(): string {
  return (
    legacyEditorBaseline +
    "\n\n<!-- confx:editor-markdown " +
    JSON.stringify({
      format: "confx-editor-markdown/1",
      ...target,
      archive: Buffer.from(legacyArchive()).toString("base64"),
    }) +
    " -->\n"
  );
}
function legacyStorageFile(): string {
  return (
    legacyStorageBaseline +
    "\n\n<!-- confx:storage-markdown " +
    JSON.stringify({
      format: "confx-storage-markdown/1",
      ...target,
      version: 4,
      title: storage("").title,
      sourceHash: hash(legacySource),
      source: Buffer.from(legacySource).toString("base64"),
    }) +
    " -->\n"
  );
}

const metadataTable =
  '<table class="wrapped confluenceTable"><tbody class=""><tr>' +
  '<td class="highlight-#f4f5f7 confluenceTd" title="Background" data-highlight-colour="#f4f5f7"><strong>Field</strong></td>' +
  '<td class="highlight-#f4f5f7 confluenceTd" data-highlight-colour="#f4f5f7"><b>Value</b></td></tr>' +
  '<tr class=""><td class="confluenceTd">Purpose</td><td class="confluenceTd">Original value</td></tr>' +
  '<tr><td class="confluenceTd">Code</td><td class="confluenceTd"><code>client-lib</code></td></tr>' +
  "</tbody></table>";
const protectedTail =
  '<h1 data-numhead-preview="1. ">Purpose</h1><p>Ordinary paragraph.</p>' +
  '<ol><li>Ordered content</li></ol><h1 data-numhead-preview="2. ">Sections</h1>' +
  '<p><img class="editor-inline-macro" src="/placeholder?definition=e2NoaWxkcmVuOjN9&amp;version=2" data-macro-name="children" data-macro-id="stable" data-macro-parameters="depth=3"></p>' +
  '<p class="enh-settings hidden">{"enableNumbering":true}</p>';

beforeAll(() => vi.stubGlobal("crypto", webcrypto));
afterAll(() => vi.unstubAllGlobals());

describe("persisted v1 export fidelity", () => {
  it("reloads archived Storage metadata with NBSP/generics as a genuine exact no-op", async () => {
    const loaded = await readStorageMarkdown("\uFEFF" + legacyStorageFile().replace(/\n/g, "\r\n"));
    expect(loaded.package.baselineMarkdown).toBe(legacyStorageBaseline);
    expect(await applyStorageMarkdown(loaded.package, loaded.markdown)).toMatchObject({
      status: "unchanged",
      html: legacySource,
      changes: [],
      issues: [],
    });
    const edited = await applyStorageMarkdown(
      loaded.package,
      loaded.markdown.replace("Adjacent paragraph", "Changed paragraph"),
    );
    expect(edited.status).toBe("ready");
    expect(edited.html).toBe(legacySource.replace("Adjacent paragraph", "Changed paragraph"));
  });

  it("reloads declared editor v1 ZIP and footer baselines without changing their projection", async () => {
    const archive = await readRoundtripArchive(legacyArchive());
    const loaded = await readEditorMarkdown(legacyEditorFile());
    expect(archive.package.baselineMarkdown).toBe(legacyEditorBaseline);
    expect(loaded.package).toEqual(archive.package);
    expect(await applyRoundtripMarkdown(loaded.package, loaded.markdown)).toMatchObject({
      status: "unchanged",
      html: legacySource,
      changes: [],
      issues: [],
    });
    const edited = await applyRoundtripMarkdown(
      loaded.package,
      loaded.markdown.replace("Adjacent paragraph", "Changed paragraph"),
    );
    expect(edited.status).toBe("ready");
    expect(edited.html).toBe(legacySource.replace("Adjacent paragraph", "Changed paragraph"));
    await expect(
      readRoundtripArchive(legacyArchive(legacyEditorBaseline.replace("Adjacent", "Altered"))),
    ).rejects.toThrow(/baseline|source/i);
  });
});

describe("new editable literal and metadata projections", () => {
  const literals =
    "<p>List&lt;DictionaryElement&gt; result &amp; literal &amp;lt;name&amp;gt;.</p>" +
    "<table><tr><th>XML</th></tr><tr><td>&lt;dependency&gt;&lt;groupId&gt;example&lt;/groupId&gt;&lt;/dependency&gt;</td></tr></table>";

  it.each(["storage", "editor"] as const)(
    "renders and edits literal XML/generics as text in new %s exports",
    async (kind) => {
      const loaded =
        kind === "storage"
          ? await readStorageMarkdown(
              (await createStorageMarkdownExport(storage(literals), target)).markdown,
            )
          : await readEditorMarkdown(await createEditorMarkdown(editor(literals), target));
      const doc = rendered(loaded.markdown);
      expect(doc.querySelector("p")?.textContent).toBe(
        "List<DictionaryElement> result & literal &lt;name&gt;.",
      );
      expect(doc.querySelector("td")?.textContent).toBe(
        "<dependency><groupId>example</groupId></dependency>",
      );
      expect(doc.querySelector("dictionaryelement, dependency, groupid, name")).toBeNull();
      const changed = loaded.markdown.replace("result", "values").replace("example", "updated");
      const result =
        kind === "storage"
          ? await applyStorageMarkdown(loaded.package as StorageRoundtripPackage, changed)
          : await applyRoundtripMarkdown(loaded.package as RoundtripPackage, changed);
      expect(result.status).toBe("ready");
      expect(result.html).toBe(literals.replace("result", "values").replace("example", "updated"));
      const reloaded =
        kind === "storage"
          ? await readStorageMarkdown(
              (await createStorageMarkdownExport(storage(result.html!), target)).markdown,
            )
          : await readEditorMarkdown(await createEditorMarkdown(editor(result.html!), target));
      expect(rendered(reloaded.markdown).querySelector("td")?.textContent).toBe(
        "<dependency><groupId>updated</groupId></dependency>",
      );
    },
  );

  it.each(["storage", "editor"] as const)(
    "preserves literal URL punctuation and leading angle text in %s",
    async (kind) => {
      const html =
        "<p>&gt; literal &amp;lt;Name&amp;gt; [ref|https://example.test/docs] and www.example.test/path</p><p>Neighbor</p>";
      const loaded =
        kind === "storage"
          ? await readStorageMarkdown(
              (await createStorageMarkdownExport(storage(html), target)).markdown,
            )
          : await readEditorMarkdown(await createEditorMarkdown(editor(html), target));
      expect(rendered(loaded.markdown).querySelector("p")?.textContent).toBe(
        "> literal &lt;Name&gt; [ref|https://example.test/docs] and www.example.test/path",
      );
      const changed = loaded.markdown.replace("Neighbor", "Changed neighbor");
      const result =
        kind === "storage"
          ? await applyStorageMarkdown(loaded.package as StorageRoundtripPackage, changed)
          : await applyRoundtripMarkdown(loaded.package as RoundtripPackage, changed);
      expect(result.status).toBe("ready");
      expect(result.html).toBe(html.replace("Neighbor", "Changed neighbor"));
    },
  );

  it.each(["storage", "editor"] as const)(
    "keeps meaningful fence payload whitespace through %s framing",
    async (kind) => {
      const loaded =
        kind === "storage"
          ? await readStorageMarkdown(
              (await createStorageMarkdownExport(storage(legacySource), target)).markdown,
            )
          : await readEditorMarkdown(await createEditorMarkdown(editor(legacySource), target));
      const changed = loaded.markdown.replace("value;\n", "changed;\n");
      const result =
        kind === "storage"
          ? await applyStorageMarkdown(loaded.package as StorageRoundtripPackage, changed)
          : await applyRoundtripMarkdown(loaded.package as RoundtripPackage, changed);
      expect(result.status).toBe("ready");
      expect(result.html).toBe(legacySource.replace("value;", "changed;"));
    },
  );

  it.each(["storage", "editor"] as const)(
    "retains tab-indented gap content as code rather than trimming it in %s",
    async (kind) => {
      const loaded =
        kind === "storage"
          ? await readStorageMarkdown(
              (await createStorageMarkdownExport(storage("<p>Neighbor</p>"), target)).markdown,
            )
          : await readEditorMarkdown(await createEditorMarkdown(editor("<p>Neighbor</p>"), target));
      const changed = loaded.markdown.replace(
        '<!-- confx:block id="b0000" -->',
        '\tList<DictionaryElement> value;  \n\n<!-- confx:block id="b0000" -->',
      );
      const result =
        kind === "storage"
          ? await applyStorageMarkdown(loaded.package as StorageRoundtripPackage, changed)
          : await applyRoundtripMarkdown(loaded.package as RoundtripPackage, changed);
      expect(result.status).toBe("ready");
      expect(rendered(result.html!).querySelector("pre code")?.textContent).toBe(
        "List<DictionaryElement> value;  \n",
      );
      expect(result.html?.endsWith("<p>Neighbor</p>")).toBe(true);
    },
  );

  it("exposes only explicit emphasized TD headers and preserves all native table and opaque bytes", async () => {
    const html = metadataTable + protectedTail;
    const loaded = await readEditorMarkdown(await createEditorMarkdown(editor(html), target));
    expect(rendered(loaded.markdown).querySelector("th")?.textContent).toBe("Field");
    expect(rendered(loaded.markdown).querySelector("td")?.textContent).toBe("Purpose");
    expect(loaded.markdown).not.toContain("enableNumbering");
    expect(loaded.markdown).not.toContain("1. Purpose");
    expect(await applyRoundtripMarkdown(loaded.package, loaded.markdown)).toMatchObject({
      status: "unchanged",
      html,
      changes: [],
    });
    const result = await applyRoundtripMarkdown(
      loaded.package,
      loaded.markdown
        .replace("Original value", "Changed value")
        .replace("Ordinary paragraph", "Changed paragraph"),
    );
    expect(result.status).toBe("ready");
    expect(result.html).toBe(
      html
        .replace("Original value", "Changed value")
        .replace("Ordinary paragraph", "Changed paragraph"),
    );
    const conflict = await applyRoundtripMarkdown(
      loaded.package,
      loaded.markdown.replace("[Confx protected children:", "[Changed children:"),
    );
    expect(conflict.status).toBe("blocked");
    expect(conflict.html).toBeUndefined();
  });

  it("edits the native Storage TD metadata grid without converting its header tags or attributes", async () => {
    const html =
      metadataTable +
      '<h1 data-numhead-preview="1. ">Purpose</h1>' +
      '<p class="enh-settings hidden">{"enableNumbering":true}</p>';
    const loaded = await readStorageMarkdown(
      (await createStorageMarkdownExport(storage(html), target)).markdown,
    );
    expect(rendered(loaded.markdown).querySelector("td")?.textContent).toBe("Purpose");
    const result = await applyStorageMarkdown(
      loaded.package,
      loaded.markdown.replace("Original value", "Changed value"),
    );
    expect(result.status).toBe("ready");
    expect(result.html).toBe(html.replace("Original value", "Changed value"));
  });

  it("retains native TD header semantics when a body cell gains formatting", async () => {
    const pkg = await createRoundtripPackage(editor(metadataTable));
    const result = await applyRoundtripMarkdown(
      pkg,
      pkg.baselineMarkdown.replace("Original value", "**Changed value**"),
    );
    expect(result.status).toBe("ready");
    expect(result.html).toBe(
      metadataTable.replace("Original value", "<strong>Changed value</strong>"),
    );
  });

  it("rejects a changed format declaration rather than guessing the baseline projection", async () => {
    const storageFile = (await createStorageMarkdownExport(storage(literals), target)).markdown;
    await expect(
      readStorageMarkdown(
        storageFile.replace(
          '"format":"confx-storage-markdown/2"',
          '"format":"confx-storage-markdown/1"',
        ),
      ),
    ).rejects.toThrow(/identity|version|package/i);
    const editorFile = await createEditorMarkdown(editor(literals), target);
    await expect(
      readEditorMarkdown(
        editorFile.replace(
          '"format":"confx-editor-markdown/2"',
          '"format":"confx-editor-markdown/1"',
        ),
      ),
    ).rejects.toThrow(/version/i);
    const pkg = await createRoundtripPackage(editor(literals));
    const result = await applyRoundtripMarkdown(
      { ...pkg, format: "confx-roundtrip/1" },
      pkg.baselineMarkdown,
    );
    expect(result.status).toBe("blocked");
    expect(result.html).toBeUndefined();
  });

  it.each(["storage", "editor"] as const)(
    "rejects removed block framing instead of trimming arbitrary whitespace in %s",
    async (kind) => {
      const loaded =
        kind === "storage"
          ? await readStorageMarkdown(
              (await createStorageMarkdownExport(storage(legacySource), target)).markdown,
            )
          : await readEditorMarkdown(await createEditorMarkdown(editor(legacySource), target));
      const changed = loaded.markdown.replace('id="b0000" -->\n\n', 'id="b0000" -->\n');
      const result =
        kind === "storage"
          ? await applyStorageMarkdown(loaded.package as StorageRoundtripPackage, changed)
          : await applyRoundtripMarkdown(loaded.package as RoundtripPackage, changed);
      expect(result.status).toBe("blocked");
      expect(result.html).toBeUndefined();
    },
  );

  it("preserves the declared v1 opaque TD table mapping instead of retroactively exposing cells", async () => {
    const sourceHash = hash(metadataTable);
    const block: RoundtripBlock = {
      id: "b0000",
      kind: "opaque",
      start: 0,
      end: metadataTable.length,
      markdown: "[Confx protected table: b0000]",
    };
    const baseline = `<!-- confx:roundtrip version="1" source="${sourceHash}" -->\n\n${region(block.id, block.markdown)}\n`;
    const files = {
      "index.md": baseline,
      "manifest.json": JSON.stringify({
        format: "confx-roundtrip/1",
        snapshot: { representation: "editor", title: "Metadata" },
        sourceHash,
      }),
      ".confx/source.html": metadataTable,
      ".confx/baseline.md": baseline,
      ".confx/mapping.json": JSON.stringify([block]),
    };
    const loaded = await readRoundtripArchive(
      zipSync(
        Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])),
      ),
    );
    expect(await applyRoundtripMarkdown(loaded.package, loaded.markdown)).toMatchObject({
      status: "unchanged",
      html: metadataTable,
      changes: [],
    });
  });

  it("does not guess an ordinary TD row, partial emphasis, merged cells or nested tables to be a header", async () => {
    for (const html of [
      "<table><tr><td>Field</td><td>Value</td></tr><tr><td>A</td><td>B</td></tr></table>",
      "<table><tr><td><strong>Field</strong></td><td>Value</td></tr></table>",
      "<table><tr><td><strong>Field</strong> suffix</td></tr></table>",
      '<table><tr><td colspan="2"><strong>Field</strong></td></tr></table>',
      "<table><tr><td><strong>Field</strong><table><tr><td>Nested</td></tr></table></td></tr></table>",
    ]) {
      const pkg = await createRoundtripPackage(editor(html));
      expect(
        (
          await applyRoundtripMarkdown(
            pkg,
            pkg.baselineMarkdown.replace("[Confx protected table:", "[Changed table:"),
          )
        ).status,
      ).toBe("blocked");
      expect((await applyRoundtripMarkdown(pkg, pkg.baselineMarkdown)).html).toBe(html);
    }
  });

  it("extracts genuine iframe body without treating fonts or outer head as editable page content", async () => {
    const ui =
      '<div contenteditable="false" data-mce-bogus="true" class="synchrony-container synchrony-exclude"><div data-mce-bogus="true"></div></div>';
    const body = metadataTable + protectedTail + ui;
    const snapshot = readEditorSnapshot(
      '<html><head><style>@font-face{src:url(font.woff)}</style></head><body id="tinymce" data-title="Metadata">' +
        body +
        "</body></html>",
    );
    const pkg = await createRoundtripPackage(snapshot);
    expect((await applyRoundtripMarkdown(pkg, pkg.baselineMarkdown)).html).toBe(snapshot.html);
    const result = await applyRoundtripMarkdown(
      pkg,
      pkg.baselineMarkdown.replace("Original value", "Changed value"),
    );
    expect(result.status).toBe("ready");
    expect(result.html).toBe(snapshot.html.replace("Original value", "Changed value"));
    expect(result.html).toContain(protectedTail);
    expect(() =>
      readEditorSnapshot(
        '<html><head><style>body{}</style></head><body><p onclick="evil()">Unsafe</p></body></html>',
      ),
    ).toThrow(/unsafe|active/i);
  });

  it.each(["storage", "editor"] as const)(
    "still rejects malicious raw HTML on a valid literal %s edit",
    async (kind) => {
      const loaded =
        kind === "storage"
          ? await readStorageMarkdown(
              (await createStorageMarkdownExport(storage(literals), target)).markdown,
            )
          : await readEditorMarkdown(await createEditorMarkdown(editor(literals), target));
      const changed = loaded.markdown.replace("result", '<img src="x" onerror="evil()">');
      const result =
        kind === "storage"
          ? await applyStorageMarkdown(loaded.package as StorageRoundtripPackage, changed)
          : await applyRoundtripMarkdown(loaded.package as RoundtripPackage, changed);
      expect(result.status).toBe("blocked");
      expect(result.html).toBeUndefined();
    },
  );
});
