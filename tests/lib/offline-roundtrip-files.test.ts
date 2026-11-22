import { webcrypto } from "node:crypto";
import { strFromU8, strToU8, UnzipInflate, unzipSync, Zip, ZipPassThrough, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MAX_ROUNDTRIP_TEXT_BYTES,
  ROUNDTRIP_FORMAT,
  type EditorSnapshot,
} from "@/lib/offline-roundtrip/contracts";
import { assertSafeEditorSnapshot, readEditorSnapshot } from "@/lib/offline-roundtrip/snapshot";
import { readRoundtripArchive, writeRoundtripArchive } from "@/lib/offline-roundtrip/archive";
import { applyRoundtripMarkdown, createRoundtripPackage } from "@/lib/offline-roundtrip/roundtrip";

const snapshot: EditorSnapshot = {
  representation: "editor",
  html: '<p class="lorem">Lorem &amp; ipsum</p>\r\n<pre><code>dolor<br>sit</code></pre>',
  title: "Lorem typography",
  pageId: "1100",
  capturedAt: "2020-01-01T00:00:00.000Z",
};

function probe(schema = "confx-console-probe/1") {
  return {
    schema,
    status: "captured",
    capturedAt: snapshot.capturedAt,
    pageId: snapshot.pageId,
    metadata: { "ajs-page-id": snapshot.pageId, "ajs-draft-id": "1300" },
    snapshot: {
      representation: snapshot.representation,
      html: snapshot.html,
      title: snapshot.title,
      domHtmlBeforeSerialization: '<p onclick="unsafe()">Not the canonical capture</p>',
      observation: { domUnchanged: true, dirtyBefore: true, dirtyAfter: true },
    },
    candidates: [],
    errors: [],
  };
}

function zip(entries: Record<string, string | Uint8Array>): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries(entries).map(([name, content]) => [
        name,
        typeof content === "string" ? strToU8(content) : content,
      ]),
    ),
    { mtime: new Date("2020-01-01T00:00:00.000Z") },
  );
}

async function archiveEntries(): Promise<Record<string, Uint8Array>> {
  return unzipSync(writeRoundtripArchive(await createRoundtripPackage(snapshot)));
}

function replaceEntry(
  entries: Record<string, Uint8Array>,
  name: string,
  update: (text: string) => string,
): Uint8Array {
  return zip({ ...entries, [name]: update(strFromU8(entries[name])) });
}

// Change equal-length ZIP names in both headers without needing a permissive ZIP writer.
function renameZipEntry(bytes: Uint8Array, from: string, to: string): Uint8Array {
  const before = strToU8(from);
  const after = strToU8(to);
  if (before.length !== after.length) throw new Error("Test ZIP names must have equal length");
  const result = bytes.slice();
  const view = new DataView(result.buffer);
  for (let offset = 0; offset <= result.length - 4; offset += 1) {
    const signature = view.getUint32(offset, true);
    const fixed = signature === 0x04034b50 ? 30 : signature === 0x02014b50 ? 46 : 0;
    if (!fixed || offset + fixed + before.length > result.length) continue;
    const nameLength = view.getUint16(offset + (fixed === 30 ? 26 : 28), true);
    if (nameLength !== before.length) continue;
    if (before.every((byte, index) => byte === result[offset + fixed + index])) {
      result.set(after, offset + fixed);
    }
  }
  return result;
}

function alterDeclaredSize(bytes: Uint8Array, name: string, size: number): Uint8Array {
  const result = bytes.slice();
  const view = new DataView(result.buffer);
  for (let offset = 0; offset <= result.length - 4; offset += 1) {
    const signature = view.getUint32(offset, true);
    const fixed = signature === 0x04034b50 ? 30 : signature === 0x02014b50 ? 46 : 0;
    if (!fixed || offset + fixed + name.length > result.length) continue;
    const nameLength = view.getUint16(offset + (fixed === 30 ? 26 : 28), true);
    if (strFromU8(result.subarray(offset + fixed, offset + fixed + nameLength)) !== name) {
      continue;
    }
    view.setUint32(offset + (fixed === 30 ? 22 : 24), size, true);
  }
  return result;
}

