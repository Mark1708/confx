import { ConfluenceApi } from "./confluence-api";
import { storage } from "@/lib/browser";

export interface TreeNode {
  id: string;
  title: string;
  parentId?: string;
  hasChildren?: boolean;
  childrenLoaded: boolean;
  childrenIds: string[];
}

export type HostCache = Record<string, TreeNode>;

type Listener = (cache: HostCache) => void;

interface Store {
  host: string;
  cache: HostCache;
  listeners: Set<Listener>;
  loadingIds: Set<string>;
  pendingChildren: Map<string, Promise<void>>;
  pendingPath: Map<string, Promise<void>>;
  loaded: boolean;
  loadPromise?: Promise<void>;
}

const stores = new Map<string, Store>();
const key = (host: string) => `cx.tree-cache.v1:${host}`;

async function loadHost(host: string): Promise<HostCache> {
  const res = await storage.local.get(key(host));
  return (res[key(host)] as HostCache) ?? {};
}

let persistScheduled = new Map<string, number>();
function schedulePersist(s: Store): void {
  const existing = persistScheduled.get(s.host);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    persistScheduled.delete(s.host);
    void storage.local.set({ [key(s.host)]: s.cache });
  }, 150) as unknown as number;
  persistScheduled.set(s.host, t);
}

function getStore(host: string): Store {
  let s = stores.get(host);
  if (!s) {
    const created: Store = {
      host,
      cache: {},
      listeners: new Set(),
      loadingIds: new Set(),
      pendingChildren: new Map(),
      pendingPath: new Map(),
      loaded: false,
    };
    created.loadPromise = loadHost(host).then((c) => {
      created.cache = c;
      created.loaded = true;
      notify(created);
    });
    stores.set(host, created);
    s = created;
  }
  return s;
}

function notify(s: Store): void {
  for (const l of s.listeners) l(s.cache);
}

export interface TreeStoreSnapshot {
  cache: HostCache;
  loadingIds: ReadonlySet<string>;
  loaded: boolean;
}

export function subscribe(host: string, l: Listener): () => void {
  const s = getStore(host);
  s.listeners.add(l);
  l(s.cache);
  return () => {
    s.listeners.delete(l);
  };
}

export function getLoadingIds(host: string): ReadonlySet<string> {
  return getStore(host).loadingIds;
}

export function isStoreReady(host: string): boolean {
  return getStore(host).loaded;
}

export async function waitReady(host: string): Promise<void> {
  const s = getStore(host);
  if (s.loaded) return;
  await s.loadPromise;
}

function upsertNode(cache: HostCache, id: string, patch: Partial<TreeNode>): HostCache {
  const prev = cache[id];
  const merged: TreeNode = {
    id,
    title: patch.title ?? prev?.title ?? "",
    parentId: patch.parentId !== undefined ? patch.parentId : prev?.parentId,
    hasChildren: patch.hasChildren !== undefined ? patch.hasChildren : prev?.hasChildren,
    childrenLoaded: patch.childrenLoaded ?? prev?.childrenLoaded ?? false,
    childrenIds: patch.childrenIds ?? prev?.childrenIds ?? [],
  };
  return { ...cache, [id]: merged };
}

