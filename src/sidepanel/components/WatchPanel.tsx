import {
	ArrowRightLeft,
	Bell,
	CheckCircle2,
	Download,
	FileText,
	FolderTree,
	Loader2,
	Minus,
	PencilLine,
	Plus,
	RefreshCw,
	Trash2,
	XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import type {
	DiffEntry,
	Subscription,
	SubscriptionDiff,
} from "@/lib/subscriptions";
import { useExtractJob } from "../hooks/useExtractJob";
import { useSettings } from "../hooks/useSettings";
import {
	useCheckSubscription,
	useSubscriptions,
} from "../hooks/useSubscriptions";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Progress } from "../ui/progress";
import { Separator } from "../ui/separator";

export function WatchPanel() {
	const { subscriptions, loading, remove } = useSubscriptions();
	const [expandedId, setExpandedId] = useState<string | null>(null);

	if (loading) {
		return (
			<div className="min-w-0 space-y-3">
				<h2 className="text-sm font-semibold">Подписки</h2>
				<Card>
					<CardContent className="space-y-3 p-3 text-xs text-muted-foreground">
						<div className="flex items-center gap-2">
							<Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
							Загрузка подписок…
						</div>
						<div className="space-y-2">
							<div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
							<div className="h-8 w-full animate-pulse rounded-md bg-muted" />
						</div>
					</CardContent>
				</Card>
			</div>
		);
	}

	if (!subscriptions.length) {
		return (
			<div className="min-w-0 space-y-3">
				<h2 className="text-sm font-semibold">Подписки</h2>
				<Card className="border-primary/30 bg-primary/5">
          <CardContent className="space-y-3 p-3 text-xs text-muted-foreground wide-panel:p-4">
            <div className="flex min-w-0 items-start gap-2 wide-panel:gap-3">
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface shadow-[0_0_16px_hsl(var(--accent-glow))] wide-panel:h-9 wide-panel:w-9">
								<Bell className="h-4 w-4 text-primary" />
							</div>
							<div className="min-w-0 space-y-1">
								<div className="font-medium text-foreground">
									Нет активных подписок
								</div>
								<p>
									Перейдите во вкладку <b>Страница</b> или <b>Дерево</b> и
									нажмите «Подписаться», чтобы отслеживать изменения.
								</p>
							</div>
						</div>
					</CardContent>
				</Card>
			</div>
		);
	}

	return (
		<div className="min-w-0 space-y-3">
			<h2 className="text-sm font-semibold">
				Подписки
				<Badge className="ml-2" variant="secondary">
					{subscriptions.length}
				</Badge>
			</h2>

			{subscriptions.map((sub) => (
				<SubscriptionRow
					key={sub.id}
					sub={sub}
					expanded={expandedId === sub.id}
					onToggle={() =>
						setExpandedId((id) => (id === sub.id ? null : sub.id))
					}
					onDelete={() => remove(sub.id)}
				/>
			))}
		</div>
	);
}

interface RowProps {
	sub: Subscription;
	expanded: boolean;
	onToggle: () => void;
	onDelete: () => void;
}

