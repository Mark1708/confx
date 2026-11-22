import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConfluenceApi,
  type ConfluenceAttachmentRaw,
  type ConfluencePageRaw,
  extractBaseUrl,
  extractConfluenceBaseUrlFromUrl,
  extractHostFromUrl,
  extractPageIdFromUrl,
} from "@/lib/confluence-api";
import {
  type AttachmentInfo,
  AuthError,
  type ConfluencePageMeta,
  NetworkError,
  type SpaceInfo,
} from "@/types";

const fetchMock = vi.fn<typeof fetch>();

const jsonResponse = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });

const makePage = (id: string, title = `Page ${id}`): ConfluencePageRaw => ({
  id,
  title,
  type: "page",
  status: "current",
});

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("extractPageIdFromUrl", () => {
  it("returns pageId from a query parameter", () => {
    expect(
      extractPageIdFromUrl(
        "https://example.atlassian.net/wiki/pages/viewpage.action?pageId=123456&preview=/file.png",
      ),
    ).toBe("123456");
  });

  it("returns null when pageId query parameter is missing", () => {
    expect(
      extractPageIdFromUrl("https://example.atlassian.net/wiki/spaces/ABC/overview"),
    ).toBeNull();
  });

  it("returns null for invalid URLs", () => {
    expect(extractPageIdFromUrl("not a url")).toBeNull();
  });

  it("returns null for /display/SPACE/Title URLs", () => {
    expect(
      extractPageIdFromUrl("https://example.atlassian.net/wiki/display/SPACE/Page+Title"),
    ).toBeNull();
  });

  it("returns null for unrelated numeric path segments", () => {
    expect(extractPageIdFromUrl("https://example.com/blog/12345")).toBeNull();
  });
});

describe("extractBaseUrl", () => {
  it("detects Confluence Cloud /wiki base path", () => {
    expect(extractBaseUrl("https://corp.atlassian.net/wiki/spaces/DEV/pages/123")).toEqual({
      origin: "https://corp.atlassian.net",
      basePath: "/wiki",
    });
  });

  it("detects enterprise reverse proxy /confluence base path", () => {
    expect(extractBaseUrl("https://wiki.corp.ru/confluence/display/SPACE/Page")).toEqual({
      origin: "https://wiki.corp.ru",
      basePath: "/confluence",
    });
  });

  it("uses an empty base path for Confluence Server at root", () => {
    expect(extractBaseUrl("https://wiki.corp.ru/display/SPACE/Page")).toEqual({
      origin: "https://wiki.corp.ru",
      basePath: "",
    });
  });

  it("preserves a URL port", () => {
    expect(extractBaseUrl("http://localhost:8090/pages/viewpage.action?pageId=123")).toEqual({
      origin: "http://localhost:8090",
      basePath: "",
    });
  });

  it("throws for invalid URLs", () => {
    expect(() => extractBaseUrl("not a url")).toThrow();
  });
});

describe("enhanced extractPageIdFromUrl formats", () => {
  it("returns a page ID from a Cloud relative path", () => {
    expect(extractPageIdFromUrl("/wiki/spaces/DEV/pages/12345")).toBe("12345");
  });

  it("returns a page ID from a Cloud full URL", () => {
    expect(extractPageIdFromUrl("https://corp.atlassian.net/wiki/spaces/DEV/pages/12345")).toBe(
      "12345",
    );
  });

  it("keeps query parameter support", () => {
    expect(extractPageIdFromUrl("https://wiki.corp.ru/pages/viewpage.action?pageId=67890")).toBe(
      "67890",
    );
  });

  it("returns null for friendly display URLs", () => {
    expect(extractPageIdFromUrl("https://wiki.corp.ru/display/SPACE/Page+Title")).toBeNull();
  });
});

describe("extractHostFromUrl", () => {
  it("returns protocol and host for a URL with path and query", () => {
    expect(
      extractHostFromUrl("https://example.atlassian.net/wiki/pages/viewpage.action?pageId=123"),
    ).toBe("https://example.atlassian.net");
  });

  it("preserves a non-default port", () => {
    expect(extractHostFromUrl("http://localhost:8090/display/SPACE/Title")).toBe(
      "http://localhost:8090",
    );
  });

  it("handles URLs with credentials and hash fragments", () => {
    expect(extractHostFromUrl("https://user:pass@confluence.example.com/a/b#anchor")).toBe(
      "https://confluence.example.com",
    );
  });
});