async function fetchAndMergeChildren(
  s: Store,
  pageId: string,
  opts: { silent: boolean },
): Promise<void> {
  if (!opts.silent) {
    s.loadingIds.add(pageId);
    notify(s);
  }
  try {
    const api = new ConfluenceApi(s.host);
    const limit = 100;
    const kids: Array<{ id: string; title: string; hasChildren?: boolean }> = [];
    let start = 0;
    while (true) {
      const res = await api.fetchJson<{
        results: Array<{
          id: string;
          title: string;
          childTypes?: { page?: { value?: boolean } };
        }>;
        size: number;
      }>(
        `/rest/api/content/${pageId}/child/page?limit=${limit}&start=${start}&expand=childTypes.page`,
      );
      for (const r of res.results) {
        kids.push({
          id: r.id,
          title: r.title,
          hasChildren: r.childTypes?.page?.value,
        });
      }
      if (!res.results.length || res.results.length < limit) break;
      start += res.results.length;
      if (start > 5000) break;
    }

    // Fallback probe for children whose hasChildren wasn't populated by the
    // expand (some Confluence versions only return `_expandable` without a
    // concrete `value`). One small request each, fired in parallel.
    const unknownKids = kids.filter((k) => k.hasChildren === undefined);
    if (unknownKids.length > 0) {
      await Promise.all(
        unknownKids.map(async (k) => {
          try {
            const res = await api.fetchJson<{ size: number }>(
              `/rest/api/content/${k.id}/child/page?limit=1`,
            );
            k.hasChildren = (res.size ?? 0) > 0;
          } catch {
            // leave undefined on error
          }
        }),
      );
    }

    let next = s.cache;
    const newChildrenIds: string[] = kids.map((k) => k.id);
    const previouslyKnown = new Set(s.cache[pageId]?.childrenIds ?? []);
    const newKnown = new Set(newChildrenIds);
    for (const k of kids) {
      next = upsertNode(next, k.id, {
        title: k.title,
        parentId: pageId,
        hasChildren: k.hasChildren,
      });
    }
    // Remove nodes that were children last time but disappeared — drops renamed/deleted branches.
    for (const prevId of previouslyKnown) {
      if (!newKnown.has(prevId)) {
        next = { ...next };
        delete next[prevId];
      }
    }
    next = upsertNode(next, pageId, {
      childrenLoaded: true,
      childrenIds: newChildrenIds,
      hasChildren: newChildrenIds.length > 0,
    });
    s.cache = next;
    schedulePersist(s);
    notify(s);
  } finally {
    if (!opts.silent) s.loadingIds.delete(pageId);
    s.pendingChildren.delete(pageId);
    notify(s);
  }
}

export async function ensureChildren(host: string, pageId: string): Promise<void> {
  const s = getStore(host);
  await waitReady(host);
  if (s.cache[pageId]?.childrenLoaded) return;
  const existing = s.pendingChildren.get(pageId);
  if (existing) return existing;
  const promise = fetchAndMergeChildren(s, pageId, { silent: false });
  s.pendingChildren.set(pageId, promise);
  return promise;
}

/**
 * Re-fetch children for an already-loaded node in the background. Does not show
 * a spinner; existing cached data stays in place until the response arrives and
 * is merged. Used for seamless refresh when revisiting known pages.
 */
export async function revalidateChildren(host: string, pageId: string): Promise<void> {
  const s = getStore(host);
  await waitReady(host);
  const existing = s.pendingChildren.get(pageId);
  if (existing) return existing;
  const promise = fetchAndMergeChildren(s, pageId, { silent: true });
  s.pendingChildren.set(pageId, promise);
  return promise;
}

export async function ensurePath(host: string, pageId: string): Promise<void> {
  const s = getStore(host);
  await waitReady(host);
  const existing = s.pendingPath.get(pageId);
  if (existing) return existing;

  const hasFullPath = (): boolean => {
    const n = s.cache[pageId];
    if (!n || !n.title) return false;
    let cursor: string | undefined = n.parentId;
    const seen = new Set<string>([pageId]);
    while (cursor) {
      if (seen.has(cursor)) return false;
      seen.add(cursor);
      const p = s.cache[cursor];
      if (!p) return false;
      cursor = p.parentId;
    }
    return true;
  };
  if (hasFullPath()) return;

  const promise = (async () => {
    try {
      const api = new ConfluenceApi(host);
      const page = await api.getPage(pageId, ["ancestors", "children.page"]);
      const ancestors = page.ancestors ?? [];
      const chain: Array<{ id: string; title: string }> = [
        ...ancestors.map((a) => ({ id: a.id, title: a.title })),
        { id: page.id, title: page.title },
      ];
      let next = s.cache;
      for (let i = 0; i < chain.length; i++) {
        const { id, title } = chain[i];
        const parentId = i > 0 ? chain[i - 1].id : undefined;
        next = upsertNode(next, id, { title, parentId });
      }
      const pageHas = (page.children?.page?.size ?? 0) > 0;
      next = upsertNode(next, page.id, { hasChildren: pageHas });
      s.cache = next;
      schedulePersist(s);
      notify(s);
    } finally {
      s.pendingPath.delete(pageId);
    }
  })();
  s.pendingPath.set(pageId, promise);
  return promise;
}

