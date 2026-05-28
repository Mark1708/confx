import {
  ApiError,
  AuthError,
  type JiraAttachment,
  type JiraComment,
  type JiraIssueMeta,
  NetworkError,
  RateLimitError,
} from "@/types";

export interface FetchOptions {
  timeout?: number;
  maxRetries?: number;
  maxConcurrency?: number;
}

type FetchBodyKind = "json" | "blob";
type QueuedPermit = () => void;

const DEFAULT_REQUEST_TIMEOUT = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_CONCURRENCY = 5;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_JITTER_MS = 100;
const TRANSIENT_STATUS_CODES = new Set([429, 502, 503, 504]);

function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function isAbsoluteUrl(path: string): boolean {
  try {
    const url = new URL(path);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
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
  if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? numeric : numeric * 1_000;

  const parsedDate = Date.parse(raw);
  return Number.isFinite(parsedDate) ? parsedDate : null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isTransientStatus(status: number): boolean {
  return TRANSIENT_STATUS_CODES.has(status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  const child = isRecord(value) ? value[key] : undefined;
  return isRecord(child) ? child : undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getNullableNamedValue(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return getString(value.name) ?? null;
}

function getUserKey(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return getString(value.key) ?? getString(value.name) ?? getString(value.accountId) ?? null;
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function getNamedArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (isRecord(item) ? getString(item.name) : undefined))
    .filter((item): item is string => typeof item === "string");
}

function fallbackProjectKey(issueKey: string): string {
  const separatorIndex = issueKey.indexOf("-");
  return separatorIndex > 0 ? issueKey.slice(0, separatorIndex) : "";
}

export function toIssueMeta(raw: unknown, baseUrl = ""): JiraIssueMeta {
  const issue = isRecord(raw) ? raw : {};
  const fields = getRecord(issue, "fields") ?? {};
  const key = getString(issue.key) ?? "";
  const project = getRecord(fields, "project");

  return {
    key,
    project: getString(project?.key) ?? getString(project?.name) ?? fallbackProjectKey(key),
    type: getNullableNamedValue(fields.issuetype) ?? "",
    status: getNullableNamedValue(fields.status) ?? "",
    priority: getNullableNamedValue(fields.priority) ?? "",
    resolution: getNullableNamedValue(fields.resolution),
    summary: getString(fields.summary) ?? "",
    assignee: getUserKey(fields.assignee),
    reporter: getUserKey(fields.reporter),
    labels: getStringArray(fields.labels),
    components: getNamedArray(fields.components),
    versions: getNamedArray(fields.versions),
    fixVersions: getNamedArray(fields.fixVersions),
    epicLink: getString(fields.customfield_10100) ?? null,
    created: getString(fields.created) ?? "",
    updated: getString(fields.updated) ?? "",
    dueDate: getString(fields.duedate) ?? null,
    baseUrl,
    url: `${baseUrl}/browse/${encodeURIComponent(key)}`,
  };
}

function toComment(raw: unknown): JiraComment {
  const comment = isRecord(raw) ? raw : {};
  return {
    id: getString(comment.id) ?? "",
    author: getUserKey(comment.author) ?? "",
    createdAt: getString(comment.created) ?? "",
    body: getString(comment.body) ?? "",
    markdown: getString(comment.body) ?? "",
  };
}

function toAttachment(raw: unknown): JiraAttachment {
  const attachment = isRecord(raw) ? raw : {};
  return {
    id: getString(attachment.id) ?? "",
    fileName: getString(attachment.filename) ?? "",
    mediaType: getString(attachment.mimeType) ?? "application/octet-stream",
    fileSize: typeof attachment.size === "number" ? attachment.size : 0,
    contentUrl: getString(attachment.content) ?? "",
  };
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

export class JiraApi {
  private readonly baseUrl: string;

  private readonly timeout: number;

  private readonly maxRetries: number;

  private readonly semaphore: Semaphore;

  private rateLimitResetAt = 0;

  constructor(baseUrl: string, options: FetchOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeout = options.timeout ?? DEFAULT_REQUEST_TIMEOUT;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.semaphore = new Semaphore(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
  }

  get host(): string {
    return this.baseUrl;
  }

  url(path: string): string {
    return isAbsoluteUrl(path) ? path : `${this.baseUrl}${normalizePath(path)}`;
  }

  async fetchJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchWithPolicy(path, "json", signal);
    return (await res.json()) as T;
  }

  async fetchBlob(path: string, signal?: AbortSignal): Promise<Blob> {
    const res = await this.fetchWithPolicy(path, "blob", signal);
    return await res.blob();
  }

  async getIssue(issueKey: string, signal?: AbortSignal): Promise<JiraIssueMeta> {
    const raw = await this.fetchJson<unknown>(`/rest/api/2/issue/${encodeURIComponent(issueKey)}`, signal);
    return toIssueMeta(raw, this.baseUrl);
  }

  async searchIssues(jql: string, maxResults = 50, signal?: AbortSignal): Promise<JiraIssueMeta[]> {
    const params = new URLSearchParams({ jql, maxResults: String(maxResults) });
    const raw = await this.fetchJson<unknown>(`/rest/api/2/search?${params.toString()}`, signal);
    const issues = isRecord(raw) && Array.isArray(raw.issues) ? raw.issues : [];
    return issues.map((issue) => toIssueMeta(issue, this.baseUrl));
  }

  async getComments(issueKey: string, signal?: AbortSignal): Promise<JiraComment[]> {
    const raw = await this.fetchJson<unknown>(`/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment`, signal);
    const comments = isRecord(raw) && Array.isArray(raw.comments) ? raw.comments : [];
    return comments.map(toComment);
  }

  async getAttachments(issueKey: string, signal?: AbortSignal): Promise<JiraAttachment[]> {
    const raw = await this.fetchJson<unknown>(`/rest/api/2/issue/${encodeURIComponent(issueKey)}`, signal);
    const fields = getRecord(raw, "fields") ?? {};
    const attachments = Array.isArray(fields.attachment) ? fields.attachment : [];
    return attachments.map(toAttachment);
  }

  private async fetchWithPolicy(path: string, bodyKind: FetchBodyKind, signal?: AbortSignal): Promise<Response> {
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
        if (attempt === this.maxRetries) throw new NetworkError(`Network error @ ${path}`, path, error);
        await this.waitBeforeRetry(attempt, undefined, signal);
      } finally {
        release();
      }
    }

    throw new NetworkError(`Network error @ ${path}`, path);
  }

  private async performFetch(path: string, bodyKind: FetchBodyKind, signal?: AbortSignal): Promise<Response> {
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

  private async waitBeforeRetry(attempt: number, headers?: Headers, signal?: AbortSignal): Promise<void> {
    const resetAt = headers ? parseRateLimitReset(headers) : null;
    const resetDelay = resetAt ? Math.max(0, resetAt - Date.now()) : 0;
    const backoffDelay = RETRY_BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * RETRY_JITTER_MS);
    await delay(Math.max(resetDelay, backoffDelay), signal);
  }

  private createApiError(path: string, bodyKind: FetchBodyKind, res: Response): ApiError {
    const prefix = bodyKind === "json" ? "Jira API" : "Download";
    const message = `${prefix} ${res.status} ${res.statusText} @ ${path}`;
    if (res.status === 401) return new AuthError(message, res.status, res.statusText, path);
    if (res.status === 429) return new RateLimitError(message, res.status, res.statusText, path);
    return new ApiError(message, res.status, res.statusText, path);
  }
}
