import { ApiError, AuthError, NetworkError, RateLimitError } from "@/types";

export interface FetchOptions {
  timeout?: number;
  maxRetries?: number;
  maxConcurrency?: number;
}

type FetchBodyKind = "json" | "blob";
interface QueuedPermit {
  grant(): void;
}

export const DEFAULT_REQUEST_TIMEOUT = 30_000;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_MAX_CONCURRENCY = 5;
export const RETRY_BASE_DELAY_MS = 1_000;
export const RETRY_JITTER_MS = 100;
export const TRANSIENT_STATUS_CODES = new Set([429, 502, 503, 504]);

export function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
  if (ms <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal?.removeEventListener("abort", abort);
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = (): void => {
      clearTimeout(timeoutId);
      cleanup();
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function createRequestInit(init: RequestInit, signal?: AbortSignal): RequestInit {
  if (!signal) return init;

  const withSignal: RequestInit = { ...init };
  Object.defineProperty(withSignal, "signal", {
    value: signal,
    enumerable: false,
    configurable: true,
  });
  return withSignal;
}

export function parseRateLimitReset(headers: Headers): number | null {
  const raw = headers.get("X-RateLimit-Reset");
  if (!raw) return null;

  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? numeric : numeric * 1_000;

  const parsedDate = Date.parse(raw);
  return Number.isFinite(parsedDate) ? parsedDate : null;
}

export function isAbortError(error: unknown): boolean {
  return hasErrorName(error, "AbortError");
}

function hasErrorName(error: unknown, name: string): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === name;
}

export function isTransientStatus(status: number): boolean {
  return TRANSIENT_STATUS_CODES.has(status);
}

class Semaphore {
  private active = 0;

  private readonly queue: QueuedPermit[] = [];

  constructor(private readonly limit: number) {}

  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active < this.limit && this.queue.length === 0) {
      this.active += 1;
      return () => this.release();
    }

    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        const index = this.queue.indexOf(permit);
        if (index !== -1) this.queue.splice(index, 1);
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      const permit: QueuedPermit = {
        grant: () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
      };
      this.queue.push(permit);
      signal.addEventListener("abort", abort, { once: true });
    });
    // release() reserves the active permit for this waiter before waking it.
    return () => this.release();
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next.grant();
    else this.active -= 1;
  }
}

export abstract class HttpClient {
  private readonly timeout: number;

  private readonly maxRetries: number;

  private readonly semaphore: Semaphore;

  private rateLimitResetAt = 0;

  protected constructor(
    private readonly apiName: string,
    options: FetchOptions = {},
  ) {
    this.timeout = options.timeout ?? DEFAULT_REQUEST_TIMEOUT;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.semaphore = new Semaphore(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
  }

  abstract get host(): string;

  abstract url(path: string): string;

  async fetchJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.requestWithPolicy<T>(
      path,
      "json",
      this.createBaseInit("json"),
      this.maxRetries,
      signal,
    );
  }

  async fetchBlob(path: string, signal?: AbortSignal): Promise<Blob> {
    return this.requestWithPolicy<Blob>(
      path,
      "blob",
      this.createBaseInit("blob"),
      this.maxRetries,
      signal,
    );
  }

