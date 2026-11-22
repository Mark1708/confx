import { webcrypto } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  commentsToJson,
  fetchCommentAttachments,
  fetchComments,
  fetchInlineComments,
} from "../../src/lib/comment-fetcher";
import type { ConfluenceApi } from "../../src/lib/confluence-api";
import { ApiError, type ExtractedComment, type ExtractedInlineComment } from "../../src/types";

function createMockApi(overrides: Partial<ConfluenceApi> = {}): ConfluenceApi {
  return {
    fetchJson: vi.fn().mockResolvedValue({ results: [] }),
    getAttachments: vi.fn().mockResolvedValue([]),
    fetchBlob: vi.fn().mockResolvedValue(new Blob(["content"])),
    ...overrides,
  } as unknown as ConfluenceApi;
}

function makeCommentRaw(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1",
    body: { view: { value: "<p>Great article!</p>" } },
    version: {
      by: { displayName: "Alice" },
      when: "2025-01-15T10:30:00Z",
    },
    ...overrides,
  };
}

function makeInlineRoot(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    authorDisplayName: "Inline Alice",
    lastModificationDate: "2025-03-01T10:00:00Z",
    body: '<p>Root <strong>body</strong></p><p class="enh-settings">{}</p>',
    originalSelection: "selected text",
    markerRef: "marker-101",
    resolveProperties: { resolved: false },
    ...overrides,
  };
}

function makeInlineReply(overrides: Record<string, unknown> = {}) {
  return {
    id: 201,
    commentId: 101,
    authorDisplayName: "Reply Bob",
    lastModificationDate: "2025-03-01T11:00:00Z",
    body: "<p>Reply body</p>",
    ...overrides,
  };
}

describe("fetchComments", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches and maps comments from API", async () => {
    const api = createMockApi({
      fetchJson: vi.fn().mockResolvedValue({
        results: [
          makeCommentRaw(),
          makeCommentRaw({
            id: "c2",
            body: { view: { value: "<p>Thanks!</p>" } },
            version: { by: { displayName: "Bob" }, when: "2025-02-01T12:00:00Z" },
          }),
        ],
      }),
    });

    const comments = await fetchComments("123", api);

    expect(comments[0]).toMatchObject({
      id: "c1",
      author: "Alice",
      createdAt: "2025-01-15T10:30:00Z",
      attachments: [],
    });
    expect(comments[0].markdown).toContain("Great article!");
    expect(comments[1]).toMatchObject({
      id: "c2",
      author: "Bob",
    });
  });

  it("calls correct API endpoint", async () => {
    const fetchJson = vi.fn().mockResolvedValue({ results: [] });
    const api = createMockApi({ fetchJson });

    await fetchComments("456", api);

    expect(fetchJson).toHaveBeenCalledOnce();
    expect(fetchJson).toHaveBeenCalledWith(
      "/rest/api/content/456/comment?expand=body.view,version",
      undefined,
    );
  });

  it("returns empty array when page comments endpoint is unsupported", async () => {
    const api = createMockApi({
      fetchJson: vi
        .fn()
        .mockRejectedValue(
          new ApiError("missing", 404, "Not Found", "/rest/api/content/123/comment"),
        ),
    });

    await expect(fetchComments("123", api)).resolves.toEqual([]);
  });

  it("passes abort signal to API", async () => {
    const fetchJson = vi.fn().mockResolvedValue({ results: [] });
    const api = createMockApi({ fetchJson });
    const controller = new AbortController();

    await fetchComments("123", api, controller.signal);

    expect(fetchJson).toHaveBeenCalledWith(expect.any(String), controller.signal);
  });

  it("handles missing author gracefully", async () => {
    const api = createMockApi({
      fetchJson: vi.fn().mockResolvedValue({
        results: [makeCommentRaw({ version: { by: {}, when: "2025-01-01T00:00:00Z" } })],
      }),
    });

    const comments = await fetchComments("123", api);

    expect(comments[0].author).toBe("Unknown");
  });

  it("handles missing body gracefully", async () => {
    const api = createMockApi({
      fetchJson: vi.fn().mockResolvedValue({
        results: [makeCommentRaw({ body: {} })],
      }),
    });

    const comments = await fetchComments("123", api);

    expect(comments[0].body).toBe("");
    expect(comments[0].markdown).toBe("");
  });

  it("returns empty array when no comments", async () => {
    const api = createMockApi({
      fetchJson: vi.fn().mockResolvedValue({ results: [] }),
    });

    const comments = await fetchComments("123", api);

    expect(comments).toEqual([]);
  });
});

