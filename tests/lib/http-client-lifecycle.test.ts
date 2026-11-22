// @vitest-environment node
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfluenceApi } from "@/lib/confluence-api";
import { delay, isAbortError } from "@/lib/http-client";

const fetchMock = vi.fn<typeof fetch>();
class BodyClient extends ConfluenceApi {
  post(signal?: AbortSignal): Promise<unknown> {
    return this.requestJson("/convert", { method: "POST", body: "{}" }, signal);
  }
}
const json = () => new Response('{"id":"1000","title":"Lorem","type":"page","status":"current"}');

function observe<T>(promise: Promise<T>) {
  const state = { settled: false, value: undefined as T | undefined, error: undefined as unknown };
  const done = promise.then(
    (value) => { state.value = value; state.settled = true; },
    (error: unknown) => { state.error = error; state.settled = true; },
  );
  return { state, done };
}

interface StalledBody {
  response: Response;
  finish(): void;
}

function stalledBody(signal?: AbortSignal | null): StalledBody {
  let closed = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const cleanup = () => signal?.removeEventListener("abort", abort);
  const abort = () => {
    if (closed) return;
    closed = true;
    cleanup();
    controller.error(signal?.reason ?? new DOMException("Aborted", "AbortError"));
  };
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel() { closed = true; cleanup(); },
  });
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return {
    response: new Response(stream),
    finish() {
      cleanup();
      if (closed) return;
      closed = true;
      controller.enqueue(new TextEncoder().encode('{"id":"1000","title":"Lorem","type":"page","status":"current"}'));
      controller.close();
    },
  };
}

