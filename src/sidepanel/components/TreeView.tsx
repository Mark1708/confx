import { ChevronRight, FileText, Folder, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import type { HostCache } from "@/lib/tree-cache";

interface Props {
	nodes: HostCache;
	rootId: string;
	selectedId?: string;
	filter?: string;
	loadingIds?: ReadonlySet<string>;
	visibleIds?: Set<string> | null;
	matchedIds?: Set<string> | null;
	onSelect: (id: string, title: string) => void;
	onExpand: (id: string) => void;
}

function pathToNode(
	nodes: HostCache,
	targetId: string,
	rootId: string,
): string[] | null {
	const chain: string[] = [];
	let cursor: string | undefined = targetId;
	const seen = new Set<string>();
	while (cursor) {
		if (seen.has(cursor)) return null;
		seen.add(cursor);
		chain.unshift(cursor);
		if (cursor === rootId) return chain;
		cursor = nodes[cursor]?.parentId;
	}
	return null;
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
	filter,
	loadingIds,
	visibleIds,
	matchedIds,
	onSelect,
	onExpand,
}: Props) {
	const [expanded, setExpanded] = useState<Set<string>>(
		() => new Set([rootId]),
	);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const selectedRef = useRef<HTMLDivElement | null>(null);
	const firstMatchRef = useRef<HTMLDivElement | null>(null);
	const firstMatchAssignedRef = useRef(false);
	const lastScrolledSelectionRef = useRef<string | null>(null);
	const lastScrolledFilterRef = useRef<string>("");

	useEffect(() => {
		setExpanded((prev) =>
			prev.has(rootId) ? prev : new Set([rootId, ...prev]),
		);
	}, [rootId]);

	useEffect(() => {
		if (!selectedId) return;
		const p = pathToNode(nodes, selectedId, rootId);
		if (!p) return;
		setExpanded((prev) => {
			const next = new Set(prev);
			for (const id of p) next.add(id);
			return next;
		});
	}, [selectedId, nodes, rootId]);

	useEffect(() => {
		if (!visibleIds || !matchedIds) return;
		setExpanded((prev) => {
			const next = new Set(prev);
			for (const id of visibleIds) {
				if (!matchedIds.has(id) || nodes[id]?.childrenIds.length) next.add(id);
			}
			return next;
		});
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
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
		if (
			willExpand &&
			node &&
			node.hasChildren !== false &&
			!node.childrenLoaded
		) {
			onExpand(id);
		}
	};

	const scrollTo = (target: HTMLElement | null) => {
		const container = containerRef.current;
		if (!target || !container) return;
		const cRect = container.getBoundingClientRect();
		const tRect = target.getBoundingClientRect();
		const offset = tRect.top - cRect.top;
		const center =
			offset - container.clientHeight / 2 + target.clientHeight / 2;
		container.scrollTo({
			top: container.scrollTop + center,
			behavior: "smooth",
		});
	};

	useEffect(() => {
		const currentFilter = needle;
		const needsForSelection =
			!!selectedId && lastScrolledSelectionRef.current !== selectedId;
		const needsForFilter =
			!!currentFilter && lastScrolledFilterRef.current !== currentFilter;
		if (!needsForSelection && !needsForFilter) return;

		const target =
			(needsForSelection ? selectedRef.current : null) ??
			(currentFilter ? firstMatchRef.current : null) ??
			selectedRef.current ??
			firstMatchRef.current;
		if (!target) return;

		if (needsForSelection && selectedId)
			lastScrolledSelectionRef.current = selectedId;
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
					Загрузка корня…
				</div>
				<div className="h-7 w-full animate-pulse rounded bg-muted" />
				<div className="h-7 w-5/6 animate-pulse rounded bg-muted" />
			</div>
		);
	}

	firstMatchAssignedRef.current = false;

	const renderNode = (id: string, depth: number): React.ReactNode => {
		const node = nodes[id];
		if (!node) return null;
		if (visibleIds && !visibleIds.has(id)) return null;

		const isLoading = loadingIds?.has(id) ?? false;
		const isExpanded = expanded.has(id);
		const selected = selectedId === id;
		// Only mark as leaf when we're certain there are no children. When
		// hasChildren is unknown (undefined) we stay optimistic and render as
		// a folder — this prevents the icon from flipping after a lazy probe.
		const isLeaf = node.hasChildren === false && node.childrenIds.length === 0;
		const showChevron = !isLeaf || isLoading;
		const isMatch = matchedIds ? matchedIds.has(id) : true;
		const shouldAssignFirstMatch =
			!!matchedIds && isMatch && !firstMatchAssignedRef.current;
		if (shouldAssignFirstMatch) firstMatchAssignedRef.current = true;

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
						if (shouldAssignFirstMatch) firstMatchRef.current = el;
					}}
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
							className="grid h-4 w-4 place-items-center text-muted-foreground hover:text-foreground"
							onClick={(e) => {
								e.stopPropagation();
								toggle(id);
							}}
						>
							{isLoading ? (
								<Loader2 className="h-3 w-3 animate-spin" />
							) : (
								<ChevronRight
									className={cn(
										"h-3 w-3 transition-transform",
										isExpanded && "rotate-90",
									)}
								/>
							)}
						</button>
					) : (
						<span className="w-4" />
					)}
					<button
						type="button"
						className={cn(
							"flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left",
							matchedIds && !isMatch && "text-muted-foreground",
						)}
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
				</div>
				{isExpanded &&
					childrenToRender.map((cid) => renderNode(cid, depth + 1))}
				{isExpanded && !childrenToRender.length && !isLeaf && !isLoading && (
					<div
						className="rounded px-1 py-1 text-[11px] text-muted-foreground"
						style={{ paddingLeft: `${Math.min(depth + 1, 8) * 10 + 4}px` }}
					>
						Нет загруженных дочерних страниц
					</div>
				)}
			</div>
		);
	};

	return (
		<div
			ref={containerRef}
			className="min-h-0 min-w-0 flex-1 space-y-1 overflow-auto rounded-md border border-border bg-surface p-1"
		>
			{renderNode(rootId, 0)}
		</div>
	);
}
