import { createConfluenceApi, toFetchOptions } from "@/lib/create-api";
import { loadSettings } from "@/lib/settings";
import { resolveSourceBase } from "@/lib/source-context";
import type { ConfluencePageMeta } from "@/types";

export interface PageInfo {
  meta: ConfluencePageMeta;
  childCount: number;
  children: Array<{ id: string; title: string }>;
}

export async function fetchPageInfo(
  host: string,
  pageId: string,
  signal?: AbortSignal,
): Promise<PageInfo> {
  const settings = await loadSettings();
  const { baseUrl } = resolveSourceBase(host, host, settings.confluenceBaseUrl);
  const api = createConfluenceApi(baseUrl, toFetchOptions(settings));
  const raw = await api.getPage(
    pageId,
    ["space", "version", "ancestors", "metadata.labels", "children.attachment"],
    signal,
  );
  const meta = api.toPageMeta(raw);
  const children = await api.getChildren(pageId, 100, signal);

  return {
    meta,
    childCount: children.length,
    children: children.map((child) => ({ id: child.id, title: child.title })),
  };
}

export async function fetchChildren(
  host: string,
  pageId: string,
  signal?: AbortSignal,
): Promise<Array<{ id: string; title: string; hasChildren: boolean }>> {
  const settings = await loadSettings();
  const { baseUrl } = resolveSourceBase(host, host, settings.confluenceBaseUrl);
  const api = createConfluenceApi(baseUrl, toFetchOptions(settings));
  const children = await api.getChildren(pageId, 100, signal);

  return Promise.all(
    children.map(async (child) => {
      try {
        const sub = await api.fetchJson<{ size: number }>(
          `/rest/api/content/${child.id}/child/page?limit=1`,
          signal,
        );
        return { id: child.id, title: child.title, hasChildren: (sub.size ?? 0) > 0 };
      } catch {
        return { id: child.id, title: child.title, hasChildren: false };
      }
    }),
  );
}
