import { useQueryClient } from "@tanstack/react-query";
import { Bell, BellRing, Download, Loader2, RefreshCw } from "lucide-react";
import { makeSubscriptionId } from "@/lib/subscriptions";
import type { CurrentTabInfo } from "../hooks/useCurrentTab";
import { useExtractJob } from "../hooks/useExtractJob";
import { usePageInfo } from "../hooks/usePageInfo";
import { useSettings } from "../hooks/useSettings";
import { useSubscriptions } from "../hooks/useSubscriptions";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { JobStatus } from "./JobStatus";
import { PageCard } from "./PageCard";
import { PresetSelector } from "./PresetSelector";

export function PagePanel({ tab }: { tab: CurrentTabInfo }) {
	const qc = useQueryClient();
	const info = usePageInfo(tab.host, tab.pageId);
	const { state, run, cancel } = useExtractJob();
	const { data: settings, update } = useSettings();
	const subs = useSubscriptions();

	const canExtract =
		info.data?.ok && info.data.meta?.id && state?.status !== "running";
	const preset = settings?.activePresetId ?? "ui-component";

	const pageId = info.data?.meta?.id;
	const subId =
		tab.host && pageId ? makeSubscriptionId(tab.host, pageId, "page") : null;
	const subscribed = Boolean(
		subId && subs.subscriptions.some((s) => s.id === subId),
	);

	return (
		<div className="min-w-0 space-y-3">
			<div className="flex min-w-0 items-center justify-between gap-2">
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<h2 className="text-sm font-semibold">Текущая страница</h2>
					{info.data?.ok && <Badge variant="success">доступна</Badge>}
				</div>
				<Button
					variant="ghost"
					size="sm"
					className="shrink-0"
					onClick={() => qc.invalidateQueries({ queryKey: ["page-info"] })}
				>
					<RefreshCw className="h-3 w-3" />
				</Button>
			</div>

			<PageCard
				loading={info.isLoading}
				data={info.data}
				error={info.error as Error | null}
				url={tab.url}
			/>

			<PresetSelector
				value={preset}
				onChange={(id) => update({ activePresetId: id })}
			/>

			<Button
				variant="accent"
				className="w-full"
				disabled={!canExtract}
				onClick={() =>
					info.data?.meta &&
					tab.host &&
					run({
						kind: "extract-page",
						pageId: info.data.meta.id,
						host: tab.host,
						presetId: preset,
					})
				}
			>
				<Download className="h-4 w-4" />
				Извлечь страницу
			</Button>

			<Button
				variant="outline"
				className="w-full"
				disabled={!pageId || !tab.host || subs.subscribing || subscribed}
				onClick={() =>
					pageId &&
					tab.host &&
					subs.subscribe({ host: tab.host, rootId: pageId, scope: "page" })
				}
			>
				{subs.subscribing ? (
					<Loader2 className="h-4 w-4 animate-spin" />
				) : subscribed ? (
					<BellRing className="h-4 w-4" />
				) : (
					<Bell className="h-4 w-4" />
				)}
				{subscribed ? "Подписка активна" : "Подписаться на изменения"}
			</Button>

			<JobStatus state={state} onCancel={cancel} />
		</div>
	);
}
