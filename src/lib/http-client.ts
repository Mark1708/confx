import { ApiError, AuthError, NetworkError, RateLimitError } from "@/types";

export interface FetchOptions {
  timeout?: number;
  maxRetries?: number;
  maxConcurrency?: number;
}

type FetchBodyKind = "json" | "blob";
type QueuedPermit = () => void;

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
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted)
    return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(resolve, ms);
    const abort = (): void => {
      clearTimeout(timeoutId);
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
  return error instanceof DOMException && error.name === "AbortError";
}

export function isTransientStatus(status: number): boolean {
  return TRANSIENT_STATUS_CODES.has(status);
}

class Semaphore {
  private active = 0;

  private readonly queue: QueuedPermit[] = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }

    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
    return () => this.release();
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    next?.();
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
    const res = await this.fetchWithPolicy(path, "json", signal);
    return (await res.json()) as T;
  }

  async fetchBlob(path: string, signal?: AbortSignal): Promise<Blob> {
    const res = await this.fetchWithPolicy(path, "blob", signal);
    return await res.blob();
  }

  private async fetchWithPolicy(
    path: string,
    bodyKind: FetchBodyKind,
    signal?: AbortSignal,
  ): Promise<Response> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const release = await this.semaphore.acquire();
      try {
        await this.waitForRateLimit(signal);
        const res = await this.performFetch(path, bodyKind, signal);
        this.trackRateLimit(res.headers);

        if (res.ok) return res;
        if (!isTransientStatus(res.status) || attempt === this.maxRetries) {
          throw this.createApiError(path, bodyKind, res, this.apiName);
        }

        await this.waitBeforeRetry(attempt, res.headers, signal);
      } catch (error: unknown) {
        if (error instanceof ApiError || isAbortError(error)) throw error;
        if (attempt === this.maxRetries) {
          throw new NetworkError(`Network error @ ${path}`, path, error);
        }
        await this.waitBeforeRetry(attempt, undefined, signal);
      } finally {
        release();
      }
    }

    throw new NetworkError(`Network error @ ${path}`, path);
  }

  private async performFetch(
    path: string,
    bodyKind: FetchBodyKind,
    signal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    const externalAbort = (): void => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", externalAbort, { once: true });

    try {
      const init = createRequestInit(this.createBaseInit(bodyKind), controller.signal);
      return await fetch(this.url(path), init);
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", externalAbort);
    }
  }

  private createBaseInit(bodyKind: FetchBodyKind): RequestInit {
    return bodyKind === "json"
      ? { credentials: "include", headers: { Accept: "application/json" } }
      : { credentials: "include" };
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