function SubscriptionRow({ sub, expanded, onToggle, onDelete }: RowProps) {
	const check = useCheckSubscription();
	const total = Object.keys(sub.snapshot).length;
	const pendingChanges =
		(sub.lastDiffSummary?.added ?? 0) +
		(sub.lastDiffSummary?.removed ?? 0) +
		(sub.lastDiffSummary?.changed ?? 0) +
		(sub.lastDiffSummary?.moved ?? 0);

	return (
		<Card>
			<CardHeader className="pb-2">
				<div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
					<div className="min-w-0 flex-1 space-y-1">
						<CardTitle className="flex min-w-0 items-center gap-2">
							{sub.scope === "subtree" ? (
								<FolderTree className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
							) : (
								<FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
							)}
							<button
								type="button"
								onClick={onToggle}
								className="min-w-0 line-clamp-2 text-left hover:underline"
							>
								{sub.rootTitle}
							</button>
						</CardTitle>
						<CardDescription className="break-words">
							{pendingChanges > 0
								? "Есть изменения после последней проверки"
								: "Нет ожидающих изменений"}
						</CardDescription>
					</div>
					{sub.spaceKey && (
              <Badge className="ml-auto max-w-[4.5rem] shrink-0 truncate wide-panel:max-w-[6rem]" variant="outline">
							{sub.spaceKey}
						</Badge>
					)}
				</div>
			</CardHeader>
			<CardContent className="space-y-2 p-3 pt-0 text-[11px]">
				<div className="flex min-w-0 flex-wrap items-center gap-1 text-muted-foreground">
					<Badge variant="secondary">
						{sub.scope === "subtree" ? "поддерево" : "страница"}
					</Badge>
					<Badge variant="secondary">{total} стр.</Badge>
					{pendingChanges > 0 ? (
						<Badge variant="default">+{pendingChanges} изменений</Badge>
					) : (
						<Badge variant="success">актуально</Badge>
					)}
                <span className="min-w-0 break-all font-mono text-[10px] wide-panel:ml-auto">
						{sub.lastCheckedAt ? formatDate(sub.lastCheckedAt) : "ни разу"}
					</span>
				</div>

				<div className="flex flex-wrap gap-2">
					<Button
						size="sm"
						variant="outline"
						className="min-w-[6.5rem] flex-1"
						disabled={check.state.running}
						onClick={() => check.run(sub)}
					>
						{check.state.running ? (
							<Loader2 className="h-3 w-3 animate-spin" />
						) : (
							<RefreshCw className="h-3 w-3" />
						)}
						Проверить
					</Button>
					<Button
						size="sm"
						variant="ghost"
						onClick={onDelete}
						title="Удалить подписку"
					>
						<Trash2 className="h-3 w-3" />
					</Button>
				</div>

				{check.state.running && (
					<div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-2">
						<div className="flex min-w-0 items-center gap-2 text-xs">
							<Loader2 className="h-3 w-3 animate-spin" />
							<span className="min-w-0 flex-1 truncate">
								{check.state.message}
							</span>
							<span className="font-mono text-muted-foreground">
								{check.state.visited}
							</span>
						</div>
						<Progress
							value={Math.min(
								100,
								(check.state.visited / Math.max(total, 1)) * 100,
							)}
						/>
					</div>
				)}

				{check.state.error && (
					<div className="flex min-w-0 items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
						<XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
						<span className="min-w-0 break-words">{check.state.error}</span>
					</div>
				)}

				{check.state.diff && (
					<DiffView
						sub={sub}
						diff={check.state.diff}
						onAccept={check.accept}
						onClose={check.reset}
					/>
				)}

				{expanded && !check.state.diff && !check.state.running && (
					<LastSummary sub={sub} />
				)}
			</CardContent>
		</Card>
	);
}

function LastSummary({ sub }: { sub: Subscription }) {
	const s = sub.lastDiffSummary;
	return (
		<div className="min-w-0 rounded-md border border-border/60 bg-muted/30 p-2 text-[10px] text-muted-foreground">
			<div>
				ID: <span className="break-all font-mono">{sub.rootId}</span>
			</div>
			<div>Создано: {formatDate(sub.createdAt)}</div>
			{s && (
				<div className="mt-1">
					Последняя проверка: +{s.added} / −{s.removed} / ~{s.changed} / ⇄
					{s.moved}
				</div>
			)}
		</div>
	);
}

interface DiffProps {
	sub: Subscription;
	diff: SubscriptionDiff;
	onAccept: () => void;
	onClose: () => void;
}

