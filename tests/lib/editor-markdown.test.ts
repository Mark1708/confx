import { webcrypto } from "node:crypto";
import { zipSync, strToU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MAX_EDITABLE_MARKDOWN_BYTES,
  createEditorMarkdown,
  readEditorMarkdown,
} from "@/lib/editor-markdown";
import {
  applyRoundtripMarkdown,
  createRoundtripPackage,
  writeRoundtripArchive,
  type EditorSnapshot,
} from "@/lib/offline-roundtrip";

const target = { host: "https://wiki.example.test/confluence", pageId: "123" };
const source =
  '<p class="intro">Original paragraph.</p>' +
  '<table class="confluenceTable"><thead><tr><th>Key</th></tr></thead><tbody><tr><td>Original cell</td></tr></tbody></table>' +
  '<pre class="code"><code class="language-text">original code\n</code></pre>' +
  '<p><img data-macro-name="toc" data-macro-id="stable" src="/placeholder"></p>' +
  '<p class="hidden">Hidden source</p>';
const snapshot: EditorSnapshot = {
  representation: "editor",
  html: source,
  title: "Page",
  pageId: "123",
};
const prefix = "<!-- confx:editor-markdown ";

function metadata(file: string): Record<string, unknown> {
  return JSON.parse(file.slice(file.lastIndexOf(prefix) + prefix.length).replace(/ -->\n?$/, ""));
}
function replaceMetadata(file: string, edit: (value: Record<string, unknown>) => void): string {
  const value = metadata(file);
  edit(value);
  return file.slice(0, file.lastIndexOf(prefix)) + prefix + JSON.stringify(value) + " -->\n";
}
function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
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

