import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfluenceApi, type ConfluencePageRaw } from "@/lib/confluence-api";
import type * as SettingsModule from "@/lib/settings";
import { buildSubtreeSnapshot } from "@/lib/snapshot-walker";
import {
  ensureChildren,
  getLoadingIds,
  subscribe,
  type HostCache,
} from "@/lib/tree-cache";

const storageMocks = vi.hoisted(() => ({
  get: vi.fn(async () => ({})),
  set: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
}));
vi.mock("@/lib/browser", () => ({ storage: { local: storageMocks } }));
vi.mock("@/lib/settings", async (importOriginal) => {
  const original = await importOriginal<typeof SettingsModule>();
  return {
    ...original,
    loadSettings: vi.fn(async () => ({
      ...original.DEFAULT_SETTINGS,
      maxRetries: 0,
      requestTimeout: 1_000,
    })),
  };
});

const fetchMock = vi.fn<typeof fetch>();
const response = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const page = (id: string): ConfluencePageRaw & { childTypes: { page: { value: boolean } } } => ({
  id,
  title: `Lorem ${id}`,
  type: "page",
  status: "current",
  version: { number: 1 },
  childTypes: { page: { value: false } },
});
const children = (count: number) => Array.from({ length: count }, (_, i) => page(String(20_000 + i)));
let sourceId = 0;
const nextHost = () => `https://collection-${++sourceId}.example.com`;

type Consumer = "direct API" | "tree cache" | "watch snapshot";
async function readChildren(consumer: Consumer, api: ConfluenceApi): Promise<string[]> {
  if (consumer === "direct API") return (await api.getChildren("1000")).map((item) => item.id);
  if (consumer === "watch snapshot") {
    const { snapshot } = await buildSubtreeSnapshot(api, "1000", { maxDepth: 1 });
    return Object.keys(snapshot).filter((id) => id !== "1000");
  }
  let cache: HostCache = {};
  const unsubscribe = subscribe(api.host, (next) => { cache = next; });
  try {
    await ensureChildren(api.host, "1000");
    return cache["1000"].childrenIds;
  } finally {
    unsubscribe();
  }
}

function serveChildren(items: ConfluencePageRaw[], batchSize = 100): URL[] {
  const requests: URL[] = [];
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/api/content/1000") return response(page("1000"));
    requests.push(url);
    if (requests.length > 200) throw new Error("Bounded collection fixture exceeded 200 requests");
    const start = Number(url.searchParams.get("start"));
    const results = items.slice(start, start + batchSize);
    return response({ results, start, size: results.length, _links: { next: "https://ignored.example.com/next" } });
  });
  return requests;
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  storageMocks.get.mockClear();
  storageMocks.set.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("complete Confluence space discovery", () => {
  it("collects more than 200 pages through short batches until an empty response", async () => {
    const items = children(217);
    const requests: URL[] = [];
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      const start = Number(url.searchParams.get("start"));
      return response({ results: items.slice(start, start + 73), start });
    });
    const api = new ConfluenceApi(nextHost(), { maxRetries: 0 });

    const result = await api.getSpacePages("LOREM");

    expect(result.map((item) => item.id)).toEqual(items.map((item) => item.id));
    expect(requests.map((url) => url.searchParams.get("start"))).toEqual(["0", "73", "146", "217"]);
    expect(requests.every((url) => url.pathname === "/rest/api/space/LOREM/content/page")).toBe(true);
  });

  it("escapes quoted/backslash CQL literals on content/search and filters every batch by prefix", async () => {
    const requests: URL[] = [];
    const items = [page("20000"), { ...page("20001"), title: "Other specimen" }, page("20002")];
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      const start = Number(url.searchParams.get("start"));
      return response({ results: items.slice(start, start + 1), start });
    });
    const api = new ConfluenceApi(nextHost(), { maxRetries: 0 });

    const result = await api.getSpacePages('LO"R\\EM', { label: 'lo"rem\\tag', prefix: "Lorem" });

    expect(result.map((item) => item.id)).toEqual(["20000", "20002"]);
    expect(requests).toHaveLength(4);
    for (const url of requests) {
      expect(url.pathname).toBe("/rest/api/content/search");
      expect(url.searchParams.get("cql")).toBe(String.raw`space="LO\"R\\EM" and type=page and label="lo\"rem\\tag"`);
    }
  });

  it.each(["repeated IDs", "nonadvancing offset"])("rejects %s instead of reporting a complete space", async (failure) => {
    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls += 1;
      if (calls > 2) return response({ results: [], start: 2 });
      return response({ results: [page(failure === "repeated IDs" ? "20000" : String(20_000 + calls))], start: 0 });
    });
    const api = new ConfluenceApi(nextHost(), { maxRetries: 0 });
    await expect(api.getSpacePages("LOREM")).rejects.toThrow(/pagination/i);
    expect(calls).toBe(2);
  });
});

for (const consumer of ["direct API", "tree cache", "watch snapshot"] as const) {
  describe(`${consumer} complete child discovery`, () => {
    it("includes the 6001st child and requests the terminating empty batch", async () => {
      const items = children(6_001);
      const requests = serveChildren(items);
      const api = new ConfluenceApi(nextHost(), { maxRetries: 0 });

      expect(await readChildren(consumer, api)).toEqual(items.map((item) => item.id));
      expect(requests.at(-1)?.searchParams.get("start")).toBe("6001");
      if (consumer !== "direct API") {
        const expand = consumer === "tree cache" ? "childTypes.page" : "version,version.by";
        expect(requests.every((url) => url.searchParams.get("expand") === expand)).toBe(true);
      }
    });

    it("does not interpret a short nonempty server batch as the end", async () => {
      const items = children(75);
      const requests = serveChildren(items, 37);
      const api = new ConfluenceApi(nextHost(), { maxRetries: 0 });

      expect(await readChildren(consumer, api)).toEqual(items.map((item) => item.id));
      expect(requests.map((url) => url.searchParams.get("start"))).toEqual(["0", "37", "74", "75"]);
    });

    it.each(["repeated IDs", "nonadvancing offset"])("rejects %s without committing a complete result", async (failure) => {
      const items = children(200);
      let calls = 0;
      fetchMock.mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/content/1000") return response(page("1000"));
        const start = Number(url.searchParams.get("start"));
        calls += 1;
        if (start >= 200) return response({ results: [], start });
        return response({
          results: items.slice(failure === "repeated IDs" ? 0 : start, (failure === "repeated IDs" ? 0 : start) + 100),
          start: 0,
        });
      });
      const api = new ConfluenceApi(nextHost(), { maxRetries: 0 });
      let cache: HostCache = {};
      const unsubscribe = subscribe(api.host, (next) => { cache = next; });
      try {
        await expect(readChildren(consumer, api)).rejects.toThrow(/pagination/i);
        expect(calls).toBe(2);
        if (consumer === "tree cache") {
          expect(cache["1000"]?.childrenLoaded ?? false).toBe(false);
          expect(getLoadingIds(api.host).size).toBe(0);
          await vi.advanceTimersByTimeAsync(200);
          expect(storageMocks.set).not.toHaveBeenCalled();
        }
      } finally {
        unsubscribe();
      }
    });
  });
}
