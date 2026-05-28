import { useCallback, useEffect, useRef, useState } from "react";
import {
  ensureChildren as ensureChildrenInStore,
  ensurePath as ensurePathInStore,
  ensurePathWithChildren as ensurePathWithChildrenInStore,
  getLoadingIds,
  resetHost,
  searchPagesOnServer,
  subscribe,
  type HostCache,
  type SearchHit,
} from "@/lib/tree-cache";

export interface TreeStore {
  cache: HostCache;
  loadingIds: ReadonlySet<string>;
  ensureChildren: (id: string) => Promise<void>;
  ensurePath: (id: string) => Promise<void>;
  ensurePathWithChildren: (id: string) => Promise<void>;
  reset: () => Promise<void>;
  search: (query: string, spaceKey?: string) => Promise<SearchHit[]>;
}

export function useTreeStore(host: string | undefined): TreeStore {
  const [cache, setCache] = useState<HostCache>({});
  const [, bump] = useState(0);
  const hostRef = useRef(host);
  hostRef.current = host;

  useEffect(() => {
    if (!host) {
      setCache({});
      return;
    }
    const unsub = subscribe(host, (c) => {
      setCache(c);
      bump((n) => n + 1);
    });
    return unsub;
  }, [host]);

  const ensureChildren = useCallback(
    async (id: string) => {
      if (!host) return;
      await ensureChildrenInStore(host, id);
    },
    [host],
  );

  const ensurePath = useCallback(
    async (id: string) => {
      if (!host) return;
      await ensurePathInStore(host, id);
    },
    [host],
  );

  const ensurePathWithChildren = useCallback(
    async (id: string) => {
      if (!host) return;
      await ensurePathWithChildrenInStore(host, id);
    },
    [host],
  );

  const reset = useCallback(async () => {
    if (!host) return;
    await resetHost(host);
  }, [host]);

  const search = useCallback(
    async (query: string, spaceKey?: string): Promise<SearchHit[]> => {
      if (!host) return [];
      return searchPagesOnServer(host, query, spaceKey);
    },
    [host],
  );

  return {
    cache,
    loadingIds: host ? getLoadingIds(host) : new Set(),
    ensureChildren,
    ensurePath,
    ensurePathWithChildren,
    reset,
    search,
  };
}
