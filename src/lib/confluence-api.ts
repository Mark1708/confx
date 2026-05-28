import {
  ApiError,
  type AttachmentInfo,
  AuthError,
  type ConfluencePageMeta,
  NetworkError,
  RateLimitError,
  type SpaceInfo,
} from "@/types";

export interface ConfluencePageRaw {
  id: string;
  title: string;
  type: string;
  status: string;
  space?: { key: string };
  version?: {
    number: number;
    when?: string;
    by?: { displayName?: string; username?: string; userKey?: string };
  };
  ancestors?: Array<{ id: string; title: string }>;
  body?: {
    view?: { value: string; representation: string };
    storage?: { value: string; representation: string };
  };
  children?: {
    page?: { results: ConfluencePageRaw[]; size: number };
    attachment?: { results: ConfluenceAttachmentRaw[]; size: number };
  };
  metadata?: { labels?: { results: Array<{ name: string }> } };
  _links?: { webui?: string; base?: string };
}

export interface ConfluenceAttachmentRaw {
  id: string;
  title: string;
  extensions?: { mediaType?: string; fileSize?: number };
  _links?: { download?: string };
  container?: { id: string };
}

export interface BaseUrl {
  origin: string;
  basePath: string;
}

export interface FetchOptions {
  timeout?: number;
  maxRetries?: number;
  maxConcurrency?: number;
}

type FetchBodyKind = "json" | "blob";

type QueuedPermit = () => void;

const CONFLUENCE_BASE_PATHS = ["/wiki", "/confluence"];
const DEFAULT_REQUEST_TIMEOUT = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_CONCURRENCY = 5;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_JITTER_MS = 100;
const TRANSIENT_STATUS_CODES = new Set([429, 502, 503, 504]);

function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function normalizeBasePath(path: string): string {
  const normalized = normalizePath(path).replace(/\/$/, "");
  return normalized === "/" ? "" : normalized;
}