  protected async requestJson<T>(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<T> {
    // Conversions use POST; even a read-only conversion must never be replayed.
    return this.requestWithPolicy<T>(path, "json", this.createMutationInit(init), 0, signal);
  }

  private async requestWithPolicy<T>(
    path: string,
    bodyKind: FetchBodyKind,
    init: RequestInit,
    maxRetries: number,
    signal?: AbortSignal,
  ): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const externalAbort = (): void =>
        controller.abort(new DOMException("The operation was aborted.", "AbortError"));
      const timeoutId = setTimeout(
        () => controller.abort(new DOMException(`Request timed out @ ${path}`, "TimeoutError")),
        this.timeout,
      );
      if (signal?.aborted) externalAbort();
      else signal?.addEventListener("abort", externalAbort, { once: true });

      let release: (() => void) | undefined;
      let response: Response | undefined;
      let retryHeaders: Headers | undefined;
      try {
        release = await this.semaphore.acquire(controller.signal);
        await this.waitForRateLimit(controller.signal);
        controller.signal.throwIfAborted();
        response = await fetch(this.url(path), createRequestInit(init, controller.signal));
        controller.signal.throwIfAborted();
        this.trackRateLimit(response.headers);

        if (response.ok) {
          const value = bodyKind === "json" ? await response.json() : await response.blob();
          controller.signal.throwIfAborted();
          return value as T;
        }
        if (!isTransientStatus(response.status) || attempt === maxRetries) {
          throw this.createApiError(path, bodyKind, response, this.apiName);
        }
        retryHeaders = response.headers;
      } catch (error: unknown) {
        // Native body readers may throw AbortError for both cases. Keep timeouts
        // distinguishable from a user's cancellation, including during queueing.
        if (controller.signal.aborted) throw controller.signal.reason;
        if (
          error instanceof ApiError ||
          isAbortError(error) ||
          hasErrorName(error, "SyntaxError")
        ) {
          throw error;
        }
        if (attempt === maxRetries) {
          throw new NetworkError(`Network error @ ${path}`, path, error);
        }
      } finally {
        try {
          // Status failures have an unread body. A native in-progress body is
          // interrupted by the same controller that owns fetch and its reader.
          if (response && !response.bodyUsed) await response.body?.cancel().catch(() => undefined);
        } finally {
          clearTimeout(timeoutId);
          signal?.removeEventListener("abort", externalAbort);
          release?.();
        }
      }
      controller.signal.throwIfAborted();
      await this.waitBeforeRetry(attempt, retryHeaders, signal);
    }
    throw new NetworkError(`Network error @ ${path}`, path);
  }

  private createBaseInit(bodyKind: FetchBodyKind): RequestInit {
    return bodyKind === "json"
      ? { credentials: "include", headers: { Accept: "application/json" } }
      : { credentials: "include" };
  }

  private createMutationInit(init: RequestInit): RequestInit {
    const headers: Record<string, string> = {};
    if (init.headers instanceof Headers) {
      for (const [key, value] of init.headers.entries()) headers[key] = value;
    } else if (Array.isArray(init.headers)) {
      for (const [key, value] of init.headers) headers[key] = value;
    } else if (init.headers) {
      Object.assign(headers, init.headers);
    }
    if (!Object.keys(headers).some((key) => key.toLowerCase() === "accept")) {
      headers.Accept = "application/json";
    }

    return {
      ...init,
      credentials: "include",
      headers,
    };
  }

  private async waitForRateLimit(signal?: AbortSignal): Promise<void> {
    const waitMs = this.rateLimitResetAt - Date.now();
    if (waitMs > 0) await delay(waitMs, signal);
  }

  private trackRateLimit(headers: Headers): void {
    if (headers.get("X-RateLimit-Remaining") !== "0") return;
    const resetAt = parseRateLimitReset(headers);
    if (resetAt) this.rateLimitResetAt = Math.max(this.rateLimitResetAt, resetAt);
  }

  private async waitBeforeRetry(
    attempt: number,
    headers?: Headers,
    signal?: AbortSignal,
  ): Promise<void> {
    const resetAt = headers ? parseRateLimitReset(headers) : null;
    const resetDelay = resetAt ? Math.max(0, resetAt - Date.now()) : 0;
    const backoffDelay =
      RETRY_BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * RETRY_JITTER_MS);
    await delay(Math.max(resetDelay, backoffDelay), signal);
  }

  private createApiError(
    path: string,
    bodyKind: FetchBodyKind,
    res: Response,
    apiName: string,
  ): ApiError {
    const prefix = bodyKind === "json" ? apiName : "Download";
    const message = `${prefix} ${res.status} ${res.statusText} @ ${path}`;

    if (res.status === 401) return new AuthError(message, res.status, res.statusText, path);
    if (res.status === 429) return new RateLimitError(message, res.status, res.statusText, path);
    return new ApiError(message, res.status, res.statusText, path);
  }
}
