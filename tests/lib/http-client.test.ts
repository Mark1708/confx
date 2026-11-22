import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HttpClient } from "@/lib/http-client";
import { ApiError, NetworkError } from "@/types";

const fetchMock = vi.fn<typeof fetch>();

class TestClient extends HttpClient {
  constructor() {
    super("Test API", { maxRetries: 1, timeout: 25 });
  }

  get host(): string {
    return "https://example.com";
  }

  url(path: string): string {
    return `${this.host}${path}`;
  }

  read<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.fetchJson<T>(path, signal);
  }

  request<T>(path: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
    return this.requestJson<T>(path, init, signal);
  }
}

const jsonResponse = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });

describe("HttpClient requestJson", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps automatic retry for transient GET reads", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ down: true }, { status: 503, statusText: "Unavailable" }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new TestClient();

    const result = client.read<{ ok: boolean }>("/read");
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry read-only conversion status failures", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ down: true }, { status: 503, statusText: "Unavailable" }),
    );
    const client = new TestClient();

    await expect(client.request("/convert", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry read-only conversion network failures", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const client = new TestClient();

    await expect(client.request("/convert", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(
      NetworkError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("merges JSON conversion headers with include credentials", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new TestClient();

    await expect(
      client.request<{ ok: boolean }>("/convert", {
        method: "POST",
        headers: { "X-Custom": "1", "Content-Type": "application/json" },
        body: "{}",
      }),
    ).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith("https://example.com/convert", {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Custom": "1",
      },
      body: "{}",
    });
  });
});
