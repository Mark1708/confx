import { beforeEach, describe, expect, it, vi } from "vitest";

import { commentsToMarkdown, fetchComments } from "../../src/lib/comment-fetcher";
import type { ConfluenceApi } from "../../src/lib/confluence-api";
import type { ExtractedComment } from "../../src/types";

function createMockApi(overrides: Partial<ConfluenceApi> = {}): ConfluenceApi {
  return {
    fetchJson: vi.fn().mockResolvedValue({ results: [] }),
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

    expect(comments).toHaveLength(2);
    expect(comments[0]).toMatchObject({
      id: "c1",
      author: "Alice",
      createdAt: "2025-01-15T10:30:00Z",
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

  it("passes abort signal to API", async () => {
    const fetchJson = vi.fn().mockResolvedValue({ results: [] });
    const api = createMockApi({ fetchJson });
    const controller = new AbortController();

    await fetchComments("123", api, controller.signal);

    expect(fetchJson).toHaveBeenCalledWith(
      expect.any(String),
      controller.signal,
    );
  });

  it("handles missing author gracefully", async () => {
    const api = createMockApi({
      fetchJson: vi.fn().mockResolvedValue({
        results: [
          makeCommentRaw({ version: { by: {}, when: "2025-01-01T00:00:00Z" } }),
        ],
      }),
    });

    const comments = await fetchComments("123", api);

    expect(comments[0].author).toBe("Unknown");
  });

  it("handles missing body gracefully", async () => {
    const api = createMockApi({
      fetchJson: vi.fn().mockResolvedValue({
        results: [
          makeCommentRaw({ body: {} }),
        ],
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

describe("commentsToMarkdown", () => {
  it("returns empty string for empty array", () => {
    expect(commentsToMarkdown([])).toBe("");
  });

  it("formats single comment", () => {
    const comments: ExtractedComment[] = [
      {
        id: "c1",
        author: "Alice",
        createdAt: "2025-01-15T10:30:00Z",
        body: "<p>Nice</p>",
        markdown: "Nice",
      },
    ];

    const md = commentsToMarkdown(comments);

    expect(md).toContain("## Comments");
    expect(md).toContain("### @Alice");
    expect(md).toContain("2025-01-15T10:30:00Z");
    expect(md).toContain("Nice");
  });

  it("formats multiple comments separated by blank lines", () => {
    const comments: ExtractedComment[] = [
      {
        id: "c1",
        author: "Alice",
        createdAt: "2025-01-15T10:30:00Z",
        body: "",
        markdown: "First",
      },
      {
        id: "c2",
        author: "Bob",
        createdAt: "2025-02-01T12:00:00Z",
        body: "",
        markdown: "Second",
      },
    ];

    const md = commentsToMarkdown(comments);

    expect(md).toContain("### @Alice");
    expect(md).toContain("### @Bob");
    expect(md).toContain("First");
    expect(md).toContain("Second");
  });

  it("starts with horizontal rule separator", () => {
    const comments: ExtractedComment[] = [
      { id: "c1", author: "A", createdAt: "", body: "", markdown: "x" },
    ];

    const md = commentsToMarkdown(comments);

    expect(md).toMatch(/^\n---\n\n## Comments/);
  });
});