describe("fetchInlineComments", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches inline roots and replies with stable reply order", async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce([
        makeInlineRoot(),
        makeInlineRoot({
          id: "102",
          authorDisplayName: undefined,
          lastModificationDate: undefined,
          body: undefined,
          originalSelection: undefined,
          markerRef: undefined,
          resolveProperties: { resolved: true },
        }),
      ])
      .mockResolvedValueOnce([
        makeInlineReply(),
        makeInlineReply({ id: 202, authorDisplayName: "Reply Carol", body: "<p>Second</p>" }),
      ])
      .mockResolvedValueOnce([]);
    const api = createMockApi({ fetchJson });

    const comments = await fetchInlineComments("page 123", api);

    expect(fetchJson).toHaveBeenNthCalledWith(
      1,
      "/rest/inlinecomments/1.0/comments?containerId=page%20123",
      undefined,
    );
    expect(fetchJson).toHaveBeenNthCalledWith(
      2,
      "/rest/inlinecomments/1.0/comments/101/replies",
      undefined,
    );
    expect(fetchJson).toHaveBeenNthCalledWith(
      3,
      "/rest/inlinecomments/1.0/comments/102/replies",
      undefined,
    );
    expect(comments).toHaveLength(2);
    expect(comments[0]).toMatchObject({
      id: "101",
      author: "Inline Alice",
      updatedAt: "2025-03-01T10:00:00Z",
      selection: "selected text",
      markerRef: "marker-101",
      status: "open",
      attachments: [],
    });
    expect(comments[0].markdown).toContain("Root **body**");
    expect(comments[0].markdown).not.toContain("enh-settings");
    expect(comments[0].replies.map((reply) => reply.id)).toEqual(["201", "202"]);
    expect(comments[0].replies.every((reply) => reply.attachments.length === 0)).toBe(true);
    expect(comments[1]).toMatchObject({
      id: "102",
      author: "Unknown",
      updatedAt: "",
      body: "",
      markdown: "",
      selection: "",
      markerRef: "",
      status: "resolved",
      attachments: [],
      replies: [],
    });
  });

  it("does not request replies when there are no inline roots", async () => {
    const fetchJson = vi.fn().mockResolvedValue([]);
    const api = createMockApi({ fetchJson });

    await expect(fetchInlineComments("123", api)).resolves.toEqual([]);

    expect(fetchJson).toHaveBeenCalledOnce();
  });

  it("skips individual inline records without an ID", async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce([makeInlineRoot({ id: undefined }), makeInlineRoot({ id: 301 })])
      .mockResolvedValueOnce([]);
    const api = createMockApi({ fetchJson });

    const comments = await fetchInlineComments("123", api);

    expect(comments.map((comment) => comment.id)).toEqual(["301"]);
    expect(fetchJson).toHaveBeenCalledTimes(2);
  });

  it("returns empty array for unsupported inline comment endpoint", async () => {
    const api = createMockApi({
      fetchJson: vi.fn().mockRejectedValue(new ApiError("missing", 404, "Not Found", "/inline")),
    });

    await expect(fetchInlineComments("123", api)).resolves.toEqual([]);
  });

  it("propagates non-404 inline comment failures", async () => {
    const api = createMockApi({
      fetchJson: vi.fn().mockRejectedValue(new ApiError("forbidden", 403, "Forbidden", "/inline")),
    });

    await expect(fetchInlineComments("123", api)).rejects.toMatchObject({ status: 403 });
  });

  it("rejects non-array inline endpoint responses", async () => {
    const api = createMockApi({ fetchJson: vi.fn().mockResolvedValue({ results: {} }) });

    await expect(fetchInlineComments("123", api)).rejects.toThrow(/inline comments/i);
  });
});