/**
 * Ensure both the ancestor metadata chain AND the children of every ancestor
 * on that chain are loaded. Guarantees the tree can render the full path from
 * root → pageId with siblings visible at each level.
 */
export async function ensurePathWithChildren(host: string, pageId: string): Promise<void> {
  await ensurePath(host, pageId);
  const s = getStore(host);
  const chain: string[] = [];
  let cursor: string | undefined = pageId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    chain.push(cursor);
    cursor = s.cache[cursor]?.parentId;
  }
  await Promise.all(
    chain.map((id) => {
      const n = s.cache[id];
      return n?.childrenLoaded ? revalidateChildren(host, id) : ensureChildren(host, id);
    }),
  );
}

export async function resetHost(host: string): Promise<void> {
  await storage.local.remove(key(host));
  const s = stores.get(host);
  if (!s) return;
  s.cache = {};
  s.pendingChildren.clear();
  s.pendingPath.clear();
  s.loadingIds.clear();
  notify(s);
}

export interface SearchHit {
  id: string;
  title: string;
  ancestors: Array<{ id: string; title: string }>;
}

export async function searchPagesOnServer(
  host: string,
  query: string,
  spaceKey?: string,
  limit = 20,
): Promise<SearchHit[]> {
  const s = getStore(host);
  await waitReady(host);
  const api = new ConfluenceApi(host);
  const safe = query.replace(/"/g, '\\"');
  const cql = [
    "type=page",
    spaceKey ? `space="${spaceKey}"` : null,
    `title~"${safe}"`,
  ]
    .filter(Boolean)
    .join(" AND ");
  const params = new URLSearchParams();
  params.set("cql", cql);
  params.set("limit", String(limit));
  params.set("expand", "ancestors,children.page");
  const res = await api.fetchJson<{
    results: Array<{
      id: string;
      title: string;
      ancestors?: Array<{ id: string; title: string }>;
      children?: { page?: { size?: number } };
    }>;
  }>(`/rest/api/content/search?${params.toString()}`);

  const hits: SearchHit[] = [];
  let next = s.cache;
  for (const r of res.results) {
    const ancestors = r.ancestors ?? [];
    const chain: Array<{ id: string; title: string }> = [
      ...ancestors.map((a) => ({ id: a.id, title: a.title })),
      { id: r.id, title: r.title },
    ];
    for (let i = 0; i < chain.length; i++) {
      const { id, title } = chain[i];
      const parentId = i > 0 ? chain[i - 1].id : undefined;
      next = upsertNode(next, id, { title, parentId });
    }
    const hitHas = (r.children?.page?.size ?? 0) > 0;
    next = upsertNode(next, r.id, { hasChildren: hitHas });
    hits.push({ id: r.id, title: r.title, ancestors });
  }
  s.cache = next;
  schedulePersist(s);
  notify(s);
  return hits;
}

/**
 * Recursively ensure all descendants of rootId are loaded into the cache.
 * Returns all page IDs in DFS order (root first).
 */
export async function loadSubtree(
  host: string,
  rootId: string,
  onProgress?: (visited: number, title: string) => void,
): Promise<string[]> {
  const s = getStore(host);
  await waitReady(host);
  const order: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    await ensureChildren(host, id);
    const node = s.cache[id];
    onProgress?.(order.length, node?.title ?? id);
    if (node?.childrenIds.length) {
      for (let i = node.childrenIds.length - 1; i >= 0; i--) {
        stack.push(node.childrenIds[i]);
      }
    }
  }
  return order;
}
