import { Blob as NodeBlob } from "node:buffer";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writePageEntries } from "../../src/lib/export/package-writer";
import { collectEntries } from "../helpers/export-collector";
import type { ExtractedPage } from "../../src/types";

beforeEach(() => vi.stubGlobal("Blob", NodeBlob));
afterEach(() => vi.unstubAllGlobals());

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

async function packageArchive(
  pages: readonly ExtractedPage[],
  options: { rootName: string; readme?: string; manifestJson?: string },
): Promise<Blob> {
  const signal = new AbortController().signal;
  return collectEntries(options.rootName, async (emit) => {
    for (const page of pages) await writePageEntries(page, emit, signal);
    if (options.readme) await emit({ path: "README.md", body: options.readme });
    if (options.manifestJson) await emit({ path: "manifest.json", body: options.manifestJson });
  }, signal);
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
    plantUmlAssets: [],
    commentAttachments: [],
    comments: [],
    inlineComments: [],
    history: [],
    folder: "test-page",
    outcome: {
      attachments: {
        declared: null,
        listed: 0,
        eligible: 0,
        archived: 0,
        skippedSize: 0,
        failedDownloads: 0,
      },
      plantUml: {
        discovered: 0,
        archived: 0,
        skippedLimit: 0,
        failedDownloads: 0,
        unsupported: 0,
      },
      layout: {
        status: "none",
        sections: 0,
      },
      failures: [],
    },
    ...overrides,
  };
}

