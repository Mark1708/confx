import { Bell, BellRing, FolderDown, Loader2, Search, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { BrowserApi } from "@/lib/browser/browser-api";
import { makeSubscriptionId } from "@/lib/subscriptions";
import type { HostCache } from "@/lib/tree-cache";
import type { CurrentTabInfo } from "../hooks/useCurrentTab";
import { useExtractJob } from "../hooks/useExtractJob";
import { useI18n } from "../hooks/useI18n";
import { usePageInfo } from "../hooks/usePageInfo";
import { useSubscriptions } from "../hooks/useSubscriptions";
import { useTreeStore } from "../hooks/useTreeStore";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { useWorkspace } from "../workspace/WorkspaceProvider";
import { TreeView } from "./TreeView";

function findCachedPath(nodes: HostCache, pageId: string): string[] | undefined {
  if (!nodes[pageId]?.title) return undefined;
  const path: string[] = [];
  let cursor: string | undefined = pageId;
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor)) return undefined;
    seen.add(cursor);
    path.push(cursor);
    cursor = nodes[cursor]?.parentId;
  }
  return path.reverse();
}

function buildPageUrl(host: string, pageId: string): string {
  const base = host.replace(/\/$/, "");
  return `${base}/pages/viewpage.action?pageId=${encodeURIComponent(pageId)}`;
}

interface FilterResult {
  visibleIds: Set<string>;
  matchedIds: Set<string>;
}

/**
 * Walk the cache bottom-up: every node whose title matches the query contributes
 * itself + its ancestor chain up to rootId. This works even for nodes that were
 * added to the cache via search/ensurePath (their parent's childrenIds may be
 * incomplete).
 */
function computeClientFilter(nodes: HostCache, rootId: string, query: string): FilterResult {
  const q = query.trim().toLowerCase();
  const matchedIds = new Set<string>();
  const visibleIds = new Set<string>();
  if (!q) return { matchedIds, visibleIds };

  for (const id of Object.keys(nodes)) {
    const n = nodes[id];
    if (!n.title?.toLowerCase().includes(q)) continue;

    const chain: string[] = [];
    let cursor: string | undefined = id;
    const seen = new Set<string>();
    let hitsRoot = false;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      chain.push(cursor);
      if (cursor === rootId) {
        hitsRoot = true;
        break;
      }
      cursor = nodes[cursor]?.parentId;
    }
    if (!hitsRoot) continue;
    matchedIds.add(id);
    for (const c of chain) visibleIds.add(c);
  }
  return { visibleIds, matchedIds };
}

