import { ChevronRight, ExternalLink, FileText, Folder, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/cn";
import type { HostCache } from "@/lib/tree-cache";
import { useI18n } from "../hooks/useI18n";

interface Props {
  nodes: HostCache;
  rootId: string;
  selectedId?: string;
  expandedIds: readonly string[];
  onExpandedChange: (ids: string[]) => void;
  selectionDisabled?: boolean;
  navigationDisabled?: boolean;
  filter?: string;
  loadingIds?: ReadonlySet<string>;
  visibleIds?: Set<string> | null;
  matchedIds?: Set<string> | null;
  onSelect: (id: string, title: string) => void;
  onExpand: (id: string) => void;
  onNavigate: (id: string) => void;
}

function highlight(title: string, needle: string): React.ReactNode {
  if (!needle) return title;
  const lower = title.toLowerCase();
  const q = needle.toLowerCase();
  const i = lower.indexOf(q);
  if (i === -1) return title;
  return (
    <>
      {title.slice(0, i)}
      <mark className="bg-yellow-200/70 px-0 text-inherit dark:bg-yellow-500/30">
        {title.slice(i, i + q.length)}
      </mark>
      {title.slice(i + q.length)}
    </>
  );
}

export function TreeView({
  nodes,
  rootId,
  selectedId,
  expandedIds,
  onExpandedChange,
  selectionDisabled = false,
  navigationDisabled = false,
  filter,
  loadingIds,
  visibleIds,
  matchedIds,
  onSelect,
  onExpand,
  onNavigate,
}: Props) {
  const { t } = useI18n();
  const expanded = useMemo(() => new Set(expandedIds), [expandedIds]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const selectedRef = useRef<HTMLDivElement | null>(null);
  const lastScrolledSelectionRef = useRef<string | null>(null);
  const lastScrolledFilterRef = useRef<string>("");

  const filterExpandedIds = useMemo(() => {
    const ids = new Set<string>();
    if (!visibleIds || !matchedIds) return ids;
    for (const id of visibleIds) {
      const parentId = nodes[id]?.parentId;
      if (parentId && visibleIds.has(parentId)) ids.add(parentId);
    }
    return ids;
  }, [visibleIds, matchedIds, nodes]);

  const needle = useMemo(() => filter?.trim().toLowerCase() ?? "", [filter]);

  const visibleChildrenByParent = useMemo(() => {
    if (!visibleIds) return null;
    const map = new Map<string, string[]>();
    for (const id of visibleIds) {
      const parentId = nodes[id]?.parentId;
      if (!parentId) continue;
      const list = map.get(parentId);
      if (list) list.push(id);
      else map.set(parentId, [id]);
    }
    return map;
  }, [visibleIds, nodes]);

  const toggle = (id: string) => {
    const node = nodes[id];
    const willExpand = !expanded.has(id);
    const next = new Set(expanded);
    if (willExpand) next.add(id);
    else next.delete(id);
    onExpandedChange([...next]);
    if (willExpand && node && node.hasChildren !== false && !node.childrenLoaded) {
      onExpand(id);
    }
  };

  const scrollTo = (target: HTMLElement | null) => {
    const container = containerRef.current;
    if (!target || !container) return;
    const cRect = container.getBoundingClientRect();
    const tRect = target.getBoundingClientRect();
    const offset = tRect.top - cRect.top;
    const center = offset - container.clientHeight / 2 + target.clientHeight / 2;
    container.scrollTo({
      top: container.scrollTop + center,
      behavior: "smooth",
    });
  };

  useEffect(() => {
    const currentFilter = needle;
    const needsForSelection = !!selectedId && lastScrolledSelectionRef.current !== selectedId;
    const needsForFilter = !!currentFilter && lastScrolledFilterRef.current !== currentFilter;
    if (!needsForSelection && !needsForFilter) return;

    const firstMatch = currentFilter
      ? containerRef.current?.querySelector<HTMLElement>('[data-tree-match="true"]')
      : null;
    const target =
      (needsForSelection ? selectedRef.current : null) ?? firstMatch ?? selectedRef.current;
    if (!target) return;

    if (needsForSelection && selectedId) lastScrolledSelectionRef.current = selectedId;
    if (needsForFilter) lastScrolledFilterRef.current = currentFilter;
    scrollTo(target);
  });

  useEffect(() => {
    if (lastScrolledSelectionRef.current !== selectedId) {
      lastScrolledSelectionRef.current = null;
    }
  }, [selectedId]);
  useEffect(() => {
    if (lastScrolledFilterRef.current !== needle) {
      lastScrolledFilterRef.current = "";
    }
  }, [needle]);

  const root = nodes[rootId];
  if (!root) {
    return (
      <div className="space-y-2 rounded-md border border-border bg-surface p-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <Loader2 className="h-3 w-3 animate-spin text-primary" />
          {t("sidepanel.tree.loadingRoot")}
        </div>
        <div className="h-7 w-full animate-pulse rounded bg-muted" />
        <div className="h-7 w-5/6 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  const renderNode = (id: string, depth: number): React.ReactNode => {
    const node = nodes[id];
    if (!node) return null;
    if (visibleIds && !visibleIds.has(id)) return null;

    const isLoading = loadingIds?.has(id) ?? false;
    const filterExpanded = filterExpandedIds.has(id);
    const isExpanded = expanded.has(id) || filterExpanded;
    const selected = selectedId === id;
    // Only mark as leaf when we're certain there are no children. When
    // hasChildren is unknown (undefined) we stay optimistic and render as
    // a folder — this prevents the icon from flipping after a lazy probe.
    const isLeaf = node.hasChildren === false && node.childrenIds.length === 0;
    const showChevron = !isLeaf || isLoading;
    const isMatch = matchedIds ? matchedIds.has(id) : true;

    let childrenToRender: string[];
    if (visibleChildrenByParent && visibleIds) {
      const seen = new Set<string>();
      childrenToRender = [];
      for (const cid of node.childrenIds) {
        if (visibleIds.has(cid)) {
          childrenToRender.push(cid);
          seen.add(cid);
        }
      }
      const extras = visibleChildrenByParent.get(id);
      if (extras) {
        for (const cid of extras) {
          if (!seen.has(cid)) {
            childrenToRender.push(cid);
            seen.add(cid);
          }
        }
      }
    } else {
      childrenToRender = node.childrenIds;
    }

    return (
      <div key={id} className="min-w-0">
        <div
          ref={(el) => {
            if (selected) selectedRef.current = el;
          }}
          data-tree-match={matchedIds && isMatch ? "true" : undefined}
          className={cn(
            "flex items-center gap-1 rounded px-1 py-1 text-xs transition-colors hover:bg-accent",
            selected &&
              "bg-primary/20 font-semibold text-foreground ring-1 ring-primary/50 hover:bg-primary/25",
          )}
          style={{ paddingLeft: `${Math.min(depth, 8) * 10 + 4}px` }}
        >
          {showChevron ? (
            <button
              type="button"
              className="grid h-6 w-6 shrink-0 place-items-center text-muted-foreground hover:text-foreground disabled:opacity-50"
              aria-expanded={isExpanded}
              aria-label={t(isExpanded ? "sidepanel.tree.collapse" : "sidepanel.tree.expand", {
                title: node.title,
              })}
              title={filterExpanded ? t("sidepanel.tree.filterExpanded") : undefined}
              disabled={filterExpanded}
              onClick={(e) => {
                e.stopPropagation();
                toggle(id);
              }}
            >
              {isLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <ChevronRight
                  className={cn("h-3 w-3 transition-transform", isExpanded && "rotate-90")}
                />
              )}
            </button>
          ) : (
            <span className="w-6 shrink-0" />
          )}
          <button
            type="button"
            className={cn(
              "flex min-h-6 min-w-0 flex-1 cursor-pointer items-center gap-1 text-left disabled:cursor-default disabled:opacity-50",
              matchedIds && !isMatch && "text-muted-foreground",
            )}
            aria-pressed={selected}
            disabled={selectionDisabled}
            onClick={() => onSelect(id, node.title)}
          >
            {isLeaf ? (
              <FileText
                className={cn(
                  "h-3 w-3 shrink-0",
                  selected ? "text-primary" : "text-muted-foreground",
                )}
              />
            ) : (
              <Folder
                className={cn(
                  "h-3 w-3 shrink-0",
                  selected ? "text-primary" : "text-muted-foreground",
                )}
              />
            )}
            <span className="min-w-0 truncate">
              {needle && isMatch ? highlight(node.title, needle) : node.title}
            </span>
          </button>
          <button
            type="button"
            className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
            aria-label={t("subtree.openPage", { title: node.title })}
            disabled={navigationDisabled}
            onClick={() => onNavigate(id)}
          >
            <ExternalLink className="h-3 w-3" />
          </button>
        </div>
        {isExpanded && childrenToRender.map((cid) => renderNode(cid, depth + 1))}
        {isExpanded && !childrenToRender.length && !isLeaf && !isLoading && (
          <div
            className="rounded px-1 py-1 text-[11px] text-muted-foreground"
            style={{ paddingLeft: `${Math.min(depth + 1, 8) * 10 + 4}px` }}
          >
            {t("sidepanel.tree.noLoadedChildren")}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      ref={containerRef}
      className="max-h-96 min-h-0 min-w-0 flex-1 space-y-1 overflow-auto rounded-md border border-border bg-surface p-1"
    >
      {renderNode(rootId, 0)}
    </div>
  );
}