describe("single editable editor Markdown file", () => {
  it("roundtrips the original baseline and exact source as an actual no-op", async () => {
    const pkg = await createRoundtripPackage(snapshot);
    const file = await createEditorMarkdown(snapshot, target);
    expect(file.startsWith(pkg.baselineMarkdown + "\n\n" + prefix)).toBe(true);
    const loaded = await readEditorMarkdown(file);
    expect(loaded.target).toEqual(target);
    expect(loaded.markdown).toBe(pkg.baselineMarkdown);
    expect(loaded.package).toEqual(pkg);
    expect(await applyRoundtripMarkdown(loaded.package, loaded.markdown)).toMatchObject({
      status: "unchanged",
      html: source,
      changes: [],
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["paragraph", "Original paragraph", "Updated paragraph"],
    ["table", "Original cell", "Updated cell"],
    ["code", "original code", "updated code"],
  ])("applies an edited %s while preserving all other exact HTML", async (_kind, before, after) => {
    const file = (await createEditorMarkdown(snapshot, target)).replace(before, after);
    const loaded = await readEditorMarkdown(file);
    expect(loaded.package.baselineMarkdown).toContain(before);
    const result = await applyRoundtripMarkdown(loaded.package, loaded.markdown);
    expect(result.status).toBe("ready");
    expect(result.html).toBe(source.replace(before, after));
  });

  it.each(["CRLF", "BOM", "BOM and CRLF"])(
    "accepts %s without changing embedded source",
    async (mode) => {
      let file = await createEditorMarkdown(snapshot, target);
      if (mode.includes("CRLF")) file = file.replace(/\n/g, "\r\n");
      if (mode.includes("BOM")) file = "\uFEFF" + file;
      const loaded = await readEditorMarkdown(file);
      expect(loaded.markdown).toBe(loaded.package.baselineMarkdown);
      expect((await applyRoundtripMarkdown(loaded.package, loaded.markdown)).html).toBe(source);
    },
  );

  it("does not interpret footer-looking code content as metadata", async () => {
    const html = '<pre>&lt;!-- confx:editor-markdown {"format":"fake"} --&gt;\n</pre>';
    const file = await createEditorMarkdown({ ...snapshot, html }, target);
    const loaded = await readEditorMarkdown(file);
    expect((await applyRoundtripMarkdown(loaded.package, loaded.markdown)).html).toBe(html);
    await expect(readEditorMarkdown("```\n" + prefix + "{} -->\n```")).rejects.toThrow(
      /metadata|footer/i,
    );
  });

  it("rejects ordinary Markdown, truncated metadata, duplicate metadata and trailing content", async () => {
    const file = await createEditorMarkdown(snapshot, target);
    const footer = file.slice(file.lastIndexOf(prefix));
    for (const invalid of [
      "# Ordinary Markdown",
      file.slice(0, -10),
      file + footer,
      file + "extra",
    ]) {
      await expect(readEditorMarkdown(invalid)).rejects.toThrow(/metadata|footer/i);
    }
  });

  it.each([
    ["format", "unknown"],
    ["pageId", "456"],
    ["pageId", "not-numeric"],
    ["host", "https://user:secret@wiki.example.test"],
    ["host", "https://wiki.example.test?q=x"],
    ["host", "https://wiki.example.test#fragment"],
    ["host", "javascript:alert(1)"],
    ["host", "https://WIKI.example.test"],
    ["archive", "!!!!"],
    ["archive", "AA=A"],
    ["archive", "Zh=="],
    ["archive", ""],
    ["extra", true],
  ])("rejects invalid metadata %s=%s", async (field, value) => {
    const file = await createEditorMarkdown(snapshot, target);
    await expect(
      readEditorMarkdown(
        replaceMetadata(file, (meta) => {
          meta[field] = value;
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects invalid JSON and missing metadata fields", async () => {
    const file = await createEditorMarkdown(snapshot, target);
    await expect(
      readEditorMarkdown(file.slice(0, file.lastIndexOf(prefix)) + prefix + "{broken -->"),
    ).rejects.toThrow(/metadata|JSON/i);
    await expect(
      readEditorMarkdown(
        replaceMetadata(file, (meta) => {
          delete meta.archive;
        }),
      ),
    ).rejects.toThrow(/metadata/i);
  });

  it("rejects corrupt ZIP and altered canonical source integrity", async () => {
    const file = await createEditorMarkdown(snapshot, target);
    await expect(
      readEditorMarkdown(
        replaceMetadata(file, (meta) => {
          meta.archive = base64(strToU8("not a ZIP"));
        }),
      ),
    ).rejects.toThrow();
    const files = unzipSync(writeRoundtripArchive(await createRoundtripPackage(snapshot)));
    files[".confx/source.html"] = strToU8(source.replace("Original", "Tampered"));
    await expect(
      readEditorMarkdown(
        replaceMetadata(file, (meta) => {
          meta.archive = base64(zipSync(files));
        }),
      ),
    ).rejects.toThrow(/hash|baseline|source/i);
  });

  it("rejects an archive whose index.md has been edited instead of the outer Markdown", async () => {
    const pkg = await createRoundtripPackage(snapshot);
    const file = await createEditorMarkdown(snapshot, target);
    await expect(
      readEditorMarkdown(
        replaceMetadata(file, (meta) => {
          meta.archive = base64(
            writeRoundtripArchive(pkg, pkg.baselineMarkdown.replace("Original", "Wrong layer")),
          );
        }),
      ),
    ).rejects.toThrow(/baseline|index/i);
  });

  it("rejects oversize files before base64 decoding", async () => {
    const decode = vi.spyOn(globalThis, "atob");
    try {
      await expect(readEditorMarkdown("x".repeat(MAX_EDITABLE_MARKDOWN_BYTES + 1))).rejects.toThrow(
        /35 MiB|size|limit/i,
      );
      expect(decode).not.toHaveBeenCalled();
    } finally {
      decode.mockRestore();
    }
  });

  it("rejects oversized Unicode file bytes and outer unpaired surrogates", async () => {
    await expect(
      readEditorMarkdown("Ж".repeat(MAX_EDITABLE_MARKDOWN_BYTES / 2 + 1)),
    ).rejects.toThrow(/size|limit|35 MiB/i);
    const file = await createEditorMarkdown(snapshot, target);
    await expect(readEditorMarkdown(file.replace("Original", "\uD800"))).rejects.toThrow(
      /Unicode/i,
    );
  });

  it("validates snapshot identity and lossless Unicode before exporting", async () => {
    await expect(createEditorMarkdown({ ...snapshot, pageId: "456" }, target)).rejects.toThrow(
      /page|identity/i,
    );
    await expect(createEditorMarkdown({ ...snapshot, pageId: undefined }, target)).rejects.toThrow(
      /page|identity/i,
    );
    await expect(
      createEditorMarkdown({ ...snapshot, html: "<p>\uD800</p>" }, target),
    ).rejects.toThrow(/Unicode/i);
    await expect(createEditorMarkdown(snapshot, { ...target, pageId: "abc" })).rejects.toThrow(
      /page/i,
    );
  });

  it("cannot inject HTML comment delimiters through host metadata", async () => {
    const hostile = { ...target, host: "https://wiki.example.test/<!--oops-->" };
    await expect(createEditorMarkdown(snapshot, hostile)).rejects.toThrow(/host|URL|canonical/i);
  });
});
