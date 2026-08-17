import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { base64ToBlob, blobToBase64, bundleExtractedPages } from "../../src/lib/bundler";
import type { ExtractedPage } from "../../src/types";

async function extractZip(blob: Blob): Promise<Record<string, Uint8Array>> {
  const buf = await blob.arrayBuffer();
  return unzipSync(new Uint8Array(buf));
}

function readEntry(entries: Record<string, Uint8Array>, path: string): string {
  const entry = entries[path];
  if (!entry) throw new Error(`Missing ZIP entry: ${path}`);
  return strFromU8(entry);
}

function hasEntry(entries: Record<string, Uint8Array>, path: string): boolean {
  return path in entries;
}

function makePage(overrides: Partial<ExtractedPage> = {}): ExtractedPage {
  return {
    meta: {
      id: "123",
      title: "Test Page",
      spaceKey: "TEST",
      baseUrl: "https://wiki.example.com",
      url: "https://wiki.example.com/pages/viewpage.action?pageId=123",
    },
    markdown: "# Test Page\n\nHello world",
    tables: [],
    images: [],
    attachments: [],
    comments: [],
    inlineComments: [],
    history: [],
    folder: "test-page",
    ...overrides,
  };
}

describe("bundleExtractedPages", () => {
  it("creates ZIP with root folder + index.md for a single page", async () => {
    const pages = [makePage()];
    const blob = await bundleExtractedPages(pages, { rootName: "export" });
    const entries = await extractZip(blob);

    expect(hasEntry(entries, "export/test-page/index.md")).toBe(true);
    expect(readEntry(entries, "export/test-page/index.md")).toBe("# Test Page\n\nHello world");
  });

  it("includes tables in tables/ subfolder", async () => {
    const pages = [
      makePage({
        tables: [
          { csv: "a,b\n1,2", name: "data-01.csv", section: "data" },
          { csv: "x,y\n3,4", name: "info-02.csv", section: "info" },
        ],
      }),
    ];
    const blob = await bundleExtractedPages(pages, { rootName: "export" });
    const entries = await extractZip(blob);

    expect(hasEntry(entries, "export/test-page/tables/data-01.csv")).toBe(true);
    expect(hasEntry(entries, "export/test-page/tables/info-02.csv")).toBe(true);
    expect(readEntry(entries, "export/test-page/tables/data-01.csv")).toBe("a,b\n1,2");
  });

  it("includes images and deduplicates by hash", async () => {
    const imgBlob = new Blob(["fake-png-data"], { type: "image/png" });
    const pages = [
      makePage({
        images: [
          { sourceUrl: "/img/a.png", zipPath: "images/a.png", blob: imgBlob, hash: "hash-a" },
          { sourceUrl: "/img/b.png", zipPath: "images/b.png", blob: imgBlob, hash: "hash-b" },
        ],
      }),
      makePage({
        folder: "other-page",
        images: [
          { sourceUrl: "/img/a.png", zipPath: "images/a.png", blob: imgBlob, hash: "hash-a" },
        ],
      }),
    ];
    const blob = await bundleExtractedPages(pages, { rootName: "export" });
    const entries = await extractZip(blob);

    expect(hasEntry(entries, "export/test-page/images/a.png")).toBe(true);
    expect(hasEntry(entries, "export/test-page/images/b.png")).toBe(true);
    // hash-a dedup: second occurrence skipped
    const allImageFiles = Object.keys(entries).filter((f) => f.includes("images/"));
    expect(allImageFiles).toHaveLength(2);
  });

  it("includes README.md and manifest.json when provided", async () => {
    const blob = await bundleExtractedPages([], {
      rootName: "export",
      readme: "# README",
      manifestJson: '{"version":1}',
    });
    const entries = await extractZip(blob);

    expect(readEntry(entries, "export/README.md")).toBe("# README");
    expect(readEntry(entries, "export/manifest.json")).toBe('{"version":1}');
  });

  it("creates a valid empty ZIP for empty pages", async () => {
    const blob = await bundleExtractedPages([], { rootName: "export" });
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/zip");
    expect(blob.size).toBeGreaterThan(0);
  });

  it("produces a valid Blob with application/zip type", async () => {
    const blob = await bundleExtractedPages([makePage()], { rootName: "export" });
    expect(blob).toBeInstanceOf(Blob);
  });

  it("handles multiple pages each in own folder", async () => {
    const pages = [makePage({ folder: "page-a" }), makePage({ folder: "page-b" })];
    const blob = await bundleExtractedPages(pages, { rootName: "export" });
    const entries = await extractZip(blob);

    expect(hasEntry(entries, "export/page-a/index.md")).toBe(true);
    expect(hasEntry(entries, "export/page-b/index.md")).toBe(true);
  });

  it("round-trips a large (>1MB) pre-compressed .docx attachment byte-exact", async () => {
    // Regression guard: a large incompressible binary attachment (the exact
    // scenario that produced a corrupt deflate stream). STORE mode must
    // preserve the bytes verbatim.
    const size = 1_200_003;
    const original = deterministicBytes(size, 42);
    const blob_ = new Blob([original], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    const pages = [
      makePage({
        attachments: [
          {
            sourceUrl: "/dl/arch.docx",
            zipPath: "attachments/arch.docx",
            blob: blob_,
            hash: "arch-hash",
            fileName: "Архитектура v1.1.docx",
            mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            fileSize: size,
          },
        ],
      }),
    ];
    const zipBlob = await bundleExtractedPages(pages, { rootName: "export" });
    const entries = await extractZip(zipBlob);

    const got = entries["export/test-page/attachments/arch.docx"];
    expect(got).toBeDefined();
    expect(got.length).toBe(size);
    expect(Array.from(got)).toEqual(Array.from(original));
  });

  it("round-trips a large .png image byte-exact", async () => {
    const size = 600_001;
    const original = deterministicBytes(size, 7);
    const blob_ = new Blob([original], { type: "image/png" });
    const pages = [
      makePage({
        images: [{ sourceUrl: "/i/d.png", zipPath: "images/d.png", blob: blob_, hash: "png-hash" }],
      }),
    ];
    const zipBlob = await bundleExtractedPages(pages, { rootName: "export" });
    const entries = await extractZip(zipBlob);

    const got = entries["export/test-page/images/d.png"];
    expect(got).toBeDefined();
    expect(Array.from(got)).toEqual(Array.from(original));
  });

  it("writes inline-comments.json only when inline comments are present", async () => {
    const blob = await bundleExtractedPages(
      [
        makePage({
          inlineComments: [
            {
              id: "inline-1",
              author: "Alice",
              updatedAt: "2025-03-01T10:00:00Z",
              body: "<p>Inline</p>",
              markdown: "Inline",
              selection: "selected text",
              markerRef: "marker-1",
              status: "open",
              replies: [
                {
                  id: "reply-1",
                  author: "Bob",
                  updatedAt: "2025-03-01T11:00:00Z",
                  body: "<p>Reply</p>",
                  markdown: "Reply",
                },
              ],
            },
          ],
        }),
        makePage({ folder: "without-inline" }),
      ],
      { rootName: "export" },
    );

    const entries = await extractZip(blob);
    const inlineJson = JSON.parse(readEntry(entries, "export/test-page/inline-comments.json"));

    expect(inlineJson[0].selection).toBe("selected text");
    expect(inlineJson[0].replies[0].id).toBe("reply-1");
    expect(hasEntry(entries, "export/without-inline/inline-comments.json")).toBe(false);
  });
});

// Deterministic pseudo-random bytes (xorshift32) — incompressible, mimicking
// the entropy of an already-compressed office document.
function deterministicBytes(n: number, seed: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(n));
  let s = seed >>> 0;
  for (let i = 0; i < n; i += 1) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    out[i] = s & 0xff;
  }
  return out;
}

