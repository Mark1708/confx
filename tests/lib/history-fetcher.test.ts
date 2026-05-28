import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchHistory } from "../../src/lib/history-fetcher";
import type { ConfluenceApi } from "../../src/lib/confluence-api";

function createMockApi(overrides: Partial<ConfluenceApi> = {}): ConfluenceApi {
  return {
    fetchJson: vi.fn().mockResolvedValue({ results: [] }),
    ...overrides,
  } as unknown as ConfluenceApi;
}

function makeVersionRaw(overrides: Record<string, unknown> = {}) {
  return {
    number: 1,
    by: { displayName: "Alice" },
    when: "2025-01-15T10:30:00Z",
    message: "Initial version",
    ...overrides,
  };
}

describe("fetchHistory", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches and maps version history from API", async () => {
    const api = createMockApi({
      fetchJson: vi.fn().mockResolvedValue({
        results: [
          makeVersionRaw(),
          makeVersionRaw({
            number: 2,
            by: { displayName: "Bob" },
            when: "2025-02-01T12:00:00Z",
            message: "Updated section",
          }),
        ],
      }),
    });

    const history = await fetchHistory("123", api);

    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({
      number: 1,
      author: "Alice",
      date: "2025-01-15T10:30:00Z",
      message: "Initial version",
    });
    expect(history[1]).toEqual({
      number: 2,
      author: "Bob",
      date: "2025-02-01T12:00:00Z",
      message: "Updated section",
    });
  });

  it("calls correct API endpoint", async () => {
    const fetchJson = vi.fn().mockResolvedValue({ results: [] });
    const api = createMockApi({ fetchJson });

    await fetchHistory("789", api);

    expect(fetchJson).toHaveBeenCalledOnce();
    expect(fetchJson).toHaveBeenCalledWith(
      "/rest/api/content/789/version?limit=50",
      undefined,
    );
  });

  it("passes abort signal to API", async () => {
    const fetchJson = vi.fn().mockResolvedValue({ results: [] });
    const api = createMockApi({ fetchJson });
    const controller = new AbortController();

    await fetchHistory("123", api, controller.signal);

    expect(fetchJson).toHaveBeenCalledWith(
      expect.any(String),
      controller.signal,
    );
  });

  it("handles missing author gracefully", async () => {
    const api = createMockApi({
      fetchJson: vi.fn().mockResolvedValue({
        results: [makeVersionRaw({ by: {} })],
      }),
    });

    const history = await fetchHistory("123", api);

    expect(history[0].author).toBe("Unknown");
  });

  it("handles missing when gracefully", async () => {
    const api = createMockApi({
      fetchJson: vi.fn().mockResolvedValue({
        results: [makeVersionRaw({ when: undefined })],
      }),
    });

    const history = await fetchHistory("123", api);

    expect(history[0].date).toBe("");
  });

  it("handles missing message gracefully", async () => {
    const api = createMockApi({
      fetchJson: vi.fn().mockResolvedValue({
        results: [makeVersionRaw({ message: undefined })],
      }),
    });

    const history = await fetchHistory("123", api);

    expect(history[0].message).toBeUndefined();
  });

  it("returns empty array when no versions", async () => {
    const api = createMockApi({
      fetchJson: vi.fn().mockResolvedValue({ results: [] }),
    });

    const history = await fetchHistory("123", api);

    expect(history).toEqual([]);
  });

  it("preserves version numbers from API", async () => {
    const api = createMockApi({
      fetchJson: vi.fn().mockResolvedValue({
        results: [
          makeVersionRaw({ number: 5 }),
          makeVersionRaw({ number: 4 }),
          makeVersionRaw({ number: 3 }),
        ],
      }),
    });

    const history = await fetchHistory("123", api);

    expect(history.map((v) => v.number)).toEqual([5, 4, 3]);
  });
});
