import { webcrypto } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchAttachments } from "../../src/lib/attachment-fetcher";
import type { ConfluenceApi } from "../../src/lib/confluence-api";
import { AssetRegistry } from "../../src/lib/export/asset-registry";
import { ApiError, type AttachmentInfo } from "../../src/types";

function createMockApi(overrides: Partial<ConfluenceApi> = {}): ConfluenceApi {
  return {
    getAttachments: vi.fn().mockResolvedValue([]),
    fetchBlob: vi.fn().mockResolvedValue(new Blob(["content"])),
    ...overrides,
  } as unknown as ConfluenceApi;
}

function makeAttachment(overrides: Partial<AttachmentInfo> = {}): AttachmentInfo {
  return {
    id: "1",
    title: "report.pdf",
    mediaType: "application/pdf",
    fileSize: 1024,
    downloadPath: "/download/att1",
    containerId: "p1",
    ...overrides,
  };
}

async function sha256Hex(blob: Blob): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new Uint8Array(await blob.arrayBuffer()));
  return Array.from(new Uint8Array(h))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("fetchAttachments", () => {
  beforeAll(() => {
    vi.stubGlobal("crypto", webcrypto);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("downloads non-image attachment", async () => {
    const blob = new Blob(["PDF content"], { type: "application/pdf" });
    const api = createMockApi({
      getAttachments: vi.fn().mockResolvedValue([makeAttachment()]),
      fetchBlob: vi.fn().mockResolvedValue(blob),
    });

    const result = await fetchAttachments("p1", api, { folder: "attachments" });

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({
      sourceUrl: "/download/att1",
      archivePath: "attachments/report.pdf",
      fileName: "report.pdf",
      mediaType: "application/pdf",
      fileSize: 1024,
    });
    expect(result.attachments[0].hash).toBe(await sha256Hex(blob));
    expect(result.linkToArchive.get("/download/att1")).toBe("attachments/report.pdf");
    expect(result.references).toEqual([
      {
        sourceUrl: "/download/att1",
        archivePath: "attachments/report.pdf",
        fileName: "report.pdf",
        mediaType: "application/pdf",
        fileSize: 1024,
      },
    ]);
    expect(result.outcome).toEqual({
      listed: 1,
      eligible: 1,
      archived: 1,
      skippedSize: 0,
      failedDownloads: 0,
    });
    expect(result.failures).toEqual([]);
  });

  it("skips image attachments", async () => {
    const api = createMockApi({
      getAttachments: vi.fn().mockResolvedValue([
        makeAttachment({
          id: "img1",
          title: "photo.png",
          mediaType: "image/png",
          downloadPath: "/download/photo",
        }),
        makeAttachment({ id: "doc1", title: "doc.pdf", downloadPath: "/download/doc" }),
      ]),
    });

    const result = await fetchAttachments("p1", api, { folder: "attachments" });

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].fileName).toBe("doc.pdf");
    expect(result.linkToArchive.has("/download/photo")).toBe(false);
  });

  it("includes image attachments only when requested", async () => {
    const api = createMockApi({
      getAttachments: vi.fn().mockResolvedValue([
        makeAttachment({
          id: "img1",
          title: "photo.png",
          mediaType: "image/png",
          downloadPath: "/download/photo",
        }),
      ]),
    });

    const result = await fetchAttachments("comment-1", api, {
      folder: "attachments/comments/comment-1",
      includeImages: true,
    });

    expect(result.attachments).toHaveLength(1);
    expect(result.references[0]).toMatchObject({
      sourceUrl: "/download/photo",
      archivePath: "attachments/comments/comment-1/photo.png",
      mediaType: "image/png",
    });
  });

  it("respects size limit", async () => {
    const api = createMockApi({
      getAttachments: vi.fn().mockResolvedValue([makeAttachment({ fileSize: 200 * 1024 * 1024 })]),
    });

    const result = await fetchAttachments("p1", api, {
      folder: "attachments",
      maxSize: 50 * 1024 * 1024,
    });

    expect(result.attachments).toEqual([]);
    expect(api.fetchBlob).not.toHaveBeenCalled();
    expect(result.linkToArchive.has("/download/att1")).toBe(false);
    expect(result.references).toEqual([
      expect.objectContaining({
        sourceUrl: "/download/att1",
        skipped: true,
        skipReason: "exceeds size limit",
      }),
    ]);
    expect(result.references[0]).not.toHaveProperty("archivePath");
    expect(result.outcome).toMatchObject({
      listed: 1,
      eligible: 1,
      archived: 0,
      skippedSize: 1,
      failedDownloads: 0,
    });
  });

  it("deduplicates across pages", async () => {
    const assets = new AssetRegistry(true);
    const firstPage = assets.beginPage("first");
    const blob = new Blob(["same PDF content"], { type: "application/pdf" });
    const firstApi = createMockApi({
      getAttachments: vi.fn().mockResolvedValue([makeAttachment()]),
      fetchBlob: vi.fn().mockResolvedValue(blob),
    });
    const secondApi = createMockApi({
      getAttachments: vi
        .fn()
        .mockResolvedValue([makeAttachment({ id: "2", downloadPath: "/download/att2" })]),
      fetchBlob: vi.fn().mockResolvedValue(blob),
    });

    const first = await fetchAttachments("p1", firstApi, {
      folder: "first/attachments",
      assets: firstPage,
    });
    firstPage.commit();
    const second = await fetchAttachments("p2", secondApi, {
      folder: "second/attachments",
      assets: assets.beginPage("second"),
    });

    expect(first.attachments).toHaveLength(1);
    expect(first.attachments[0].archivePath).toBe("first/attachments/report.pdf");
    expect(second.attachments).toEqual([]);
    expect(second.linkToArchive.get("/download/att2")).toBe("first/attachments/report.pdf");
    expect(second.references).toEqual([
      expect.objectContaining({
        sourceUrl: "/download/att2",
        archivePath: "first/attachments/report.pdf",
      }),
    ]);
  });

  it("respects abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const api = createMockApi({
      getAttachments: vi.fn().mockResolvedValue([makeAttachment()]),
    });

    await expect(
      fetchAttachments("p1", api, {
        folder: "attachments",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(api.getAttachments).not.toHaveBeenCalled();
    expect(api.fetchBlob).not.toHaveBeenCalled();
  });

  it("propagates resource AbortError instead of recording an omission or fetching the next file", async () => {
    const api = createMockApi({
      getAttachments: vi
        .fn()
        .mockResolvedValue([
          makeAttachment({ downloadPath: "/download/first" }),
          makeAttachment({ downloadPath: "/download/second" }),
        ]),
      fetchBlob: vi
        .fn()
        .mockRejectedValue({ name: "AbortError", message: "Cancelled in another realm" }),
    });
    await expect(fetchAttachments("p1", api, { folder: "attachments" })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(api.fetchBlob).toHaveBeenCalledOnce();
  });

  it("continues on individual errors", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const api = createMockApi({
      getAttachments: vi
        .fn()
        .mockResolvedValue([
          makeAttachment({ id: "1", title: "broken.pdf", downloadPath: "/download/broken" }),
          makeAttachment({ id: "2", title: "ok.pdf", downloadPath: "/download/ok" }),
        ]),
      fetchBlob: vi
        .fn()
        .mockRejectedValueOnce(new Error("network failed"))
        .mockResolvedValueOnce(new Blob(["ok content"])),
    });

    const result = await fetchAttachments("p1", api, { folder: "attachments" });

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].fileName).toBe("ok.pdf");
    expect(result.linkToArchive.has("/download/broken")).toBe(false);
    expect(result.linkToArchive.get("/download/ok")).toBe("attachments/ok.pdf");
    expect(result.outcome).toMatchObject({ archived: 1, failedDownloads: 1 });
    expect(result.failures).toEqual([
      {
        scope: "attachment",
        page_id: "p1",
        href: "/download/broken",
        reason: "attachment-download-failed",
      },
    ]);
  });

  it("does not log the attachment title, path or raw error when a download fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const api = createMockApi({
      getAttachments: vi
        .fn()
        .mockResolvedValue([
          makeAttachment({
            id: "1",
            title: "TEST_ONLY_PRIVATE_TITLE.pdf",
            downloadPath: "/download/TEST_ONLY_PATH",
          }),
        ]),
      fetchBlob: vi.fn().mockRejectedValue(new Error("TEST_ONLY_RAW_ERROR")),
    });

    const result = await fetchAttachments("p1", api, { folder: "attachments" });

    expect(result.failures).toEqual([
      {
        scope: "attachment",
        page_id: "p1",
        href: "/download/TEST_ONLY_PATH",
        reason: "attachment-download-failed",
      },
    ]);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("TEST_ONLY_PRIVATE_TITLE");
    expect(logged).not.toContain("TEST_ONLY_PATH");
    expect(logged).not.toContain("TEST_ONLY_RAW_ERROR");
    expect(logged).toContain("attachment-download-failed");
  });

  it("maps only successful downloads to their canonical archive paths", async () => {
    const api = createMockApi({
      getAttachments: vi.fn().mockResolvedValue([
        makeAttachment({ id: "1", title: "one.pdf", downloadPath: "/download/one" }),
        makeAttachment({
          id: "2",
          title: "two.txt",
          mediaType: "text/plain",
          downloadPath: "/download/two",
        }),
        makeAttachment({
          id: "3",
          title: "three.zip",
          mediaType: "application/zip",
          downloadPath: "/download/three",
        }),
      ]),
      fetchBlob: vi.fn().mockResolvedValue(new Blob(["content"])),
    });

    const result = await fetchAttachments("p1", api, { folder: "attachments" });

    expect(result.linkToArchive.size).toBe(3);
    expect(result.linkToArchive.get("/download/one")).toBe("attachments/one.pdf");
    expect(result.linkToArchive.get("/download/two")).toBe("attachments/two.txt");
    expect(result.linkToArchive.get("/download/three")).toBe("attachments/three.zip");
  });

  it("handles empty attachments", async () => {
    const api = createMockApi({ getAttachments: vi.fn().mockResolvedValue([]) });

    const result = await fetchAttachments("p1", api, { folder: "attachments" });

    expect(result.attachments).toEqual([]);
    expect(result.linkToArchive.size).toBe(0);
    expect(api.fetchBlob).not.toHaveBeenCalled();
  });

  it("treats a missing attachment container as empty without warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const api = createMockApi({
      getAttachments: vi
        .fn()
        .mockRejectedValue(
          new ApiError("missing", 404, "Not Found", "/rest/api/content/comment-1/child/attachment"),
        ),
    });

    await expect(
      fetchAttachments("comment-1", api, {
        folder: "attachments/comments/comment-1",
        optionalOwnerNotFound: true,
      }),
    ).resolves.toEqual({
      attachments: [],
      references: [],
      linkToArchive: new Map(),
      outcome: {
        listed: 0,
        eligible: 0,
        archived: 0,
        skippedSize: 0,
        failedDownloads: 0,
      },
      failures: [],
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("records a non-optional attachment list failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const api = createMockApi({
      getAttachments: vi
        .fn()
        .mockRejectedValue(
          new ApiError("forbidden", 403, "Forbidden", "/rest/api/content/p1/child/attachment"),
        ),
    });

    const result = await fetchAttachments("p1", api, { folder: "attachments" });

    expect(result.outcome).toEqual({
      listed: 0,
      eligible: 0,
      archived: 0,
      skippedSize: 0,
      failedDownloads: 0,
    });
    expect(result.failures).toEqual([
      {
        scope: "attachment",
        page_id: "p1",
        reason: "attachment-list-failed",
        status: 403,
      },
    ]);
  });

  it("uses correct extension from MIME type", async () => {
    const api = createMockApi({
      getAttachments: vi.fn().mockResolvedValue([
        makeAttachment({
          id: "docx",
          title: "Document",
          mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          downloadPath: "/download/docx",
        }),
        makeAttachment({
          id: "xlsx",
          title: "Sheet",
          mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          downloadPath: "/download/xlsx",
        }),
        makeAttachment({
          id: "pptx",
          title: "Slides",
          mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          downloadPath: "/download/pptx",
        }),
      ]),
    });

    const result = await fetchAttachments("p1", api, { folder: "attachments" });

    expect(result.attachments.map((attachment) => attachment.archivePath)).toEqual([
      "attachments/document.docx",
      "attachments/sheet.xlsx",
      "attachments/slides.pptx",
    ]);
  });

  it("falls back to filename extension", async () => {
    const api = createMockApi({
      getAttachments: vi.fn().mockResolvedValue([
        makeAttachment({
          title: "archive.data",
          mediaType: "application/octet-stream",
          downloadPath: "/download/custom",
        }),
      ]),
    });

    const result = await fetchAttachments("p1", api, { folder: "attachments" });

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].archivePath).toBe("attachments/archive.data");
  });
});