describe("HttpClient queue/body/backoff lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(["json", "blob", "POST"] as const)("holds its concurrency permit while consuming a %s body", async (kind) => {
    const body = stalledBody();
    fetchMock.mockResolvedValueOnce(body.response).mockImplementation(async () => json());
    const client = new BodyClient("https://example.com", { timeout: 1_000, maxRetries: 0, maxConcurrency: 1 });
    const first = observe(kind === "json" ? client.fetchJson("/first") : kind === "blob" ? client.fetchBlob("/first") : client.post());
    await vi.advanceTimersByTimeAsync(0);
    const next = observe(client.fetchJson("/next"));
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(first.state.settled).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      body.finish();
      await Promise.all([first.done, next.done]);
    }
    expect(next.state.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts a queued request promptly without fetching it or stealing a later FIFO permit", async () => {
    const body = stalledBody();
    fetchMock.mockResolvedValueOnce(body.response).mockImplementation(async () => json());
    const client = new BodyClient("https://example.com", { timeout: 1_000, maxRetries: 0, maxConcurrency: 1 });
    const first = observe(client.fetchJson("/first"));
    await vi.advanceTimersByTimeAsync(0);
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const queued = observe(client.fetchJson("/cancelled", controller.signal));
    const third = observe(client.fetchJson("/third"));
    const fourth = observe(client.fetchJson("/fourth"));
    try {
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(queued.state.settled).toBe(true);
      expect(queued.state.error).toMatchObject({ name: "AbortError" });
      expect(remove.mock.calls.some(([type]) => type === "abort")).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      body.finish();
      await Promise.all([first.done, queued.done, third.done, fourth.done]);
    }
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual(["/first", "/third", "/fourth"]);
  });

  it("propagates abort through a Confluence source GET body and removes the external listener", async () => {
    let body: StalledBody | undefined;
    let requestSignal: AbortSignal | null | undefined;
    fetchMock.mockImplementation(async (_input, init) => {
      requestSignal = init?.signal;
      body = stalledBody(requestSignal);
      return body.response;
    });
    const api = new ConfluenceApi("https://example.com", { maxRetries: 1, timeout: 1_000 });
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const result = observe(api.getPage("1000", ["body.view", "body.storage", "version"], controller.signal));
    try {
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(result.state.settled).toBe(true);
      expect(result.state.error).toMatchObject({ name: "AbortError" });
      expect(requestSignal?.aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(remove.mock.calls.some(([type]) => type === "abort")).toBe(true);
    } finally {
      body?.finish();
      await result.done;
    }
  });

  it.each(["source GET", "POST"] as const)("fails a stalled %s body as TimeoutError, not user cancellation, and releases capacity", async (kind) => {
    let body: StalledBody | undefined;
    fetchMock.mockImplementationOnce(async (_input, init) => {
      body = stalledBody(init?.signal);
      return body.response;
    }).mockImplementation(async () => json());
    const client = new BodyClient("https://example.com", { timeout: 25, maxRetries: kind === "POST" ? 3 : 0, maxConcurrency: 1 });
    const result = observe(kind === "POST" ? client.post() : client.getPage("1000", ["body.view"]));
    try {
      await vi.advanceTimersByTimeAsync(30);
      expect(result.state.settled).toBe(true);
      expect(result.state.error).toMatchObject({ name: "TimeoutError" });
      expect(isAbortError(result.state.error)).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await expect(client.fetchJson("/after-timeout")).resolves.toMatchObject({ id: "1000" });
    } finally {
      body?.finish();
      await result.done;
    }
  });

  it("aborts retry backoff without issuing another GET or retaining listeners/timers", async () => {
    fetchMock.mockImplementation(async () => new Response("", { status: 503 }));
    const client = new BodyClient("https://example.com", { maxRetries: 1, timeout: 2_000 });
    const controller = new AbortController();
    const result = observe(client.fetchJson("/read", controller.signal));
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await result.done;
    expect(result.state.error).toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["resolve", "abort"] as const)("removes a delay listener after %s", async (ending) => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const result = observe(delay(10, controller.signal));
    if (ending === "abort") controller.abort();
    else await vi.advanceTimersByTimeAsync(10);
    await result.done;
    const listener = add.mock.calls.find(([type]) => type === "abort")?.[1];
    expect(listener).toBeDefined();
    expect(remove).toHaveBeenCalledWith("abort", listener);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let an already-aborted zero delay succeed", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(delay(0, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("recognizes a structural cross-realm AbortError without retrying it", async () => {
    const error = { name: "AbortError", message: "Other realm aborted" };
    fetchMock.mockRejectedValue(error);
    const client = new BodyClient("https://example.com", { maxRetries: 1, timeout: 2_000 });
    const result = observe(client.fetchJson("/read"));
    await vi.advanceTimersByTimeAsync(1_001);
    await result.done;
    expect(isAbortError(error)).toBe(true);
    expect(result.state.error).toBe(error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never retries JSON syntax failures", async () => {
    fetchMock.mockImplementation(async () => new Response("{not-json"));
    const client = new BodyClient("https://example.com", { maxRetries: 1, timeout: 2_000 });
    const result = observe(client.fetchJson("/read"));
    await vi.advanceTimersByTimeAsync(1_001);
    await result.done;
    expect(result.state.error).toBeInstanceOf(SyntaxError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

it("times out an actual loopback Confluence GET after headers while the source body is stalled", async () => {
  let response: ServerResponse | undefined;
  let bodyClosed = false;
  let watchdog: NodeJS.Timeout | undefined;
  const server = createServer((_request, outgoing) => {
    response = outgoing;
    outgoing.on("close", () => { bodyClosed = true; });
    outgoing.writeHead(200, { "Content-Type": "application/json" });
    outgoing.write('{"id":"1000",');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback test address");
  // This integration exercises native fetch/body timeout against the platform clock.
  const api = new ConfluenceApi(`http://127.0.0.1:${address.port}`, { timeout: 50, maxRetries: 0 });
  const result = observe(api.getPage("1000", ["body.view", "body.storage", "version"]));
  try {
    await Promise.race([result.done, new Promise<void>((resolve) => { watchdog = setTimeout(resolve, 500); })]);
    expect(result.state.settled).toBe(true);
    expect(result.state.error).toMatchObject({ name: "TimeoutError" });
  } finally {
    clearTimeout(watchdog);
    response?.end('"title":"Lorem","type":"page","status":"current"}');
    await result.done;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}, 2_000);