beforeAll(() => vi.stubGlobal("crypto", webcrypto));
afterAll(() => vi.unstubAllGlobals());

describe("offline editor snapshot files", () => {
  it.each(["confx-console-probe/1", "confx-editor-probe/1"])(
    "recognizes the actual %s capture without copying diagnostic DOM or draft metadata",
    (schema) => {
      const input = probe(schema);
      if (schema === "confx-editor-probe/1") input.pageId = undefined;
      expect(readEditorSnapshot(JSON.stringify(input), "saved.json")).toEqual(snapshot);
    },
  );

  it("uses the original probe metadata page identity, not unrelated top-level fields", () => {
    const input = { ...probe("confx-editor-probe/1"), pageId: "1000" };
    expect(readEditorSnapshot(JSON.stringify(input)).pageId).toBe(snapshot.pageId);
  });

  it("accepts a missing page identity without inventing one", () => {
    const input = { ...probe(), pageId: null };
    expect(readEditorSnapshot(JSON.stringify(input)).pageId).toBeUndefined();
  });

  it("preserves raw fragment text, whitespace, entities, comments, and CRLF exactly", () => {
    const html = '\ufeff<!-- original -->\r\n<p data-note="a > b">Text&nbsp;🙂</p>\r\n';
    expect(readEditorSnapshot(html, "saved-editor.html")).toEqual({
      representation: "editor",
      html,
      title: "saved-editor",
    });
  });

  it("extracts exact body content through source locations, never serializing the tree", () => {
    const body = '\r\n<!-- <body> is not a delimiter -->\r\n<p data-note="x > y">A&nbsp;B</p>\r\n';
    const html =
      "<!doctype html><html><head><title>Wrapper title</title><script>headOnly()</script></head>" +
      `<body data-title="Editor &amp; title">${body}</body></html>`;
    expect(readEditorSnapshot(html, "saved.html")).toEqual({
      representation: "editor",
      html: body,
      title: "Editor & title",
    });
  });

  it("rejects full documents without an explicit closing body rather than guessing offsets", () => {
    expect(() => readEditorSnapshot("<!doctype html><html><body><p>Incomplete</p></html>")).toThrow(
      /body|exact/i,
    );
  });

  it.each([
    "<html><body><p>Content</p></body><script>outside()</script></html>",
    "<html><body><p>Content</p></body><p>Lost trailing content</p></html>",
    "<html><body><p>Content</p></body>Lost trailing text</html>",
    '<html onload="outside()"><body><p>Content</p></body></html>',
  ])("rejects document content outside body instead of silently dropping it: %s", (html) => {
    expect(() => readEditorSnapshot(html)).toThrow(/unsafe|active|outside|lose/i);
  });

  it.each([
    { log: { version: "1.2", entries: [] } },
    { access_token: "synthetic-not-a-secret", snapshot: probe().snapshot },
    { ...probe(), access_token: "synthetic-not-a-secret" },
    { ...probe(), log: { version: "1.2", entries: [] } },
    { representation: "editor", html: "<p>Arbitrary JSON</p>", title: "Unrecognized" },
    { ...probe(), schema: "confx-console-probe/2" },
    { ...probe(), schema: undefined, format: "confx-console-probe/1" },
    { ...probe(), status: "editor-not-found" },
    { ...probe(), status: "serialization-failed" },
    { ...probe(), snapshot: null },
    { ...probe(), snapshot: { ...probe().snapshot, representation: "storage" } },
  ])("rejects non-captures, HARs, token envelopes, and unknown schemas: %j", (input) => {
    expect(() => readEditorSnapshot(JSON.stringify(input), "input.json")).toThrow();
  });

  it.each(["", "0", "-1", "12.4", "123abc", " 123", "１２３", 123])(
    "rejects invalid supplied page identity %j",
    (pageId) => {
      expect(() => readEditorSnapshot(JSON.stringify({ ...probe(), pageId }))).toThrow(/page/i);
    },
  );

  it.each([
    "<p>Before</p><script>alert(1)</script>",
    '<iframe src="https://example.invalid"></iframe>',
    '<object data="document.html"></object>',
    '<embed src="document.html">',
    "<form><p>Document in an active form</p></form>",
    '<p ONCLICK="alert(1)">Handler</p>',
    '<body onload="alert(1)"><p>Wrapper handler</p></body>',
    '<div srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;">Nested HTML</div>',
    '<a href="java&#x73;cript:alert(1)">Unsafe link</a>',
    '<a href="java&#10;script:alert(1)">Obfuscated link</a>',
    '<img src="data:image/svg+xml;base64,AAAA">',
    '<img srcset="safe.png 1x, javascript:alert(1) 2x">',
    '<img data-mce-src="javascript:alert(1)" src="safe.png">',
    '<svg><a xlink:href="javascript:alert(1)">SVG</a></svg>',
    "<template><script>alert(1)</script></template>",
    '<meta http-equiv="refresh" content="0;url=https://example.invalid">',
    '<p style="width:expression(alert(1))">CSS expression</p>',
    '<p style="background:url(javascript:alert(1))">CSS URL</p>',
    '<p style="background:u\\72l(javascript:alert(1))">Escaped CSS URL</p>',
  ])("rejects active HTML without sanitizing away source content: %s", (html) => {
    expect(() => readEditorSnapshot(html)).toThrow(/unsafe|active|not allowed/i);
    expect(() => assertSafeEditorSnapshot({ ...snapshot, html })).toThrow();
  });

  it("keeps supported inert editor attributes, styles, relative assets and safe links intact", () => {
    const html =
      '<p class="enh-settings hidden" style="text-align: left;">{}</p>' +
      '<img class="editor-inline-macro" data-macro-name="toc" src="/plugins/placeholder">' +
      '<a href="https://example.invalid/path">Link</a><a href="mailto:a@example.invalid">Email</a>';
    expect(readEditorSnapshot(html).html).toBe(html);
  });

  it("enforces UTF-8 bytes for raw files, probe envelopes, and direct engine snapshots", () => {
    const html = `<p>${"я".repeat(MAX_ROUNDTRIP_TEXT_BYTES / 2)}</p>`;
    expect(() => readEditorSnapshot(html)).toThrow(/5|size|large|limit/i);
    expect(() => assertSafeEditorSnapshot({ ...snapshot, html })).toThrow(/5|size|large|limit/i);
    const oversizedProbe = JSON.stringify({
      ...probe(),
      padding: "x".repeat(MAX_ROUNDTRIP_TEXT_BYTES),
    });
    expect(() => readEditorSnapshot(oversizedProbe)).toThrow(/5|size|large|limit/i);
  });

  it("rejects non-editor direct API snapshots and non-lossless Unicode", () => {
    expect(() =>
      assertSafeEditorSnapshot({ ...snapshot, representation: "view" } as never),
    ).toThrow();
    expect(() => assertSafeEditorSnapshot({ ...snapshot, pageId: "../1000" })).toThrow(/page/i);
    expect(() => readEditorSnapshot("<p>\ud800</p>")).toThrow(/unicode|UTF/i);
  });
});