describe("sequential package writer", () => {
  it("creates ZIP with root folder + index.md for a single page", async () => {
    const pages = [makePage()];
    const blob = await packageArchive(pages, { rootName: "export" });
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
    const blob = await packageArchive(pages, { rootName: "export" });
    const entries = await extractZip(blob);

    expect(hasEntry(entries, "export/test-page/tables/data-01.csv")).toBe(true);
    expect(hasEntry(entries, "export/test-page/tables/info-02.csv")).toBe(true);
    expect(readEntry(entries, "export/test-page/tables/data-01.csv")).toBe("a,b\n1,2");
  });

  it("writes every canonical image payload without deduplicating distinct committed paths", async () => {
    const imgBlob = new Blob(["fake-png-data"], { type: "image/png" });
    const pages = [
      makePage({
        images: [
          { sourceUrl: "/img/a.png", archivePath: "test-page/images/a.png", blob: imgBlob, hash: "hash-a" },
          { sourceUrl: "/img/b.png", archivePath: "test-page/images/b.png", blob: imgBlob, hash: "hash-b" },
        ],
      }),
      makePage({
        folder: "other-page",
        images: [
          { sourceUrl: "/img/a.png", archivePath: "other-page/images/a.png", blob: imgBlob, hash: "hash-a" },
        ],
      }),
    ];
    const blob = await packageArchive(pages, { rootName: "export" });
    const entries = await extractZip(blob);

    expect(hasEntry(entries, "export/test-page/images/a.png")).toBe(true);
    expect(hasEntry(entries, "export/test-page/images/b.png")).toBe(true);
    expect(readEntry(entries, "export/other-page/images/a.png")).toBe("fake-png-data");
    const allImageFiles = Object.keys(entries).filter((f) => f.includes("images/"));
    expect(allImageFiles).toHaveLength(3);
  });

  it("includes README.md and manifest.json when provided", async () => {
    const blob = await packageArchive([], {
      rootName: "export",
      readme: "# README",
      manifestJson: '{"version":1}',
    });
    const entries = await extractZip(blob);

    expect(readEntry(entries, "export/README.md")).toBe("# README");
    expect(readEntry(entries, "export/manifest.json")).toBe('{"version":1}');
  });

  it("creates a valid empty ZIP for empty pages", async () => {
    const blob = await packageArchive([], { rootName: "export" });
    expect(await extractZip(blob)).toEqual({});
  });

  it("handles multiple pages each in own folder", async () => {
    const pages = [makePage({ folder: "page-a" }), makePage({ folder: "page-b" })];
    const blob = await packageArchive(pages, { rootName: "export" });
    const entries = await extractZip(blob);

    expect(hasEntry(entries, "export/page-a/index.md")).toBe(true);
    expect(hasEntry(entries, "export/page-b/index.md")).toBe(true);
  });

  it("writes identical PlantUML pairs beneath every page-local prefix", async () => {
    const png = new Blob(["png"], { type: "image/png" });
    const source = new Blob(["@startuml\nA -> B\n@enduml"], { type: "text/plain" });
    const diagram = {
      png: {
        archivePath: "attachments/linked/plantuml/plantuml-shared.png",
        fileName: "plantuml-shared.png",
        mediaType: "image/png",
        fileSize: png.size,
        blob: png,
        hash: "same-png-hash",
      },
      source: {
        archivePath: "attachments/linked/plantuml/plantuml-shared.puml",
        fileName: "plantuml-shared.puml",
        mediaType: "text/plain",
        fileSize: source.size,
        blob: source,
        hash: "same-source-hash",
      },
    };
    const relativePng = diagram.png.archivePath;
    const pages = [
      makePage({
        meta: { ...makePage().meta, id: "one" },
        folder: "page-one",
        markdown: `![One](${relativePng})`,
        plantUmlAssets: [{
          png: { ...diagram.png, archivePath: `page-one/${diagram.png.archivePath}` },
          source: { ...diagram.source, archivePath: `page-one/${diagram.source.archivePath}` },
        }],
      }),
      makePage({
        meta: { ...makePage().meta, id: "two" },
        folder: "page-two",
        markdown: `![Two](${relativePng})`,
        plantUmlAssets: [{
          png: { ...diagram.png, archivePath: `page-two/${diagram.png.archivePath}` },
          source: { ...diagram.source, archivePath: `page-two/${diagram.source.archivePath}` },
        }],
      }),
    ];

    const entries = await extractZip(await packageArchive(pages, { rootName: "export" }));

    for (const folder of ["page-one", "page-two"]) {
      expect(readEntry(entries, `export/${folder}/index.md`)).toContain(relativePng);
      expect(readEntry(entries, `export/${folder}/${relativePng}`)).toBe("png");
      expect(readEntry(entries, `export/${folder}/${diagram.source.archivePath}`)).toBe(
        "@startuml\nA -> B\n@enduml",
      );
    }
  });

  it("rejects a repeated final page index rather than overwriting it", async () => {
    const first = makePage({ meta: { ...makePage().meta, id: "first" }, folder: "same" });
    const second = makePage({ meta: { ...makePage().meta, id: "second" }, folder: "same" });

    await expect(packageArchive([first, second], { rootName: "export" })).rejects.toThrow(/duplicate/i);
  });

  it("round-trips a large (>1MB) pre-compressed .docx attachment byte-exact", async () => {
    // Regression guard: a large incompressible binary attachment (the exact
    // scenario that produced a corrupt deflate stream). STORE mode must
    // preserve the bytes verbatim.
    const size = 1_200_003;
    const original = deterministicBytes(size, 42);
    const blob_ = new Blob([original], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const pages = [
      makePage({
        attachments: [
          {
            sourceUrl: "/dl/arch.docx",
            archivePath: "test-page/attachments/arch.docx",
            blob: blob_,
            hash: "arch-hash",
            fileName: "Архитектура v1.1.docx",
            mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            fileSize: size,
          },
        ],
      }),
    ];
    const zipBlob = await packageArchive(pages, { rootName: "export" });
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
        images: [{ sourceUrl: "/i/d.png", archivePath: "test-page/images/d.png", blob: blob_, hash: "png-hash" }],
      }),
    ];
    const zipBlob = await packageArchive(pages, { rootName: "export" });
    const entries = await extractZip(zipBlob);

    const got = entries["export/test-page/images/d.png"];
    expect(got).toBeDefined();
    expect(Array.from(got)).toEqual(Array.from(original));
  });

  it("writes unified comments.json and every comment-owned binary", async () => {
    const replyBlob = new Blob(["reply attachment"], { type: "application/pdf" });
    const blob = await packageArchive(
      [
        makePage({
          comments: [
            {
              id: "page-comment-1",
              author: "Carol",
              createdAt: "2025-03-01T09:00:00Z",
              body: "<p>Footer</p>",
              markdown: "Footer",
              attachments: [
                {
                  sourceUrl: "/download/footer-report",
                  archivePath: "test-page/attachments/comments/page-comment-1/report.pdf",
                  fileName: "report.pdf",
                  mediaType: "application/pdf",
                  fileSize: replyBlob.size,
                },
              ],
            },
          ],
          inlineComments: [
            {
              id: "inline-1",
              author: "Alice",
              updatedAt: "2025-03-01T10:00:00Z",
              body: "<p>Inline</p>",
              markdown: "Inline",
              attachments: [],
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
                  attachments: [
                    {
                      sourceUrl: "/download/report",
                      archivePath: "test-page/attachments/comments/reply-1/report.pdf",
                      fileName: "report.pdf",
                      mediaType: "application/pdf",
                      fileSize: replyBlob.size,
                    },
                  ],
                },
              ],
            },
          ],
          commentAttachments: [
            {
              sourceUrl: "/download/footer-report",
              archivePath: "test-page/attachments/comments/page-comment-1/report.pdf",
              fileName: "report.pdf",
              mediaType: "application/pdf",
              fileSize: replyBlob.size,
              blob: replyBlob,
              hash: "same-as-another-owner-is-allowed",
            },
            {
              sourceUrl: "/download/report",
              archivePath: "test-page/attachments/comments/reply-1/report.pdf",
              fileName: "report.pdf",
              mediaType: "application/pdf",
              fileSize: replyBlob.size,
              blob: replyBlob,
              hash: "same-as-another-owner-is-allowed",
            },
          ],
        }),
        makePage({ folder: "without-comments" }),
      ],
      { rootName: "export" },
    );

    const entries = await extractZip(blob);
    const commentsJson = JSON.parse(readEntry(entries, "export/test-page/comments.json"));

    expect(commentsJson.comments[0]).toMatchObject({
      id: "page-comment-1",
      body: "<p>Footer</p>",
      markdown: "Footer",
      attachments: [{ zipPath: "attachments/comments/page-comment-1/report.pdf" }],
    });
    expect(commentsJson.inlineComments[0].selection).toBe("selected text");
    expect(commentsJson.inlineComments[0].replies[0].attachments[0].zipPath).toBe(
      "attachments/comments/reply-1/report.pdf",
    );
    expect(readEntry(entries, "export/test-page/attachments/comments/reply-1/report.pdf")).toBe(
      "reply attachment",
    );
    expect(
      readEntry(entries, "export/test-page/attachments/comments/page-comment-1/report.pdf"),
    ).toBe("reply attachment");
    expect(readEntry(entries, "export/test-page/index.md")).not.toContain(
      "<!-- confx:comments:start -->",
    );
    expect(hasEntry(entries, "export/test-page/inline-comments.json")).toBe(false);
    expect(hasEntry(entries, "export/without-comments/comments.json")).toBe(false);
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
