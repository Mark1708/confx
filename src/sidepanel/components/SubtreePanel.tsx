import {
	Bell,
	BellRing,
	FolderDown,
	Loader2,
	Search,
	Trash2,
	X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { BrowserApi } from "@/lib/browser/browser-api";
import { makeSubscriptionId } from "@/lib/subscriptions";
import type { HostCache } from "@/lib/tree-cache";
import type { CurrentTabInfo } from "../hooks/useCurrentTab";
import { useExtractJob } from "../hooks/useExtractJob";
import { usePageInfo } from "../hooks/usePageInfo";
import { useSettings } from "../hooks/useSettings";
import { useSubscriptions } from "../hooks/useSubscriptions";
import { useTreeStore } from "../hooks/useTreeStore";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { JobStatus } from "./JobStatus";
import { PresetSelector } from "./PresetSelector";
import { TreeView } from "./TreeView";

function findTopRoot(nodes: HostCache, pageId: string): string {
	let cursor = pageId;
	const seen = new Set<string>();
	while (true) {
		if (seen.has(cursor)) return cursor;
		seen.add(cursor);
		const parent = nodes[cursor]?.parentId;
		if (!parent) return cursor;
		cursor = parent;
	}
}

function buildPageUrl(host: string, pageId: string): string {
	const base = host.replace(/\/$/, "");
	return `${base}/pages/viewpage.action?pageId=${pageId}`;
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
function computeClientFilter(
	nodes: HostCache,
	rootId: string,
	query: string,
): FilterResult {
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
	const info = usePageInfo(tab.host, tab.pageId);
	const { data: settings, update } = useSettings();
	const { state, run, cancel } = useExtractJob();
	const [filter, setFilter] = useState("");
	const [serverSearchState, setServerSearchState] = useState<
		| { status: "idle" }
		| { status: "searching" }
		| { status: "done"; query: string; count: number }
		| { status: "error"; message: string }
	>({ status: "idle" });
	const subs = useSubscriptions();
	const {
		cache,
		loadingIds,
		ensureChildren,
		ensurePathWithChildren,
		reset,
		search,
	} = useTreeStore(tab.host);

	const currentPageId = info.data?.meta?.id;

	useEffect(() => {
		if (!tab.host || !currentPageId) return;
		void ensurePathWithChildren(currentPageId);
	}, [tab.host, currentPageId, ensurePathWithChildren]);

	const [stickyRootId, setStickyRootId] = useState<string | undefined>(
		undefined,
	);

	useEffect(() => {
		if (!tab.host) return;
		setStickyRootId(undefined);
	}, [tab.host]);

	useEffect(() => {
		if (!currentPageId) return;
		const cached = cache[currentPageId];
		let candidate: string | undefined;
		if (cached?.title) {
			candidate = findTopRoot(cache, currentPageId);
		} else if (info.data?.meta?.ancestors !== undefined) {
			const anc = info.data.meta.ancestors;
			candidate = anc.length > 0 ? anc[0].id : currentPageId;
		}
		if (candidate && candidate !== stickyRootId) setStickyRootId(candidate);
	}, [currentPageId, info.data, cache, stickyRootId]);

	const topRootId = stickyRootId;

	useEffect(() => {
		if (!topRootId) return;
		const node = cache[topRootId];
		if (!node?.childrenLoaded) void ensureChildren(topRootId);
	}, [topRootId, cache, ensureChildren]);

	const activeRoot = currentPageId;
	const activeTitle = activeRoot
		? (cache[activeRoot]?.title ?? info.data?.meta?.title)
		: undefined;

	useEffect(() => {
		if (!tab.host) return;
		setFilter("");
		setServerSearchState({ status: "idle" });
	}, [tab.host]);

	const clientFilter = useMemo(
		() =>
			topRootId
				? computeClientFilter(cache, topRootId, filter)
				: { visibleIds: new Set<string>(), matchedIds: new Set<string>() },
		[cache, topRootId, filter],
	);

	const spaceKey = info.data?.meta?.spaceKey;
	const searchedQueryRef = useRef<string | null>(null);
	const serverTimer = useRef<number | null>(null);

	useEffect(() => {
		if (serverTimer.current) {
			clearTimeout(serverTimer.current);
			serverTimer.current = null;
		}
		const q = filter.trim();
		if (!q || !topRootId) {
			setServerSearchState({ status: "idle" });
			searchedQueryRef.current = null;
			return;
		}
		if (clientFilter.matchedIds.size > 0) {
			setServerSearchState({ status: "idle" });
			return;
		}
		if (searchedQueryRef.current === q) {
			return;
		}
		serverTimer.current = setTimeout(async () => {
			searchedQueryRef.current = q;
			setServerSearchState({ status: "searching" });
			try {
				const hits = await search(q, spaceKey);
				setServerSearchState({ status: "done", query: q, count: hits.length });
			} catch (e) {
				setServerSearchState({
					status: "error",
					message: e instanceof Error ? e.message : String(e),
				});
			}
		}, 500) as unknown as number;
		return () => {
			if (serverTimer.current) {
				clearTimeout(serverTimer.current);
				serverTimer.current = null;
			}
		};
	}, [filter, topRootId, clientFilter, search, spaceKey]);

	const preset = settings?.activePresetId ?? "ui-component";

	const subId =
		tab.host && activeRoot
			? makeSubscriptionId(tab.host, activeRoot, "subtree")
			: null;
	const subscribed = Boolean(
		subId && subs.subscriptions.some((s) => s.id === subId),
	);

	const handleSelect = (id: string) => {
		if (!tab.host || !tab.tabId) return;
		if (id === currentPageId) return;
		void ensurePathWithChildren(id);
		void BrowserApi.updateTab(tab.tabId, { url: buildPageUrl(tab.host, id) });
	};

	const handleExpand = (id: string) => {
		void ensureChildren(id);
	};

	const filterActive = filter.trim().length > 0;
	const showServerSearching =
		serverSearchState.status === "searching" &&
		clientFilter.matchedIds.size === 0;
	const showNoResults =
		filterActive &&
		clientFilter.matchedIds.size === 0 &&
		serverSearchState.status === "done" &&
		serverSearchState.count === 0;

	return (
		<div className="flex h-full min-h-0 min-w-0 flex-col gap-3">
			{tab.host && topRootId ? (
				<div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1">
					<div className="flex min-w-0 items-center justify-between gap-2">
						<Label>Дерево страниц</Label>
						<button
							type="button"
							onClick={() => void reset()}
							className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
							title="Сбросить кэш дерева для этого хоста"
						>
							<Trash2 className="h-3 w-3" />
						</button>
					</div>

					<div className="relative min-w-0">
						<Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
						<Input
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
							placeholder="Фильтр по названию…"
							className="pl-7 pr-7"
						/>
						{filter && (
							<button
								type="button"
								onClick={() => setFilter("")}
								className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
								title="Очистить фильтр"
							>
								<X className="h-3 w-3" />
							</button>
						)}
					</div>

					{showServerSearching && (
						<div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
							<Loader2 className="h-3 w-3 animate-spin" />
							Ищу на сервере…
						</div>
					)}
					{showNoResults && (
						<div className="px-2 py-1 text-xs text-muted-foreground">
							Ничего не найдено
						</div>
					)}
					{serverSearchState.status === "error" && (
						<div className="px-2 py-1 text-xs text-destructive">
							{serverSearchState.message}
						</div>
					)}

					<TreeView
						nodes={cache}
						rootId={topRootId}
						selectedId={activeRoot}
						filter={filter}
						loadingIds={loadingIds}
						visibleIds={filterActive ? clientFilter.visibleIds : null}
						matchedIds={filterActive ? clientFilter.matchedIds : null}
						onSelect={handleSelect}
						onExpand={handleExpand}
					/>
				</div>
			) : (
				<Card className="flex-1 border-primary/30 bg-primary/5">
					<CardContent className="flex h-full items-center p-4 text-xs text-muted-foreground">
					<div className="flex min-w-0 items-start gap-3">
							<div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface shadow-[0_0_16px_hsl(var(--accent-glow))]">
								<FolderDown className="h-4 w-4 text-primary" />
							</div>
							<div className="min-w-0 space-y-1">
								<div className="font-medium text-foreground">
									Дерево недоступно
								</div>
								<div>
									Откройте страницу Confluence, чтобы построить поддерево и
									выбрать корень выгрузки.
								</div>
							</div>
						</div>
					</CardContent>
				</Card>
			)}

			<div className="min-w-0 shrink-0 space-y-3">
				<div className="space-y-1">
					<Label>Пресет</Label>
					<PresetSelector
						value={preset}
						onChange={(id) => update({ activePresetId: id })}
					/>
				</div>

				<Button
					className="w-full"
					disabled={!activeRoot || !tab.host || state?.status === "running"}
					onClick={() =>
						activeRoot &&
						tab.host &&
						run({
							kind: "extract-subtree",
							rootPageId: activeRoot,
							host: tab.host,
							presetId: preset,
						})
					}
				>
					<FolderDown className="h-4 w-4" />
					{activeTitle ? `Извлечь «${activeTitle}»` : "Извлечь поддерево"}
				</Button>

				<Button
					variant="outline"
					className="w-full"
					disabled={!activeRoot || !tab.host || subs.subscribing || subscribed}
					onClick={() =>
						activeRoot &&
						tab.host &&
						subs.subscribe({
							host: tab.host,
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
						? "Подписка активна"
						: activeTitle
							? `Подписаться на «${activeTitle}»`
							: "Подписаться на поддерево"}
				</Button>

				<JobStatus state={state} onCancel={cancel} />
			</div>
		</div>
	);
}
