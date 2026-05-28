import { Ban, CheckCircle2, Loader2, XCircle } from "lucide-react";
import type { ExportJobState } from "@/types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { Progress } from "../ui/progress";

interface JobStatusProps {
	state: ExportJobState | null;
	onCancel: () => void;
}

export function JobStatus({ state, onCancel }: JobStatusProps) {
	if (!state) return null;

	if (state.status === "failed") {
		return (
			<Card className="border-destructive/30 bg-destructive/5">
				<CardContent className="flex items-start gap-3 p-3 text-xs">
					<XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
					<div className="min-w-0 flex-1 space-y-1">
						<div className="flex min-w-0 flex-wrap items-center gap-2">
							<div className="font-medium text-foreground">
								Экспорт не завершён
							</div>
							<Badge variant="destructive">ошибка</Badge>
						</div>
						<div className="text-destructive/90">{state.error}</div>
					</div>
				</CardContent>
			</Card>
		);
	}

	if (state.status === "cancelled") {
		return (
			<Card className="border-warning/30 bg-warning/5">
				<CardContent className="flex items-center gap-3 p-3 text-xs">
					<Ban className="h-4 w-4 text-warning" />
					<div className="min-w-0 flex-1">
						<div className="font-medium text-foreground">Экспорт отменён</div>
						<div className="text-muted-foreground">
							Можно запустить выгрузку повторно.
						</div>
					</div>
					<Badge className="shrink-0" variant="warning">стоп</Badge>
				</CardContent>
			</Card>
		);
	}

	if (state.status === "running") {
		const pct =
			state.progress.total > 0
				? Math.round((state.progress.current / state.progress.total) * 100)
				: 0;
		return (
			<Card className="border-primary/30 bg-primary/5">
				<CardContent className="space-y-2 p-3">
					<div className="flex items-center gap-2 text-xs">
						<Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
						<div className="min-w-0 flex-1">
							<div className="truncate font-medium text-foreground">
								Экспорт выполняется
							</div>
							<div className="truncate text-muted-foreground">
								{state.progress.message}
							</div>
						</div>
						{state.progress.total > 0 && (
							<span className="font-mono text-muted-foreground">{pct}%</span>
						)}
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="h-7 px-2"
							onClick={onCancel}
						>
							Отмена
						</Button>
					</div>
					<Progress value={pct} />
					{state.progress.total > 0 && (
						<div className="text-[10px] text-muted-foreground">
							Шаг {state.progress.current} из {state.progress.total}
						</div>
					)}
				</CardContent>
			</Card>
		);
	}

	if (state.status === "completed" && state.result?.fileName) {
		return (
			<Card className="border-success/30 bg-success/5">
				<CardContent className="flex items-start gap-3 p-3 text-xs">
					<CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
					<div className="min-w-0 flex-1 space-y-1">
					<div className="flex min-w-0 flex-wrap items-center gap-2">
							<div className="font-medium text-foreground">Экспорт готов</div>
							<Badge variant="success">сохранено</Badge>
						</div>
					<div className="truncate text-muted-foreground">
							Файл:{" "}
							<span className="font-mono text-foreground">
								{state.result.fileName}
							</span>
						</div>
					</div>
				</CardContent>
			</Card>
		);
	}

	return null;
}
