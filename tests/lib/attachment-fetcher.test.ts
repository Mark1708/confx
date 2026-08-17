import { webcrypto } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchAttachments } from "../../src/lib/attachment-fetcher";
import type { ConfluenceApi } from "../../src/lib/confluence-api";
import { ImageDedup } from "../../src/lib/image-fetcher";
import type { AttachmentInfo } from "../../src/types";

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

    const result = await fetchAttachments("p1", api, "attachments");

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({
      sourceUrl: "/download/att1",
      zipPath: "attachments/report.pdf",
      fileName: "report.pdf",
      mediaType: "application/pdf",
      fileSize: 1024,
    });
    expect(result.attachments[0].hash).toBe(await sha256Hex(blob));
    expect(result.linkToZip.get("/download/att1")).toBe("attachments/report.pdf");
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

    const result = await fetchAttachments("p1", api, "attachments");

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].fileName).toBe("doc.pdf");
    expect(result.linkToZip.has("/download/photo")).toBe(false);
  });

  it("respects size limit", async () => {
    const api = createMockApi({
      getAttachments: vi.fn().mockResolvedValue([
        makeAttachment({ fileSize: 200 * 1024 * 1024 }),
      ]),
    });

    const result = await fetchAttachments("p1", api, "attachments", undefined, 50 * 1024 * 1024);

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].skipped).toBe(true);
    expect(result.attachments[0].skipReason).toBe("exceeds size limit");
    expect(api.fetchBlob).not.toHaveBeenCalled();
    expect(result.linkToZip.get("/download/att1")).toBe("attachments/report.pdf");
  });

  it("deduplicates across pages", async () => {
    const dedup = new ImageDedup();
    const blob = new Blob(["same PDF content"], { type: "application/pdf" });
    const firstApi = createMockApi({
      getAttachments: vi.fn().mockResolvedValue([makeAttachment()]),
      fetchBlob: vi.fn().mockResolvedValue(blob),
    });
    const secondApi = createMockApi({
      getAttachments: vi.fn().mockResolvedValue([
        makeAttachment({ id: "2", downloadPath: "/download/att2" }),
      ]),
      fetchBlob: vi.fn().mockResolvedValue(blob),
    });

    const first = await fetchAttachments("p1", firstApi, "first/attachments", dedup);
    const second = await fetchAttachments("p2", secondApi, "second/attachments", dedup);

    expect(first.attachments).toHaveLength(1);
    expect(first.attachments[0].zipPath).toBe("first/attachments/report.pdf");
    expect(second.attachments).toEqual([]);
    expect(second.linkToZip.get("/download/att2")).toBe("first/attachments/report.pdf");
  });

  it("respects abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const api = createMockApi({
      getAttachments: vi.fn().mockResolvedValue([makeAttachment()]),
    });

    const result = await fetchAttachments("p1", api, "attachments", undefined, undefined, controller.signal);

    expect(result.attachments).toEqual([]);
    expect(result.linkToZip.size).toBe(0);
    expect(api.fetchBlob).not.toHaveBeenCalled();
  });

  it("continues on individual errors", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const api = createMockApi({
      getAttachments: vi.fn().mockResolvedValue([
        makeAttachment({ id: "1", title: "broken.pdf", downloadPath: "/download/broken" }),
        makeAttachment({ id: "2", title: "ok.pdf", downloadPath: "/download/ok" }),
      ]),
      fetchBlob: vi
        .fn()
        .mockRejectedValueOnce(new Error("network failed"))
        .mockResolvedValueOnce(new Blob(["ok content"])),
    });

    const result = await fetchAttachments("p1", api, "attachments");

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].fileName).toBe("ok.pdf");
    expect(result.linkToZip.has("/download/broken")).toBe(false);
    expect(result.linkToZip.get("/download/ok")).toBe("attachments/ok.pdf");
  });

  it("returns correct linkToZip map", async () => {
    const api = createMockApi({
      getAttachments: vi.fn().mockResolvedValue([
        makeAttachment({ id: "1", title: "one.pdf", downloadPath: "/download/one" }),
        makeAttachment({ id: "2", title: "two.txt", mediaType: "text/plain", downloadPath: "/download/two" }),
        makeAttachment({ id: "3", title: "three.zip", mediaType: "application/zip", downloadPath: "/download/three" }),
      ]),
      fetchBlob: vi.fn().mockResolvedValue(new Blob(["content"])),
    });

    const result = await fetchAttachments("p1", api, "attachments");

    expect(result.linkToZip.size).toBe(3);
    expect(result.linkToZip.get("/download/one")).toBe("attachments/one.pdf");
    expect(result.linkToZip.get("/download/two")).toBe("attachments/two.txt");
    expect(result.linkToZip.get("/download/three")).toBe("attachments/three.zip");
  });

  it("handles empty attachments", async () => {
    const api = createMockApi({ getAttachments: vi.fn().mockResolvedValue([]) });

    const result = await fetchAttachments("p1", api, "attachments");

    expect(result.attachments).toEqual([]);
    expect(result.linkToZip.size).toBe(0);
    expect(api.fetchBlob).not.toHaveBeenCalled();
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

    const result = await fetchAttachments("p1", api, "attachments");

    expect(result.attachments.map((attachment) => attachment.zipPath)).toEqual([
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

    const result = await fetchAttachments("p1", api, "attachments");

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].zipPath).toBe("attachments/archive.data");
  });
});
