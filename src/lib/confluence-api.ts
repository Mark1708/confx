import { type FetchOptions, HttpClient, normalizePath } from "@/lib/http-client";
import type { AttachmentInfo, ConfluencePageMeta, SpaceInfo } from "@/types";

export type { FetchOptions } from "@/lib/http-client";

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

const CONFLUENCE_BASE_PATHS = ["/wiki", "/confluence"];

export async function collectConfluencePages<T extends { id: string }>(
  fetchBatch: (start: number) => Promise<{ results: T[]; start?: number }>,
): Promise<T[]> {
  const all: T[] = [];
  const seen = new Set<string>();
  let start = 0;
  while (true) {
    const batch = await fetchBatch(start);
    if (batch.start !== undefined && batch.start !== start) {
      throw new Error(
        `Confluence pagination error: expected offset ${start}, received ${batch.start}`,
      );
    }
    if (batch.results.length === 0) return all;
    for (const item of batch.results) {
      if (seen.has(item.id)) {
        throw new Error(`Confluence pagination error: repeated content id ${item.id}`);
      }
      seen.add(item.id);
      all.push(item);
    }
    const next = start + batch.results.length;
    if (!Number.isSafeInteger(next) || next <= start) {
      throw new Error("Confluence pagination error: offset did not advance");
    }
    start = next;
  }
}

function cqlLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function contentIdSegment(value: string): string {
  if (!/^[0-9]+$/.test(value)) throw new Error(`Invalid Confluence content id: ${value}`);
  return encodeURIComponent(value);
}

function normalizeBasePath(path: string): string {
  const normalized = normalizePath(path).replace(/\/$/, "");
  return normalized === "/" ? "" : normalized;
}

function isAbsoluteHttpUrl(path: string): boolean {
  try {
    const url = new URL(path);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function parseUrlOrPath(url: string): URL {
  if (url.startsWith("/")) {
    return new URL(url, "https://confluence.local");
  }
  return new URL(url);
}

export function extractBaseUrl(url: string): BaseUrl {
  const u = new URL(url);
  const basePath =
    CONFLUENCE_BASE_PATHS.find(
      (path) => u.pathname === path || u.pathname.startsWith(`${path}/`),
    ) ?? "";

  return {
    origin: `${u.protocol}//${u.host}`,
    basePath,
  };
}

export class ConfluenceApi extends HttpClient {
  private readonly _baseUrl: BaseUrl;

  constructor(baseUrl: string | BaseUrl, options: FetchOptions = {}) {
    super("Confluence API", options);
    this._baseUrl =
      typeof baseUrl === "string"
        ? { origin: baseUrl.replace(/\/$/, ""), basePath: "" }
        : {
            origin: baseUrl.origin.replace(/\/$/, ""),
            basePath: normalizeBasePath(baseUrl.basePath),
          };
  }

  get baseUrl(): BaseUrl {
    return { ...this._baseUrl };
  }

  get host(): string {
    return `${this._baseUrl.origin}${this._baseUrl.basePath}`;
  }

  url(path: string): string {
    if (isAbsoluteHttpUrl(path)) return path;

    const normalizedPath = normalizePath(path);
    if (
      this._baseUrl.basePath &&
      (normalizedPath === this._baseUrl.basePath ||
        normalizedPath.startsWith(`${this._baseUrl.basePath}/`))
    ) {
      return `${this._baseUrl.origin}${normalizedPath}`;
    }

    return `${this._baseUrl.origin}${this._baseUrl.basePath}${normalizedPath}`;
  }

  async getPage(
    pageId: string,
    expand: string[] = [],
    signal?: AbortSignal,
  ): Promise<ConfluencePageRaw> {
    const id = contentIdSegment(pageId);
    const params = new URLSearchParams();
    if (expand.length) params.set("expand", expand.join(","));
    const qs = params.toString();
    return this.fetchJson<ConfluencePageRaw>(
      `/rest/api/content/${id}${qs ? `?${qs}` : ""}`,
      signal,
    );
  }

  /** Convert in page context without saving content or creating a draft. */
  async convertBody(
    value: string,
    from: "storage" | "editor",
    to: "storage" | "editor",
    pageId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const id = contentIdSegment(pageId);
    if (
      typeof value !== "string" ||
      !["storage", "editor"].includes(from) ||
      !["storage", "editor"].includes(to) ||
      from === to
    ) {
      throw new Error("Unsupported Confluence body conversion");
    }
    const response = await this.requestJson<{ value?: string; representation?: string }>(
      `/rest/api/contentbody/convert/${to}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ representation: from, value, content: { id } }),
      },
      signal,
    );
    if (typeof response.value !== "string" || response.representation !== to) {
      throw new Error("Confluence conversion returned an invalid body representation");
    }
    return response.value;
  }

  async getChildren(
    pageId: string,
    limit = 100,
    signal?: AbortSignal,
  ): Promise<ConfluencePageRaw[]> {
    const id = contentIdSegment(pageId);
    return collectConfluencePages((start) =>
      this.fetchJson<{ results: ConfluencePageRaw[]; start?: number }>(
        `/rest/api/content/${id}/child/page?limit=${limit}&start=${start}`,
        signal,
      ),
    );
  }

  async getAttachments(pageId: string, signal?: AbortSignal): Promise<AttachmentInfo[]> {
    const id = contentIdSegment(pageId);
    const all: ConfluenceAttachmentRaw[] = [];
    const limit = 200;
    let start = 0;
    while (true) {
      const res = await this.fetchJson<{ results: ConfluenceAttachmentRaw[] }>(
        `/rest/api/content/${id}/child/attachment?limit=${limit}&start=${start}`,
        signal,
      );
      all.push(...res.results);
      if (res.results.length < limit) break;
      start += res.results.length;
    }
    return all.map((attachment) => ({
      id: attachment.id,
      title: attachment.title,
      mediaType: attachment.extensions?.mediaType ?? "application/octet-stream",
      fileSize: attachment.extensions?.fileSize ?? 0,
      downloadPath: attachment._links?.download ?? "",
      containerId: attachment.container?.id ?? pageId,
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
    const params = new URLSearchParams({ limit: "200" });
    const path = options?.label
      ? "/rest/api/content/search"
      : `/rest/api/space/${encodeURIComponent(spaceKey)}/content/page`;
    if (options?.label) {
      params.set(
        "cql",
        `space=${cqlLiteral(spaceKey)} and type=page and label=${cqlLiteral(options.label)}`,
      );
    }
    const raw = await collectConfluencePages((start) => {
      params.set("start", String(start));
      return this.fetchJson<{ results: ConfluencePageRaw[]; start?: number }>(
        `${path}?${params.toString()}`,
        signal,
      );
    });
    const pages = options?.prefix
      ? raw.filter((page) => page.title.startsWith(options.prefix ?? ""))
      : raw;
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

    return null;
  } catch {
    return null;
  }
}

export function extractHostFromUrl(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

export function extractConfluenceBaseUrlFromUrl(url: string): string {
  const { origin, basePath } = extractBaseUrl(url);
  return `${origin}${basePath}`;
}
