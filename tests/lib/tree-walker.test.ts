import { describe, expect, it } from "vitest";
import type { ConfluenceApi, ConfluencePageRaw } from "@/lib/confluence-api";
import { flattenTree, walkTree } from "@/lib/tree-walker";

const page = (id: string, title = `Page ${id}`): ConfluencePageRaw =>
  ({ id, title, type: "page", status: "current" }) as ConfluencePageRaw;

interface LiveRead {
  requests: number;
  aborted: boolean;
}

/** A sibling children read that only settles after its abort-driven cleanup tail. */
function liveChildren(read: LiveRead, tail: Promise<void>) {
  return (signal?: AbortSignal): Promise<ConfluencePageRaw[]> => {
    read.requests += 1;
    const pending = Promise.withResolvers<ConfluencePageRaw[]>();
    const abort = (): void => {
      if (read.aborted) return;
      read.aborted = true;
      void tail.then(() =>
        pending.reject(new DOMException("The operation was aborted.", "AbortError")),
      );
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    return pending.promise;
  };
}

type ChildrenHandler = (signal?: AbortSignal) => Promise<ConfluencePageRaw[]>;

function apiFor(children: Record<string, ChildrenHandler>): ConfluenceApi {
  return {
    getPage: async (id: string) => page(id),
    getChildren: (id: string, _limit?: number, signal?: AbortSignal) =>
      (children[id] ?? (async () => []))(signal),
  } as unknown as ConfluenceApi;
}

function observe<T>(promise: Promise<T>) {
  const state = { settled: false, value: undefined as T | undefined, error: undefined as unknown };
  const done = promise.then(
    (value) => {
      state.value = value;
      state.settled = true;
    },
    (error: unknown) => {
      state.error = error;
      state.settled = true;
    },
  );
  return { state, done };
}

async function drain(rounds = 50): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

describe("walkTree parallel discovery", () => {
  it("walks complete batches and triggers no further reads after discovery finishes", async () => {
    const reads = { count: 0 };
    const api = apiFor({
      root: async () => [page("a"), page("b")],
      a: async () => [page("a1")],
      a1: async () => [],
      b: async () => [],
    });
    const original = api.getChildren.bind(api);
    api.getChildren = (id: string, limit?: number, signal?: AbortSignal) => {
      reads.count += 1;
      return original(id, limit, signal);
    };
    const controller = new AbortController();
    const seen: Array<{ id: string; depth: number }> = [];
    const root = await walkTree(api, "root", {
      concurrency: 2,
      signal: controller.signal,
      onPage: (node, depth) => seen.push({ id: node.id, depth }),
    });
    expect(seen.map((entry) => entry.id).sort()).toEqual(["a", "a1", "b", "root"]);
    expect(flattenTree(root)).toHaveLength(4);
    controller.abort();
    await drain();
    expect(reads.count).toBe(4);
  });

  it("stops the whole batch when the parent signal aborts mid-read", async () => {
    const controller = new AbortController();
    const tail = Promise.withResolvers<void>();
    const first: LiveRead = { requests: 0, aborted: false };
    const second: LiveRead = { requests: 0, aborted: false };
    const api = apiFor({
      root: async () => [page("a"), page("b")],
      a: liveChildren(first, tail.promise),
      b: liveChildren(second, tail.promise),
    });
    const observed = observe(walkTree(api, "root", { concurrency: 2, signal: controller.signal }));
    await drain();
    expect(first.requests + second.requests).toBe(2);
    controller.abort(new DOMException("Synthetic cancellation", "AbortError"));
    tail.resolve();
    await observed.done;
    expect(observed.state.error).toMatchObject({ name: "AbortError" });
    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(true);
    await drain();
    expect(first.requests + second.requests).toBe(2);
  });

  it("aborts sibling reads on a fatal children batch and propagates the original failure after cleanup", async () => {
    const controller = new AbortController();
    const tail = Promise.withResolvers<void>();
    const fatal = new Error("Synthetic children failure");
    const fatalRead = { requests: 0 };
    const first: LiveRead = { requests: 0, aborted: false };
    const second: LiveRead = { requests: 0, aborted: false };
    const api = apiFor({
      root: async () => [page("a"), page("b"), page("c")],
      a: () => {
        fatalRead.requests += 1;
        return Promise.reject(fatal);
      },
      b: liveChildren(first, tail.promise),
      c: liveChildren(second, tail.promise),
    });
    const seen: string[] = [];
    const observed = observe(
      walkTree(api, "root", {
        concurrency: 3,
        signal: controller.signal,
        onPage: (node) => seen.push(node.id),
      }),
    );
    await drain();
    expect(fatalRead.requests).toBe(1);
    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(true);
    expect(observed.state.settled).toBe(false);
    tail.resolve();
    await observed.done;
    expect(observed.state.error).toBe(fatal);
    // The root's own batch completed; nothing discovered by the fatal batch is reported.
    expect(seen).toEqual(["root", "a", "b", "c"]);
    await drain();
    expect(first.requests + second.requests).toBe(2);
  });
});