function DiffView({ sub, diff, onAccept, onClose }: DiffProps) {
	const { data: settings } = useSettings();
	const preset = settings?.activePresetId ?? "ui-component";
	const extract = useExtractJob();

	const downloadable = useMemo(() => [...diff.added, ...diff.changed], [diff]);
	const [selected, setSelected] = useState<Set<string>>(
		() => new Set(downloadable.map((e) => e.pageId)),
	);
	const toggle = (id: string) =>
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	const total =
		diff.added.length +
		diff.removed.length +
		diff.changed.length +
		diff.moved.length;
	if (total === 0) {
		return (
			<div className="flex items-center gap-2 rounded-md border border-success/30 bg-success/5 p-2 text-xs">
				<CheckCircle2 className="h-3.5 w-3.5 text-success" />
				<span className="flex-1">Изменений нет.</span>
				<Button size="sm" variant="ghost" onClick={onClose}>
					OK
				</Button>
			</div>
		);
	}

	const downloadSelected = async () => {
		for (const entry of downloadable) {
			if (!selected.has(entry.pageId)) continue;
			await extract.run({
				kind: "extract-page",
				pageId: entry.pageId,
				host: sub.host,
				presetId: preset,
			});
		}
	};

	return (
		<div className="min-w-0 space-y-2 rounded-md border border-border bg-background p-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs wide-panel:gap-2">
				<span className="font-medium">Что изменилось</span>
				<span className="font-mono text-muted-foreground">{total}</span>
				<span className="ml-auto flex min-w-0 flex-wrap gap-1">
					<Button size="sm" variant="accent" onClick={onAccept}>
						Принять
					</Button>
					<Button size="sm" variant="ghost" onClick={onClose}>
						Закрыть
					</Button>
				</span>
			</div>
			<Separator />

			<DiffSection
				label="Добавлено"
				icon={<Plus className="h-3 w-3 text-emerald-600" />}
				entries={diff.added}
				selectable
				selected={selected}
				onToggle={toggle}
			/>
			<DiffSection
				label="Изменено"
				icon={<PencilLine className="h-3 w-3 text-amber-600" />}
				entries={diff.changed}
				selectable
				selected={selected}
				onToggle={toggle}
			/>
			<DiffSection
				label="Перемещено"
				icon={<ArrowRightLeft className="h-3 w-3 text-sky-600" />}
				entries={diff.moved}
			/>
			<DiffSection
				label="Удалено"
				icon={<Minus className="h-3 w-3 text-destructive" />}
				entries={diff.removed}
			/>

			{downloadable.length > 0 && (
				<Button
					size="sm"
					className="w-full"
					onClick={downloadSelected}
					disabled={extract.state?.status === "running" || selected.size === 0}
				>
					<Download className="h-3 w-3" />
					{extract.state?.status === "running"
						? extract.state.progress.message || "Скачивание…"
						: `Скачать отмеченные (${selected.size})`}
				</Button>
			)}

			{extract.state?.status === "failed" && extract.state.error && (
				<div className="text-[11px] text-destructive">
					{extract.state.error}
				</div>
			)}
			{extract.state?.status === "completed" &&
				extract.state.result?.fileName && (
					<div className="flex min-w-0 items-center gap-2 rounded-md border border-success/30 bg-success/5 p-2 text-[11px] text-success">
						<CheckCircle2 className="h-3 w-3 shrink-0" />
						<span className="min-w-0 break-all">
							Сохранено:{" "}
							<span className="font-mono text-foreground">
								{extract.state.result.fileName}
							</span>
						</span>
					</div>
				)}
		</div>
	);
}

interface DiffSectionProps {
	label: string;
	icon: React.ReactNode;
	entries: DiffEntry[];
	selectable?: boolean;
	selected?: Set<string>;
	onToggle?: (id: string) => void;
}

function DiffSection({
	label,
	icon,
	entries,
	selectable,
	selected,
	onToggle,
}: DiffSectionProps) {
	if (!entries.length) return null;
	return (
		<div className="space-y-1">
			<div className="flex items-center gap-1 text-[11px] font-medium">
				{icon}
				<span>{label}</span>
				<span className="text-muted-foreground">({entries.length})</span>
			</div>
        <ul className="min-w-0 space-y-0.5 pl-1 wide-panel:pl-4">
				{entries.map((e) => (
					<li
						key={e.pageId}
                className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] wide-panel:gap-x-2"
					>
						{selectable && selected && onToggle && (
							<input
								type="checkbox"
								className="h-3 w-3"
								checked={selected.has(e.pageId)}
								onChange={() => onToggle(e.pageId)}
							/>
						)}
						<span className="min-w-0 flex-1 truncate">{e.title}</span>
						{e.fromVersion != null && e.toVersion != null && (
							<span className="shrink-0 font-mono text-muted-foreground">
								v{e.fromVersion}→v{e.toVersion}
							</span>
						)}
						{e.toVersion != null && e.fromVersion == null && (
							<span className="shrink-0 font-mono text-muted-foreground">
								v{e.toVersion}
							</span>
						)}
						{e.updatedBy && (
                  <span className="max-w-[56px] truncate text-muted-foreground wide-panel:max-w-[80px]">
								{e.updatedBy}
							</span>
						)}
					</li>
				))}
			</ul>
		</div>
	);
}

function formatDate(iso: string): string {
	try {
		const d = new Date(iso);
		return d.toLocaleString(undefined, {
			year: "2-digit",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
		});
	} catch {
		return iso;
	}
}