describe("fetchCommentAttachments", () => {
  beforeAll(() => {
    vi.stubGlobal("crypto", webcrypto);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("enriches footer, inline root, and reply attachments without cross-owner deduplication", async () => {
    const comments: ExtractedComment[] = [
      {
        id: "footer 1",
        author: "Alice",
        createdAt: "2025-01-15T10:30:00Z",
        body: "<p>Footer</p>",
        markdown: "Footer",
        attachments: [],
      },
    ];
    const inlineComments: ExtractedInlineComment[] = [
      {
        id: "inline/1",
        author: "Inline Alice",
        updatedAt: "2025-03-01T10:00:00Z",
        body: "<p>Inline</p>",
        markdown: "Inline",
        attachments: [],
        selection: "selected text",
        markerRef: "marker-i1",
        status: "open",
        replies: [
          {
            id: "reply-1",
            author: "Reply Bob",
            updatedAt: "2025-03-01T11:00:00Z",
            body: "<p>Reply</p>",
            markdown: "Reply",
            attachments: [],
          },
        ],
      },
    ];
    const getAttachments = vi.fn(async (contentId: string) => [
      {
        id: `attachment-${contentId}`,
        title: contentId === "inline/1" ? "diagram.png" : "report.pdf",
        mediaType: contentId === "inline/1" ? "image/png" : "application/pdf",
        fileSize: 4,
        downloadPath: `/download/${encodeURIComponent(contentId)}`,
        containerId: contentId,
      },
    ]);
    const api = createMockApi({
      getAttachments,
      fetchBlob: vi.fn().mockResolvedValue(new Blob(["same"])),
    });

    const result = await fetchCommentAttachments(comments, inlineComments, api, {
      pageId: "page-1",
    });

    expect(comments[0].attachments).toEqual([]);
    expect(inlineComments[0].attachments).toEqual([]);
    expect(result.comments[0].attachments[0].archivePath).toBe(
      "attachments/comments/footer%201/report.pdf",
    );
    expect(result.inlineComments[0].attachments[0].archivePath).toBe(
      "attachments/comments/inline%2F1/diagram.png",
    );
    expect(result.inlineComments[0].replies[0].attachments[0].archivePath).toBe(
      "attachments/comments/reply-1/report.pdf",
    );
    expect(result.attachments.map((attachment) => attachment.archivePath)).toEqual([
      "attachments/comments/footer%201/report.pdf",
      "attachments/comments/inline%2F1/diagram.png",
      "attachments/comments/reply-1/report.pdf",
    ]);
    expect(getAttachments).toHaveBeenCalledTimes(3);
    expect(result.outcome).toEqual({
      listed: 3,
      eligible: 3,
      archived: 3,
      skippedSize: 0,
      failedDownloads: 0,
    });
    expect(result.failures).toEqual([]);
  });
});

describe("commentsToJson", () => {
  it("always serializes both root collections", () => {
    expect(JSON.parse(commentsToJson([], []))).toEqual({
      comments: [],
      inlineComments: [],
    });
  });

  it("preserves HTML, Markdown, attachment references, and inline replies", () => {
    const comments: ExtractedComment[] = [
      {
        id: "c1",
        author: "Alice",
        createdAt: "2025-01-15T10:30:00Z",
        body: "<p>Nice</p>",
        markdown: "Nice",
        attachments: [
          {
            sourceUrl: "/download/report",
            archivePath: "attachments/comments/c1/report.pdf",
            fileName: "report.pdf",
            mediaType: "application/pdf",
            fileSize: 4,
          },
        ],
      },
    ];
    const inlineComments: ExtractedInlineComment[] = [
      {
        id: "i1",
        author: "Inline Alice",
        updatedAt: "2025-03-01T10:00:00Z",
        body: "<p>Inline</p>",
        markdown: "Inline",
        attachments: [],
        selection: "selected text",
        markerRef: "marker-i1",
        status: "open",
        replies: [
          {
            id: "r1",
            author: "Reply Bob",
            updatedAt: "2025-03-01T11:00:00Z",
            body: "<p>Reply</p>",
            markdown: "Reply",
            attachments: [],
          },
        ],
      },
    ];

    const result = JSON.parse(commentsToJson(comments, inlineComments));

    expect(result.comments[0]).toMatchObject({
      body: "<p>Nice</p>",
      markdown: "Nice",
      attachments: [{ zipPath: "attachments/comments/c1/report.pdf" }],
    });
    expect(result.inlineComments[0].replies[0]).toMatchObject({
      id: "r1",
      body: "<p>Reply</p>",
      markdown: "Reply",
      attachments: [],
    });
  });
});
