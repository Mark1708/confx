import {
  collectConfluencePages,
  type ConfluenceApi,
  type ConfluencePageRaw,
} from "./confluence-api";
import type { PageSnapshot, PageSnapshotEntry } from "./subscriptions";

export interface SnapshotProgress {
  visited: number;
  currentTitle: string;
}

export interface BuildSnapshotOptions {
  maxDepth?: number;
  onProgress?: (p: SnapshotProgress) => void;
}

const VERSION_EXPAND = "version,version.by";

function toEntry(page: ConfluencePageRaw, parentId?: string): PageSnapshotEntry {
  return {
    title: page.title,
    version: page.version?.number ?? 0,
    updatedAt: page.version?.when ?? "",
    updatedBy: page.version?.by?.displayName ?? page.version?.by?.username ?? "",
    parentId,
  };
}

/**
 * Собрать снимок одной страницы без обхода детей.
 */
export async function buildPageSnapshot(
  api: ConfluenceApi,
  pageId: string,
): Promise<{ snapshot: PageSnapshot; root: ConfluencePageRaw }> {
  const root = await api.getPage(pageId, ["version", "version.by", "space", "ancestors"]);
  const parent = root.ancestors?.length ? root.ancestors[root.ancestors.length - 1].id : undefined;
  const snapshot: PageSnapshot = { [root.id]: toEntry(root, parent) };
  return { snapshot, root };
}

/**
 * Собрать снимок поддерева начиная с rootId.
 * Не загружает тело страниц — только лёгкие метаданные.
 */
export async function buildSubtreeSnapshot(
  api: ConfluenceApi,
  rootId: string,
  opts: BuildSnapshotOptions = {},
): Promise<{ snapshot: PageSnapshot; root: ConfluencePageRaw }> {
  const maxDepth = opts.maxDepth ?? 20;
  const root = await api.getPage(rootId, ["version", "version.by", "space", "ancestors"]);
  const snapshot: PageSnapshot = {};
  const rootParent = root.ancestors?.length
    ? root.ancestors[root.ancestors.length - 1].id
    : undefined;
  snapshot[root.id] = toEntry(root, rootParent);
  opts.onProgress?.({ visited: 1, currentTitle: root.title });

  const queue: Array<{ id: string; depth: number }> = [{ id: root.id, depth: 0 }];
  while (queue.length) {
    const { id, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;
    const children = await fetchChildrenWithVersion(api, id);
    for (const child of children) {
      snapshot[child.id] = toEntry(child, id);
      opts.onProgress?.({ visited: Object.keys(snapshot).length, currentTitle: child.title });
      queue.push({ id: child.id, depth: depth + 1 });
    }
  }
  return { snapshot, root };
}

async function fetchChildrenWithVersion(
  api: ConfluenceApi,
  pageId: string,
  limit = 100,
): Promise<ConfluencePageRaw[]> {
  return collectConfluencePages((start) =>
    api.fetchJson<{ results: ConfluencePageRaw[]; start?: number }>(
      `/rest/api/content/${pageId}/child/page?limit=${limit}&start=${start}&expand=${VERSION_EXPAND}`,
    ),
  );
}