describe("self-contained offline roundtrip archives", () => {
  it("writes exactly five members with metadata but no duplicate source in the manifest", async () => {
    const pkg = await createRoundtripPackage(snapshot);
    const entries = unzipSync(writeRoundtripArchive(pkg));
    expect(Object.keys(entries).sort()).toEqual([
      ".confx/baseline.md",
      ".confx/mapping.json",
      ".confx/source.html",
      "index.md",
      "manifest.json",
    ]);
    const { html, ...metadata } = snapshot;
    expect(strFromU8(entries[".confx/source.html"])).toBe(html);
    expect(JSON.parse(strFromU8(entries["manifest.json"]))).toEqual({
      format: ROUNDTRIP_FORMAT,
      snapshot: metadata,
      sourceHash: pkg.sourceHash,
    });
    expect(JSON.parse(strFromU8(entries[".confx/mapping.json"]))).toEqual(pkg.blocks);
  });

  it("reloads edited index.md but regenerates the original trusted mapping and baseline", async () => {
    const pkg = await createRoundtripPackage(snapshot);
    const markdown = pkg.baselineMarkdown.replace("Lorem", "Dolor");
    const loaded = await readRoundtripArchive(writeRoundtripArchive(pkg, markdown));
    expect(loaded.markdown).toBe(markdown);
    expect(loaded.package).toEqual(pkg);
    const result = await applyRoundtripMarkdown(loaded.package, loaded.markdown);
    expect(result.status).toBe("ready");
    expect(result.html).toBe(snapshot.html.replace("Lorem", "Dolor"));
  });

  it("preserves no-edit source equality including a UTF-8 BOM and CRLF through export/reload", async () => {
    const source = { ...snapshot, html: `\ufeff${snapshot.html}\r\n` };
    const pkg = await createRoundtripPackage(source);
    const loaded = await readRoundtripArchive(writeRoundtripArchive(pkg));
    expect(loaded.package.snapshot).toEqual(source);
    expect(await applyRoundtripMarkdown(loaded.package, loaded.markdown)).toMatchObject({
      status: "unchanged",
      html: source.html,
    });
  });

  it("accepts streaming ZIP data descriptors only after checking central-directory budgets", async () => {
    const entries = await archiveEntries();
    const chunks: Uint8Array[] = [];
    let size = 0;
    const archive = new Zip((error, chunk) => {
      if (error) throw error;
      chunks.push(chunk);
      size += chunk.length;
    });
    for (const [name, data] of Object.entries(entries)) {
      const member = new ZipPassThrough(name);
      member.mtime = new Date(2020, 0, 1);
      archive.add(member);
      member.push(data, true);
    }
    archive.end();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    expect((await readRoundtripArchive(bytes)).package.snapshot).toEqual(snapshot);
  });

  it("rejects altered original HTML", async () => {
    const entries = await archiveEntries();
    await expect(
      readRoundtripArchive(
        replaceEntry(entries, ".confx/source.html", (text) => text.replace("Lorem", "Dolor")),
      ),
    ).rejects.toThrow(/source|hash/i);
  });

  it.each(["id", "kind", "start", "end", "markdown", "extra"])(
    "rejects any altered mapping field: %s",
    async (field) => {
      const entries = await archiveEntries();
      const bytes = replaceEntry(entries, ".confx/mapping.json", (text) => {
        const blocks = JSON.parse(text);
        blocks[0][field] = field === "start" || field === "end" ? 1 : "tampered";
        return JSON.stringify(blocks);
      });
      await expect(readRoundtripArchive(bytes)).rejects.toThrow(/mapping/i);
    },
  );

  it("rejects changed code newline policy and removed blocks", async () => {
    const entries = await archiveEntries();
    const changedPolicy = replaceEntry(entries, ".confx/mapping.json", (text) => {
      const blocks = JSON.parse(text);
      const code = blocks.find((block: { kind: string }) => block.kind === "code");
      code.codeEndsWithNewline = !code.codeEndsWithNewline;
      return JSON.stringify(blocks);
    });
    await expect(readRoundtripArchive(changedPolicy)).rejects.toThrow(/mapping/i);
    const removed = replaceEntry(entries, ".confx/mapping.json", (text) =>
      JSON.stringify(JSON.parse(text).slice(1)),
    );
    await expect(readRoundtripArchive(removed)).rejects.toThrow(/mapping/i);
  });

  it("rejects altered baseline, declared hash, and unsupported format versions", async () => {
    const entries = await archiveEntries();
    await expect(
      readRoundtripArchive(
        replaceEntry(entries, ".confx/baseline.md", (text) => `${text}\nforged`),
      ),
    ).rejects.toThrow(/baseline/i);
    await expect(
      readRoundtripArchive(
        replaceEntry(entries, "manifest.json", (text) =>
          JSON.stringify({ ...JSON.parse(text), sourceHash: "0".repeat(64) }),
        ),
      ),
    ).rejects.toThrow(/source|hash/i);
    await expect(
      readRoundtripArchive(
        replaceEntry(entries, "manifest.json", (text) =>
          JSON.stringify({ ...JSON.parse(text), format: "confx-roundtrip/999" }),
        ),
      ),
    ).rejects.toThrow(/version|format/i);
  });

  it("accepts equivalent JSON key ordering without trusting imported offsets", async () => {
    const entries = await archiveEntries();
    const bytes = replaceEntry(entries, ".confx/mapping.json", (text) =>
      JSON.stringify(
        JSON.parse(text).map((block: Record<string, unknown>) =>
          Object.fromEntries(Object.entries(block).reverse()),
        ),
      ),
    );
    expect((await readRoundtripArchive(bytes)).package.snapshot).toEqual(snapshot);
  });

  it("clearly rejects ordinary legacy exports without canonical source", async () => {
    const bytes = zip({
      "lorem/index.md": "# Lorem overview",
      "lorem/manifest.json": JSON.stringify({ version: 1, pageId: "1000" }),
    });
    await expect(readRoundtripArchive(bytes)).rejects.toThrow(/canonical|legacy|ordinary/i);
  });

  it("rejects missing and extra members", async () => {
    const entries = await archiveEntries();
    const missing = { ...entries };
    delete missing[".confx/mapping.json"];
    await expect(readRoundtripArchive(zip(missing))).rejects.toThrow(/missing|five|5|members/i);
    await expect(
      readRoundtripArchive(zip({ ...entries, "extra.txt": "No extra data" })),
    ).rejects.toThrow(/extra|five|5|members/i);
  });

  it.each(["../outside.md", "/absolute.md", "C:/drive.md", ".confx/../source.html", "a\\b.md"])(
    "rejects unsafe ZIP paths before processing: %s",
    async (path) => {
      await expect(readRoundtripArchive(zip({ [path]: "Unsafe path" }))).rejects.toThrow(
        /path|unsafe/i,
      );
    },
  );

  it("rejects duplicate ZIP names rather than keeping the last entry", async () => {
    const bytes = renameZipEntry(
      zip({ "index.md": "first", "other.md": "second" }),
      "other.md",
      "index.md",
    );
    await expect(readRoundtripArchive(bytes)).rejects.toThrow(/duplicate/i);
  });

  it("rejects a declared ZIP bomb before creating any inflation stream", async () => {
    const entries = await archiveEntries();
    const bytes = alterDeclaredSize(zip(entries), "index.md", MAX_ROUNDTRIP_TEXT_BYTES + 1);
    const inflate = vi.spyOn(UnzipInflate.prototype, "push");
    try {
      await expect(readRoundtripArchive(bytes)).rejects.toThrow(/5|large|limit|size/i);
      expect(inflate).not.toHaveBeenCalled();
    } finally {
      inflate.mockRestore();
    }
  });

  it("rejects a total declared uncompressed budget above 20 MiB", async () => {
    const entries = await archiveEntries();
    let bytes = zip(entries);
    for (const path of Object.keys(entries)) {
      bytes = alterDeclaredSize(bytes, path, MAX_ROUNDTRIP_TEXT_BYTES);
    }
    await expect(readRoundtripArchive(bytes)).rejects.toThrow(/20|total|budget/i);
  });

  it("rejects members whose actual inflation exceeds their declared size", async () => {
    const entries = await archiveEntries();
    const bytes = alterDeclaredSize(
      zip({ ...entries, "index.md": "x".repeat(1024 * 1024) }),
      "index.md",
      1,
    );
    await expect(readRoundtripArchive(bytes)).rejects.toThrow(/declared|size|limit/i);
  });

  it("rejects malformed UTF-8 and incomplete ZIPs", async () => {
    const entries = await archiveEntries();
    await expect(
      readRoundtripArchive(zip({ ...entries, "index.md": new Uint8Array([0xc3, 0x28]) })),
    ).rejects.toThrow(/UTF|encoding/i);
    const bytes = zip(entries);
    await expect(readRoundtripArchive(bytes.subarray(0, bytes.length - 10))).rejects.toThrow(
      /ZIP/i,
    );
  });

  it("enforces the same text budget on edited Markdown at export", async () => {
    const pkg = await createRoundtripPackage(snapshot);
    expect(() => writeRoundtripArchive(pkg, "я".repeat(MAX_ROUNDTRIP_TEXT_BYTES / 2 + 1))).toThrow(
      /5|size|large|limit/i,
    );
  });
});