function parseUrlOrPath(url: string): URL {
  if (url.startsWith("/")) {
    return new URL(url, "https://confluence.local");
  }
  return new URL(url);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(resolve, ms);
    const abort = (): void => {
      clearTimeout(timeoutId);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function createRequestInit(init: RequestInit, signal?: AbortSignal): RequestInit {
  if (!signal) return init;

  const withSignal: RequestInit = { ...init };
  Object.defineProperty(withSignal, "signal", {
    value: signal,
    enumerable: false,
    configurable: true,
  });
  return withSignal;
}

function parseRateLimitReset(headers: Headers): number | null {
  const raw = headers.get("X-RateLimit-Reset");
  if (!raw) return null;

  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    return numeric > 10_000_000_000 ? numeric : numeric * 1_000;
  }

  const parsedDate = Date.parse(raw);
  return Number.isFinite(parsedDate) ? parsedDate : null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isTransientStatus(status: number): boolean {
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

export function extractBaseUrl(url: string): BaseUrl {
  const u = new URL(url);
  const basePath =
    CONFLUENCE_BASE_PATHS.find((path) =>
      u.pathname === path || u.pathname.startsWith(`${path}/`),
    ) ?? "";

  return {
    origin: `${u.protocol}//${u.host}`,
    basePath,
  };
}

export class ConfluenceApi {
  private readonly _baseUrl: BaseUrl;

  private readonly timeout: number;

  private readonly maxRetries: number;

  private readonly semaphore: Semaphore;

  private rateLimitResetAt = 0;

  constructor(baseUrl: string | BaseUrl, options: FetchOptions = {}) {
    this._baseUrl =
      typeof baseUrl === "string"
        ? { origin: baseUrl.replace(/\/$/, ""), basePath: "" }
        : {
            origin: baseUrl.origin.replace(/\/$/, ""),
            basePath: normalizeBasePath(baseUrl.basePath),
          };
    this.timeout = options.timeout ?? DEFAULT_REQUEST_TIMEOUT;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.semaphore = new Semaphore(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
  }

  get baseUrl(): BaseUrl {
    return { ...this._baseUrl };
  }

  get host(): string {
    return `${this._baseUrl.origin}${this._baseUrl.basePath}`;
  }

  url(path: string): string {
    return `${this._baseUrl.origin}${this._baseUrl.basePath}${normalizePath(path)}`;
  }

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
          throw this.createApiError(path, bodyKind, res);
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
    const backoffDelay = RETRY_BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * RETRY_JITTER_MS);
    await delay(Math.max(resetDelay, backoffDelay), signal);
  }

  private createApiError(path: string, bodyKind: FetchBodyKind, res: Response): ApiError {
    const prefix = bodyKind === "json" ? "Confluence API" : "Download";
    const message = `${prefix} ${res.status} ${res.statusText} @ ${path}`;

    if (res.status === 401) return new AuthError(message, res.status, res.statusText, path);
    if (res.status === 429) return new RateLimitError(message, res.status, res.statusText, path);
    return new ApiError(message, res.status, res.statusText, path);
  }

  async getPage(
    pageId: string,
    expand: string[] = [],
    signal?: AbortSignal,
  ): Promise<ConfluencePageRaw> {
    const params = new URLSearchParams();
    if (expand.length) params.set("expand", expand.join(","));
    const qs = params.toString();
    return this.fetchJson<ConfluencePageRaw>(
      `/rest/api/content/${pageId}${qs ? `?${qs}` : ""}`,
      signal,
    );
  }

  async getChildren(
    pageId: string,
    limit = 100,
    signal?: AbortSignal,
  ): Promise<ConfluencePageRaw[]> {
    const all: ConfluencePageRaw[] = [];
    let start = 0;
    while (true) {
      const res = await this.fetchJson<{ results: ConfluencePageRaw[]; size: number }>(
        `/rest/api/content/${pageId}/child/page?limit=${limit}&start=${start}`,
        signal,
      );
      all.push(...res.results);
      if (!res.results.length || res.results.length < limit) break;
      start += res.results.length;
      if (start > 5000) break;
    }
    return all;
  }

  async getAttachments(pageId: string, signal?: AbortSignal): Promise<AttachmentInfo[]> {
    const res = await this.fetchJson<{ results: ConfluenceAttachmentRaw[] }>(
      `/rest/api/content/${pageId}/child/attachment?limit=200`,
      signal,
    );
    return res.results.map((a) => ({
      id: a.id,
      title: a.title,
      mediaType: a.extensions?.mediaType ?? "application/octet-stream",
      fileSize: a.extensions?.fileSize ?? 0,
      downloadPath: a._links?.download ?? "",
      containerId: a.container?.id ?? pageId,
    }));
  }

  async getSpace(spaceKey: string, signal?: AbortSignal): Promise<SpaceInfo> {
    const raw = await this.fetchJson<{
      key: string;
      name: string;
      description?: { plain?: { value: string } };
      homepage?: { id: string };
    }>(`/rest/api/space/${spaceKey}?expand=description.plain,homepage`, signal);
    return {
      key: raw.key,
      name: raw.name,
      homepageId: raw.homepage?.id ?? "",
      description: raw.description?.plain?.value,
    };
  }

  async getSpacePages(
    spaceKey: string,
    options?: { label?: string; prefix?: string },
    signal?: AbortSignal,
  ): Promise<ConfluencePageMeta[]> {
    const path = options?.label
      ? `/rest/api/content?${new URLSearchParams({
          cql: `space="${spaceKey}" and type=page and label="${options.label}"`,
          limit: "200",
        }).toString()}`
      : `/rest/api/space/${spaceKey}/content/page?limit=200`;
    const raw = await this.fetchJson<{ results: ConfluencePageRaw[] }>(path, signal);
    const pages = options?.prefix
      ? raw.results.filter((page) => page.title.startsWith(options.prefix ?? ""))
      : raw.results;
    return pages.map((page) => this.toPageMeta(page));
  }

  toPageMeta(raw: ConfluencePageRaw, sourceUrl?: string): ConfluencePageMeta {
    const webui = raw._links?.webui ?? `/pages/viewpage.action?pageId=${raw.id}`;
    return {
      id: raw.id,
      title: raw.title,
      spaceKey: raw.space?.key ?? "",
      baseUrl: this._baseUrl.origin,
      url: sourceUrl ?? this.url(webui),
      version: raw.version?.number,
      labels: raw.metadata?.labels?.results?.map((l) => l.name),
      ancestors: raw.ancestors?.map((a) => ({ id: a.id, title: a.title })),
      attachmentCount: raw.children?.attachment?.size,
    };
  }
}

export function extractPageIdFromUrl(url: string): string | null {
  try {
    const u = parseUrlOrPath(url);
    const pageId = u.searchParams.get("pageId");
    if (pageId) return pageId;

    const segments = u.pathname.split("/").filter(Boolean);
    const pagesIndex = segments.indexOf("pages");
    const pageIdSegment = pagesIndex >= 0 ? segments[pagesIndex + 1] : undefined;
    if (pageIdSegment && /^\d+$/.test(pageIdSegment)) return pageIdSegment;

    // /display/SPACE/Title — requires an HTML fetch to resolve. Not handled here.
    const lastNumericSegment = [...segments].reverse().find((segment) => /^\d+$/.test(segment));
    if (lastNumericSegment) return lastNumericSegment;

    return null;
  } catch {
    return null;
  }
}

export function extractHostFromUrl(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}
