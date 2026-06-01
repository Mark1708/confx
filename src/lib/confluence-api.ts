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