describe("extractConfluenceBaseUrlFromUrl", () => {
  it("keeps /wiki for Confluence Cloud URLs", () => {
    expect(
      extractConfluenceBaseUrlFromUrl(
        "https://example.atlassian.net/wiki/spaces/ABC/pages/12345/Page",
      ),
    ).toBe("https://example.atlassian.net/wiki");
  });

  it("keeps root base for Confluence Server at origin", () => {
    expect(extractConfluenceBaseUrlFromUrl("https://wiki.example.com/display/ABC/Page")).toBe(
      "https://wiki.example.com",
    );
  });
});

describe("ConfluenceApi", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("stores the host passed to the constructor", () => {
    const api = new ConfluenceApi("https://confluence.example.com/wiki");

    expect(api.host).toBe("https://confluence.example.com/wiki");
  });

  it("fetchJson returns parsed JSON and builds URLs with normalized slash handling", async () => {
    const payload = { ok: true, value: 42 };
    fetchMock.mockResolvedValueOnce(jsonResponse(payload));
    const api = new ConfluenceApi("https://confluence.example.com/");

    await expect(api.fetchJson<typeof payload>("rest/api/content/123")).resolves.toEqual(payload);

    expect(fetchMock).toHaveBeenCalledWith("https://confluence.example.com/rest/api/content/123", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
  });

  it("fetchJson throws status and statusText on API errors", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "nope" }, { status: 404, statusText: "Not Found" }),
    );
    const api = new ConfluenceApi("https://confluence.example.com");

    await expect(api.fetchJson("/rest/api/content/missing")).rejects.toThrow(
      "Confluence API 404 Not Found @ /rest/api/content/missing",
    );
  });

  it("fetchBlob returns a Blob and uses include credentials", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("file content", { headers: { "Content-Type": "text/plain" } }),
    );
    const api = new ConfluenceApi("https://confluence.example.com/");

    const result = await api.fetchBlob("download/attachments/1/file.txt");

    expect(await result.text()).toBe("file content");
    expect(result.type).toBe("text/plain");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://confluence.example.com/download/attachments/1/file.txt",
      {
        credentials: "include",
      },
    );
  });

  it("fetchBlob preserves absolute attachment URLs", async () => {
    fetchMock.mockResolvedValueOnce(new Response("file content"));
    const api = new ConfluenceApi("https://confluence.example.com/wiki");

    await api.fetchBlob("https://cdn.example.com/wiki/download/attachments/1/file.png");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://cdn.example.com/wiki/download/attachments/1/file.png",
      {
        credentials: "include",
      },
    );
  });

  it("fetchBlob does not duplicate the detected Confluence base path", async () => {
    fetchMock.mockResolvedValueOnce(new Response("file content"));
    const api = new ConfluenceApi(
      extractBaseUrl("https://confluence.example.com/wiki/spaces/DEV/pages/123"),
    );

    await api.fetchBlob("/wiki/download/attachments/1/file.png");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://confluence.example.com/wiki/download/attachments/1/file.png",
      {
        credentials: "include",
      },
    );
  });

  it("fetchBlob throws status and statusText on download errors", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 403, statusText: "Forbidden" }));
    const api = new ConfluenceApi("https://confluence.example.com");

    await expect(api.fetchBlob("/download/attachments/1/file.txt")).rejects.toThrow(
      "Download 403 Forbidden @ /download/attachments/1/file.txt",
    );
  });

  it("getPage constructs the content URL without expand params by default", async () => {
    const page = makePage("123");
    fetchMock.mockResolvedValueOnce(jsonResponse(page));
    const api = new ConfluenceApi("https://confluence.example.com");

    await expect(api.getPage("123")).resolves.toEqual(page);

    expect(fetchMock).toHaveBeenCalledWith("https://confluence.example.com/rest/api/content/123", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
  });

  it("getPage constructs the content URL with comma-joined expand params", async () => {
    const page = makePage("123");
    fetchMock.mockResolvedValueOnce(jsonResponse(page));
    const api = new ConfluenceApi("https://confluence.example.com");

    await expect(
      api.getPage("123", ["body.storage", "version", "metadata.labels"]),
    ).resolves.toEqual(page);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://confluence.example.com/rest/api/content/123?expand=body.storage%2Cversion%2Cmetadata.labels",
      {
        credentials: "include",
        headers: { Accept: "application/json" },
      },
    );
  });

  it("getChildren collects pages across short batches and stops only at an empty response", async () => {
    const firstPage = [makePage("1"), makePage("2")];
    const secondPage = [makePage("3")];
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ results: firstPage, size: firstPage.length }))
      .mockResolvedValueOnce(jsonResponse({ results: secondPage, size: secondPage.length }))
      .mockResolvedValueOnce(jsonResponse({ results: [], size: 0 }));
    const api = new ConfluenceApi("https://confluence.example.com");

    await expect(api.getChildren("100", 2)).resolves.toEqual([...firstPage, ...secondPage]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://confluence.example.com/rest/api/content/100/child/page?limit=2&start=0",
      {
        credentials: "include",
        headers: { Accept: "application/json" },
      },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://confluence.example.com/rest/api/content/100/child/page?limit=2&start=2",
      {
        credentials: "include",
        headers: { Accept: "application/json" },
      },
    );
  });

  it("getChildren stops when Confluence returns an empty page", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [], size: 0 }));
    const api = new ConfluenceApi("https://confluence.example.com");

    await expect(api.getChildren("100", 100)).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });


  it("getAttachments maps raw attachments and keeps provided metadata", async () => {
    const rawAttachment: ConfluenceAttachmentRaw = {
      id: "att-1",
      title: "diagram.png",
      extensions: { mediaType: "image/png", fileSize: 2048 },
      _links: { download: "/download/attachments/page-1/diagram.png" },
      container: { id: "container-1" },
    };
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [rawAttachment] }));
    const api = new ConfluenceApi("https://confluence.example.com");

    const expected: AttachmentInfo[] = [
      {
        id: "att-1",
        title: "diagram.png",
        mediaType: "image/png",
        fileSize: 2048,
        downloadPath: "/download/attachments/page-1/diagram.png",
        containerId: "container-1",
      },
    ];

    await expect(api.getAttachments("100")).resolves.toEqual(expected);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://confluence.example.com/rest/api/content/100/child/attachment?limit=200&start=0",
      {
        credentials: "include",
        headers: { Accept: "application/json" },
      },
    );
  });

  it("getAttachments applies defaults for missing optional fields", async () => {
    const rawAttachment: ConfluenceAttachmentRaw = {
      id: "att-2",
      title: "unknown.bin",
    };
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [rawAttachment] }));
    const api = new ConfluenceApi("https://confluence.example.com");

    await expect(api.getAttachments("100")).resolves.toEqual([
      {
        id: "att-2",
        title: "unknown.bin",
        mediaType: "application/octet-stream",
        fileSize: 0,
        downloadPath: "",
        containerId: "100",
      },
    ]);
  });

  it("paginates attachments beyond the first 200 results", async () => {
    const first = Array.from({ length: 200 }, (_, index) => ({
      id: `att-${index}`,
      title: `file-${index}.bin`,
    }));
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ results: first }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: "att-200", title: "last.bin" }] }));
    const api = new ConfluenceApi("https://confluence.example.com");

    await expect(api.getAttachments("100")).resolves.toHaveLength(201);

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://confluence.example.com/rest/api/content/100/child/attachment?limit=200&start=200",
      expect.any(Object),
    );
  });

  it("rejects non-numeric content IDs before issuing a request", async () => {
    const api = new ConfluenceApi("https://confluence.example.com");

    await expect(api.getPage("../admin")).rejects.toThrow("Invalid Confluence content id");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("getSpace", () => {
    it("returns space info with homepage", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          key: "DOC",
          name: "Documentation",
          description: { plain: { value: "Team documentation space" } },
          homepage: { id: "home-123" },
        }),
      );
      const api = new ConfluenceApi("https://confluence.example.com");

      const expected: SpaceInfo = {
        key: "DOC",
        name: "Documentation",
        homepageId: "home-123",
        description: "Team documentation space",
      };

      await expect(api.getSpace("DOC")).resolves.toEqual(expected);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://confluence.example.com/rest/api/space/DOC?expand=description.plain,homepage",
        {
          credentials: "include",
          headers: { Accept: "application/json" },
        },
      );
    });

    it("returns space info without description", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          key: "DEV",
          name: "Development",
          homepage: { id: "home-456" },
        }),
      );
      const api = new ConfluenceApi("https://confluence.example.com");

      await expect(api.getSpace("DEV")).resolves.toEqual({
        key: "DEV",
        name: "Development",
        homepageId: "home-456",
        description: undefined,
      });
    });
  });

  it("toPageMeta maps a full raw Confluence page to metadata", () => {
    const api = new ConfluenceApi("https://confluence.example.com");
    const raw: ConfluencePageRaw = {
      id: "123",
      title: "Architecture",
      type: "page",
      status: "current",
      space: { key: "DOC" },
      version: {
        number: 7,
        when: "2026-05-27T10:00:00.000Z",
        by: { displayName: "Ada Lovelace" },
      },
      ancestors: [
        { id: "1", title: "Home" },
        { id: "2", title: "Platform" },
      ],
      children: {
        page: { results: [], size: 0 },
        attachment: { results: [], size: 3 },
      },
      metadata: { labels: { results: [{ name: "architecture" }, { name: "public" }] } },
      _links: { webui: "/display/DOC/Architecture", base: "https://ignored.example.com" },
    };

    const expected: ConfluencePageMeta = {
      id: "123",
      title: "Architecture",
      spaceKey: "DOC",
      baseUrl: "https://confluence.example.com",
      url: "https://source.example.com/page",
      version: 7,
      labels: ["architecture", "public"],
      ancestors: [
        { id: "1", title: "Home" },
        { id: "2", title: "Platform" },
      ],
      attachmentCount: 3,
    };

    expect(api.toPageMeta(raw, "https://source.example.com/page")).toEqual(expected);
  });

  it("toPageMeta handles missing optional fields and falls back to viewpage URL", () => {
    const api = new ConfluenceApi("https://confluence.example.com/");
    const raw = makePage("456", "Minimal Page");

    const meta = api.toPageMeta(raw);

    expect(meta).toEqual({
      id: "456",
      title: "Minimal Page",
      spaceKey: "",
      baseUrl: "https://confluence.example.com",
      url: "https://confluence.example.com/pages/viewpage.action?pageId=456",
      version: undefined,
      labels: undefined,
      ancestors: undefined,
      attachmentCount: undefined,
    });
  });

  describe("AbortSignal", () => {
    beforeEach(() => {
      fetchMock.mockImplementation((_input, init) => {
        if (init?.signal?.aborted) {
          return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
        }

        return Promise.resolve(jsonResponse({ ok: true }));
      });
    });

    it("fetchJson with aborted signal throws AbortError", async () => {
      const controller = new AbortController();
      controller.abort();
      const api = new ConfluenceApi("https://confluence.example.com");

      await expect(api.fetchJson("/rest/api/content/123", controller.signal)).rejects.toMatchObject(
        {
          name: "AbortError",
        },
      );
    });

    it("fetchBlob with aborted signal throws AbortError", async () => {
      const controller = new AbortController();
      controller.abort();
      const api = new ConfluenceApi("https://confluence.example.com");

      await expect(
        api.fetchBlob("/download/attachments/1/file.txt", controller.signal),
      ).rejects.toMatchObject({
        name: "AbortError",
      });
    });
  });

  describe("BaseUrl support", () => {
    it("constructs URLs from a string constructor argument", () => {
      const api = new ConfluenceApi("https://wiki.corp.ru");

      expect(api.url("/rest/api/content")).toBe("https://wiki.corp.ru/rest/api/content");
    });

    it("constructs URLs from a BaseUrl constructor argument", () => {
      const api = new ConfluenceApi({ origin: "https://corp.atlassian.net", basePath: "/wiki" });

      expect(api.url("/rest/api/content")).toBe("https://corp.atlassian.net/wiki/rest/api/content");
      expect(api.baseUrl).toEqual({ origin: "https://corp.atlassian.net", basePath: "/wiki" });
    });

    it("returns toPageMeta baseUrl as origin without basePath", () => {
      const api = new ConfluenceApi({ origin: "https://corp.atlassian.net", basePath: "/wiki" });

      expect(api.toPageMeta(makePage("789")).baseUrl).toBe("https://corp.atlassian.net");
    });
  });
});