describe("blobToBase64", () => {
  it("converts a text blob to base64", async () => {
    const blob = new Blob(["hello"], { type: "text/plain" });
    const b64 = await blobToBase64(blob);
    expect(b64).toBe(btoa("hello"));
  });

  it("handles empty blob", async () => {
    const blob = new Blob([], { type: "text/plain" });
    const b64 = await blobToBase64(blob);
    expect(b64).toBe("");
  });

  it("round-trips with base64ToBlob", async () => {
    const original = "Binary \x00\x01\x02 data";
    const blob = new Blob([original]);
    const b64 = await blobToBase64(blob);
    const restored = base64ToBlob(b64);
    const text = await restored.text();
    expect(text).toBe(original);
  });
});

describe("base64ToBlob", () => {
  it("decodes base64 to Blob", () => {
    const b64 = btoa("test data");
    const blob = base64ToBlob(b64);
    expect(blob).toBeInstanceOf(Blob);
  });

  it("uses application/zip as default MIME type", () => {
    const blob = base64ToBlob(btoa("x"));
    expect(blob.type).toBe("application/zip");
  });

  it("respects custom MIME type", () => {
    const blob = base64ToBlob(btoa("x"), "image/png");
    expect(blob.type).toBe("image/png");
  });

  it("round-trips with blobToBase64", async () => {
    const original = "Hello, World!";
    const b64 = btoa(original);
    const blob = base64ToBlob(b64, "text/plain");
    const text = await blob.text();
    expect(text).toBe(original);
  });
});