export function SubtreePanel({ tab }: { tab: CurrentTabInfo }) {
  const { source, sourceKey, draft, patchDraft } = useWorkspace();
  const { subtree } = draft;
  const host = draft.source.baseUrl;
  const available =
    source?.product === "confluence" &&
    source.baseUrl === host &&
    tab.host === host &&
    tab.accessState === "available";
  const info = usePageInfo(available ? host : undefined, tab.pageId);
  const { t } = useI18n();
  const { draftLocked } = useExtractJob();
  const { filter, serverSearch: serverSearchState } = subtree;
  const subs = useSubscriptions();
  const { cache, loadingIds, ensureChildren, ensurePathWithChildren, reset, search } =
    useTreeStore(host);
  const meta =
    !info.isPlaceholderData && info.data?.meta?.id === tab.pageId ? info.data?.meta : undefined;
  const initialRoot = subtree.rootId ?? (available ? (tab.pageId ?? undefined) : undefined);

  useEffect(() => {
    if (!available || !initialRoot) return;
    void ensurePathWithChildren(initialRoot);
  }, [available, initialRoot, ensurePathWithChildren]);

  useEffect(() => {
    if (!available || !initialRoot) return;
    const path =
      findCachedPath(cache, initialRoot) ??
      (meta?.id === initialRoot && meta.ancestors !== undefined
        ? [...meta.ancestors.map((ancestor) => ancestor.id), initialRoot]
        : undefined);
    const initializeRoot = subtree.rootId === undefined;
    const initializeTree = subtree.treeRootId === undefined && path !== undefined;
    if (!initializeRoot && !initializeTree) return;
    patchDraft({
      subtree: {
        ...subtree,
        ...(initializeRoot ? { rootId: initialRoot } : {}),
        ...(initializeTree && path
          ? { treeRootId: path[0], expandedIds: [...new Set([...subtree.expandedIds, ...path])] }
          : {}),
      },
    });
  }, [available, initialRoot, cache, meta, subtree, patchDraft]);

  const topRootId = subtree.treeRootId;
  const activeRoot = subtree.rootId;
  const activeTitle = activeRoot
    ? cache[activeRoot]?.title || (meta?.id === activeRoot ? meta.title : activeRoot)
    : undefined;
  const loadedPages = useMemo(() => {
    if (!activeRoot) return { count: 0, complete: false };
    const visited = new Set<string>();
    const pending = [activeRoot];
    let complete = true;
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const node = cache[id];
      if (!node || (!node.childrenLoaded && node.hasChildren !== false)) complete = false;
      if (node) {
        for (const childId of node.childrenIds) pending.push(childId);
      }
    }
    return { count: visited.size, complete };
  }, [activeRoot, cache]);

  useEffect(() => {
    if (!available || !topRootId) return;
    const node = cache[topRootId];
    if (!node?.childrenLoaded) void ensureChildren(topRootId);
  }, [available, topRootId, cache, ensureChildren]);

  const clientFilter = useMemo(
    () =>
      topRootId
        ? computeClientFilter(cache, topRootId, filter)
        : { visibleIds: new Set<string>(), matchedIds: new Set<string>() },
    [cache, topRootId, filter],
  );

  const spaceKey =
    meta && (meta.id === topRootId || meta.ancestors?.some((ancestor) => ancestor.id === topRootId))
      ? meta.spaceKey
      : undefined;
  const hasMatches = clientFilter.matchedIds.size > 0;
  const searchContext = useRef({
    sourceKey,
    subtree,
    patchDraft,
    hasMatches,
  });
  useLayoutEffect(() => {
    searchContext.current = { sourceKey, subtree, patchDraft, hasMatches };
  }, [sourceKey, subtree, patchDraft, hasMatches]);

  useEffect(() => {
    const query = filter.trim();
    const current = searchContext.current;
    const previous = current.subtree.serverSearch;
    if (
      !available ||
      !query ||
      !topRootId ||
      current.hasMatches ||
      (previous.query === query && (previous.status === "done" || previous.status === "error"))
    ) {
      return;
    }
    let active = true;
    const timer = window.setTimeout(async () => {
      const context = searchContext.current;
      if (
        !active ||
        context.sourceKey !== sourceKey ||
        context.subtree.filter.trim() !== query ||
        context.hasMatches
      )
        return;
      context.patchDraft({
        subtree: {
          ...context.subtree,
          serverSearch: { status: "searching", query, count: 0 },
        },
      });
      try {
        const hits = await search(query, spaceKey);
        const latest = searchContext.current;
        if (!active || latest.sourceKey !== sourceKey || latest.subtree.filter.trim() !== query) {
          return;
        }
        latest.patchDraft({
          subtree: {
            ...latest.subtree,
            serverSearch: { status: "done", query, count: hits.length },
          },
        });
      } catch (error) {
        const latest = searchContext.current;
        if (!active || latest.sourceKey !== sourceKey || latest.subtree.filter.trim() !== query) {
          return;
        }
        latest.patchDraft({
          subtree: {
            ...latest.subtree,
            serverSearch: {
              status: "error",
              query,
              count: 0,
              error: error instanceof Error ? error.message : String(error),
            },
          },
        });
      }
    }, 500);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [filter, topRootId, available, sourceKey, spaceKey, search]);

  const subId = activeRoot ? makeSubscriptionId(host, activeRoot, "subtree") : null;
  const subscribed = Boolean(
    subId && subs.subscriptions.some((subscription) => subscription.id === subId),
  );

  const handleSelect = (id: string) => {
    if (draftLocked) return;
    patchDraft({ subtree: { ...subtree, rootId: id } });
  };

  const handleNavigate = (id: string) => {
    if (!available || !source) return;
    void BrowserApi.updateTab(source.tabId, { url: buildPageUrl(source.baseUrl, id) });
  };

  const handleExpand = (id: string) => {
    if (available) void ensureChildren(id);
  };

  const filterActive = filter.trim().length > 0;
  const showServerSearching =
    serverSearchState.status === "searching" && clientFilter.matchedIds.size === 0;
  const showNoResults =
    filterActive &&
    clientFilter.matchedIds.size === 0 &&
    serverSearchState.status === "done" &&
    serverSearchState.count === 0;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {topRootId ? (
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <Label>{t("subtree.title")}</Label>
            <button
              type="button"
              onClick={async () => {
                await reset();
                if (available && activeRoot) await ensurePathWithChildren(activeRoot);
              }}
              className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              title={t("subtree.resetCacheTitle")}
              aria-label={t("subtree.resetCacheTitle")}
              disabled={!available}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>

          <div className="relative min-w-0">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              aria-label={t("subtree.filterPlaceholder")}
              onChange={(event) =>
                patchDraft({
                  subtree: {
                    ...subtree,
                    filter: event.target.value,
                    serverSearch: { status: "idle", query: "", count: 0 },
                  },
                })
              }
              placeholder={t("subtree.filterPlaceholder")}
              className="pl-7 pr-7"
            />
            {filter && (
              <button
                type="button"
                onClick={() =>
                  patchDraft({
                    subtree: {
                      ...subtree,
                      filter: "",
                      serverSearch: { status: "idle", query: "", count: 0 },
                    },
                  })
                }
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                title={t("subtree.clearFilterTitle")}
                aria-label={t("subtree.clearFilterTitle")}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          {showServerSearching && (
            <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("subtree.searchingServer")}
            </div>
          )}
          {showNoResults && (
            <div className="px-2 py-1 text-xs text-muted-foreground">{t("subtree.noResults")}</div>
          )}
          {serverSearchState.status === "error" && (
            <div role="alert" className="px-2 py-1 text-xs text-destructive">
              {serverSearchState.error}
            </div>
          )}

          <TreeView
            nodes={cache}
            rootId={topRootId}
            selectedId={activeRoot}
            expandedIds={subtree.expandedIds}
            onExpandedChange={(expandedIds) => patchDraft({ subtree: { ...subtree, expandedIds } })}
            selectionDisabled={draftLocked}
            navigationDisabled={!available}
            filter={filter}
            loadingIds={loadingIds}
            visibleIds={filterActive ? clientFilter.visibleIds : null}
            matchedIds={filterActive ? clientFilter.matchedIds : null}
            onSelect={handleSelect}
            onExpand={handleExpand}
            onNavigate={handleNavigate}
          />
        </div>
      ) : (
        <Card className="flex-1 border-primary/30 bg-primary/5">
          <CardContent className="flex h-full items-center p-4 text-xs text-muted-foreground">
            <div className="flex min-w-0 items-start gap-3">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface">
                <FolderDown className="h-4 w-4 text-primary" />
              </div>
              <div className="min-w-0 space-y-1">
                <div className="font-medium text-foreground">{t("subtree.unavailableTitle")}</div>
                <div>{t("subtree.unavailableDescription")}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="min-w-0 shrink-0 space-y-3">
        <div className="rounded-md border bg-muted/40 p-2 text-xs">
          <p className="break-words font-medium" data-export-root={activeRoot}>
            {t("composer.selectedRoot", { title: activeTitle ?? t("subtree.extractDefault") })}
          </p>
          <p className="mt-1 text-muted-foreground">{t("composer.rootHelp")}</p>
          <p className="mt-1 text-muted-foreground">
            {t(loadedPages.complete ? "composer.discoveredPages" : "composer.loadedPages", {
              count: loadedPages.count,
            })}
          </p>
        </div>

        <Button
          variant="outline"
          className="w-full"
          disabled={
            !activeRoot || !available || subs.subscribing || subscribed || Boolean(subs.error)
          }
          onClick={() =>
            activeRoot &&
            available &&
            subs.subscribe({
              host,
              rootId: activeRoot,
              scope: "subtree",
            })
          }
        >
          {subs.subscribing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : subscribed ? (
            <BellRing className="h-4 w-4" />
          ) : (
            <Bell className="h-4 w-4" />
          )}
          {subscribed
            ? t("subtree.subscriptionActive")
            : activeTitle
              ? t("subtree.subscribeNamed", { title: activeTitle })
              : t("subtree.subscribeDefault")}
        </Button>
        {subs.error && (
          <p role="alert" className="text-xs text-destructive">
            {subs.error.message}
          </p>
        )}
      </div>
    </div>
  );
}