describe("ConfluenceApi fetch policy", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries on 429 and succeeds on a later 200 response", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ message: "limited" }, { status: 429, statusText: "Too Many Requests" }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const api = new ConfluenceApi("https://confluence.example.com", { maxRetries: 1 });

    const result = api.fetchJson<{ ok: boolean }>("/rest/api/content/123");
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on 503 with exponential backoff", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ message: "down" }, { status: 503, statusText: "Unavailable" }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const api = new ConfluenceApi("https://confluence.example.com", { maxRetries: 1 });

    const result = api.fetchJson<{ ok: boolean }>("/rest/api/content/123");
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fires request timeout with AbortController", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );
    const api = new ConfluenceApi("https://confluence.example.com", { timeout: 50, maxRetries: 0 });

    const result = api.fetchJson("/rest/api/content/123").then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(50);

    expect(await result).toMatchObject({ name: "TimeoutError" });
  });

  it("respects rate limit reset headers when remaining quota is zero", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T00:00:00.000Z"));
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          { first: true },
          {
            headers: {
              "Content-Type": "application/json",
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset": String(Math.floor((Date.now() + 1_000) / 1_000)),
            },
          },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ second: true }));
    const api = new ConfluenceApi("https://confluence.example.com");

    await expect(api.fetchJson("/rest/api/content/1")).resolves.toEqual({ first: true });
    const second = api.fetchJson("/rest/api/content/2");
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toEqual({ second: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("limits concurrent requests to the configured maximum", async () => {
    const resolvers: Array<(response: Response) => void> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          resolvers.push((response) => {
            inFlight -= 1;
            resolve(response);
          });
        }),
    );
    const api = new ConfluenceApi("https://confluence.example.com", { maxConcurrency: 2 });

    const requests = Array.from({ length: 5 }, (_, index) =>
      api.fetchJson<{ index: number }>(`/rest/api/content/${index}`),
    );
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolvers[0](jsonResponse({ index: 0 }));
    resolvers[1](jsonResponse({ index: 1 }));
    await Promise.all([requests[0], requests[1]]);
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(4);

    resolvers[2](jsonResponse({ index: 2 }));
    resolvers[3](jsonResponse({ index: 3 }));
    await Promise.all([requests[2], requests[3]]);
    await flushMicrotasks();
    resolvers[4](jsonResponse({ index: 4 }));

    await expect(Promise.all(requests)).resolves.toEqual([
      { index: 0 },
      { index: 1 },
      { index: 2 },
      { index: 3 },
      { index: 4 },
    ]);
    expect(maxInFlight).toBe(2);
  });

  it("does not retry permanent 404 and 403 errors", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "missing" }, { status: 404, statusText: "Not Found" }),
    );
    const api = new ConfluenceApi("https://confluence.example.com", { maxRetries: 3 });

    await expect(api.fetchJson("/rest/api/content/missing")).rejects.toThrow(
      "Confluence API 404 Not Found @ /rest/api/content/missing",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "forbidden" }, { status: 403, statusText: "Forbidden" }),
    );
    await expect(api.fetchJson("/rest/api/content/forbidden")).rejects.toThrow(
      "Confluence API 403 Forbidden @ /rest/api/content/forbidden",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws AuthError on 401", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "unauthorized" }, { status: 401, statusText: "Unauthorized" }),
    );
    const api = new ConfluenceApi("https://confluence.example.com");

    await expect(api.fetchJson("/rest/api/content/secret")).rejects.toBeInstanceOf(AuthError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws NetworkError on fetch failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const api = new ConfluenceApi("https://confluence.example.com", { maxRetries: 0 });

    await expect(api.fetchJson("/rest/api/content/123")).rejects.toBeInstanceOf(NetworkError);
  });
});
