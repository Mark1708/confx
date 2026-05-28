import { Crosshair, Download, X } from "lucide-react";
import { BrowserApi } from "@/lib/browser/browser-api";
import type { CurrentTabInfo } from "../hooks/useCurrentTab";
import { useExtractJob } from "../hooks/useExtractJob";
import { usePickerBridge } from "../hooks/usePickerBridge";
import { useSettings } from "../hooks/useSettings";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { JobStatus } from "./JobStatus";
import { PresetSelector } from "./PresetSelector";

export function PickerPanel({ tab }: { tab: CurrentTabInfo }) {
	const { data: settings, update } = useSettings();
	const { state, run, cancel } = useExtractJob();
	const { pickedBlock, clear } = usePickerBridge();

	const preset = settings?.activePresetId ?? "ui-component";

	const startPicker = async () => {
		if (!tab.tabId) return;
		await BrowserApi.executeScript({
			target: { tabId: tab.tabId },
			func: () => window.postMessage({ __cx_cmd: "start-picker" }, "*"),
		});
	};

	return (
		<div className="min-w-0 space-y-3">
			<h2 className="text-sm font-semibold">Пикер блоков</h2>
			<p className="text-xs text-muted-foreground">
				Нажмите «Запустить пикер», затем выберите блок на странице. Используйте{" "}
				<kbd className="rounded border bg-muted px-1 text-[10px]">[</kbd>
				{" / "}
				<kbd className="rounded border bg-muted px-1 text-[10px]">]</kbd> для
				смены уровня выделения,
				<kbd className="ml-1 rounded border bg-muted px-1 text-[10px]">Esc</kbd>{" "}
				— отмена.
			</p>

			<Button className="w-full" onClick={startPicker} disabled={!tab.tabId}>
				<Crosshair className="h-4 w-4" />
				Запустить пикер на странице
			</Button>

			{!pickedBlock && (
				<Card className="border-primary/30 bg-primary/5">
					<CardContent className="space-y-3 p-4 text-xs text-muted-foreground">
					<div className="flex min-w-0 items-start gap-3">
							<div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface shadow-[0_0_16px_hsl(var(--accent-glow))]">
								<Crosshair className="h-4 w-4 text-primary" />
							</div>
							<div className="min-w-0 space-y-1">
								<div className="font-medium text-foreground">
									Блок ещё не выбран
								</div>
								<div>
									Запустите пикер и кликните по нужной области страницы. После
									выбора здесь появится превью и кнопка экспорта.
								</div>
							</div>
						</div>
						{!tab.tabId && (
							<div className="rounded-md border border-warning/30 bg-warning/5 p-2 text-warning">
								Нет активной вкладки для запуска пикера.
							</div>
						)}
					</CardContent>
				</Card>
			)}

			{pickedBlock && (
				<Card>
					<CardHeader className="pb-2">
						<div className="flex min-w-0 items-start justify-between gap-2">
							<div className="min-w-0 space-y-1">
								<CardTitle className="flex min-w-0 flex-wrap items-center gap-2">
									Выбран блок
									<Badge variant="success">готов</Badge>
								</CardTitle>
								<CardDescription>
									Можно выгрузить только выбранный фрагмент.
								</CardDescription>
							</div>
							<Button variant="ghost" size="icon" className="shrink-0" onClick={clear}>
								<X className="h-3 w-3" />
							</Button>
						</div>
					</CardHeader>
					<CardContent className="space-y-2 pt-0 text-xs">
						<div className="line-clamp-2 text-muted-foreground">
							{pickedBlock.meta.title} ·{" "}
							{(pickedBlock.html.length / 1024).toFixed(1)} KB HTML
						</div>
						<Button
							variant="accent"
							className="w-full"
							disabled={state?.status === "running"}
							onClick={() =>
								run({
									kind: "extract-block",
									html: pickedBlock.html,
									pageMeta: pickedBlock.meta,
									presetId: preset,
								})
							}
						>
							<Download className="h-4 w-4" />
							Извлечь блок
						</Button>
					</CardContent>
				</Card>
			)}

			<PresetSelector
				value={preset}
				onChange={(id) => update({ activePresetId: id })}
			/>

			<JobStatus state={state} onCancel={cancel} />
		</div>
	);
}
