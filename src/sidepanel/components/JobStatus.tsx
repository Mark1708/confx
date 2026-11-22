import { AlertTriangle, Ban, CheckCircle2, Loader2, XCircle } from "lucide-react";
import type { I18nKey } from "@/i18n";
import { cn } from "@/lib/cn";
import type { ExportJobState } from "@/types";
import { useI18n } from "../hooks/useI18n";
import { failureMessageKey } from "../workspace/export-controller";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { Progress } from "../ui/progress";

interface JobStatusProps {
  state: ExportJobState | null;
  onCancel: () => void;
  ownsJob: boolean;
  busy: boolean;
  onFocusOwner: () => void;
}

const STATUS_PRESENTATION = {
  pending: { title: "jobs.pendingTitle", Icon: Loader2 },
  running: { title: "jobs.runningTitle", Icon: Loader2 },
  completed: { title: "jobs.completedTitle", Icon: CheckCircle2 },
  partial: { title: "jobs.partialTitle", Icon: AlertTriangle },
  failed: { title: "jobs.failedTitle", Icon: XCircle },
  cancelled: { title: "jobs.cancelledTitle", Icon: Ban },
  interrupted: { title: "jobs.interruptedTitle", Icon: AlertTriangle },
} satisfies Record<ExportJobState["status"], { title: I18nKey; Icon: typeof Loader2 }>;

const COUNTERS = [
  ["successfulPages", "jobs.successfulPages"],
  ["failedPages", "jobs.failedPages"],
  ["successfulResources", "jobs.successfulResources"],
  ["failedResources", "jobs.failedResources"],
  ["entriesWritten", "jobs.entriesWritten"],
  ["bytesWritten", "jobs.bytesWritten"],
] as const;

export function JobStatus({ state, onCancel, ownsJob, busy, onFocusOwner }: JobStatusProps) {
  const { t } = useI18n();
  if (!state) return null;

  const live = state.status === "pending" || state.status === "running";
  const warning =
    state.status === "partial" || state.status === "cancelled" || state.status === "interrupted";
  const failed = state.status === "failed";
  const completed = state.status === "completed";
  const { Icon, title } = STATUS_PRESENTATION[state.status];
  const { counts } = state;
  const percentage =
    counts.processed !== null && counts.total !== null && counts.total > 0
      ? Math.max(0, Math.min(100, Math.round((counts.processed / counts.total) * 100)))
      : null;
  const measuredCounters = COUNTERS.filter(([key]) => counts[key] !== null);
  const reasonKey = state.terminalReason ? failureMessageKey(state.terminalReason) : null;

  return (
    <Card
      role={failed ? "alert" : "status"}
      className={cn(
        live && "border-primary/30 bg-primary/5",
        completed && "border-success/30 bg-success/5",
        warning && "border-warning/30 bg-warning/5",
        failed && "border-destructive/30 bg-destructive/5",
      )}
    >
      <CardContent className="space-y-2 p-3 text-xs">
        <div className="flex min-w-0 items-start gap-2">
          <Icon
            className={cn(
              "mt-0.5 h-4 w-4 shrink-0",
              live && "animate-spin text-primary",
              completed && "text-success",
              warning && "text-warning",
              failed && "text-destructive",
            )}
          />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2 font-medium text-foreground">
              {t(title)}
              {completed && <Badge variant="success">{t("jobs.savedBadge")}</Badge>}
            </div>
            {state.phase && (
              <div className="text-muted-foreground">{t(`jobs.phases.${state.phase}`)}</div>
            )}
            {state.message && <p className="break-words text-muted-foreground">{state.message}</p>}
          </div>
          {live && busy && ownsJob && !state.cancelRequested && (
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={onCancel}>
              {t("jobs.cancel")}
            </Button>
          )}
        </div>

        {state.cancelRequested && live && (
          <div className="space-y-1 text-warning">
            <p>{t("jobs.cancelRequested")}</p>
            {state.phase === "downloading" && <p>{t("jobs.cancelSaveDialog")}</p>}
          </div>
        )}
        {busy && !ownsJob && (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 text-muted-foreground">
              {t("jobs.foreignOwner", {
                surface: t(`jobs.ownerSurfaces.${state.owner.surface}`),
              })}
            </p>
            <Button type="button" size="sm" variant="outline" onClick={onFocusOwner}>
              {t("jobs.focusOwner")}
            </Button>
          </div>
        )}

        {live && percentage !== null && (
          <>
            <Progress
              value={percentage}
              aria-valuenow={percentage}
              aria-label={t("jobs.progress")}
            />
            <span className="font-mono text-muted-foreground">{percentage}%</span>
          </>
        )}
        {counts.processed !== null && counts.total !== null && (
          <div className="text-muted-foreground">
            {t("jobs.step", { current: counts.processed, total: counts.total })}
          </div>
        )}
        {measuredCounters.length > 0 && (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-muted-foreground">
            {measuredCounters.map(([key, label]) => (
              <div key={key} className="flex min-w-0 flex-wrap justify-between gap-x-2">
                <dt>{t(label)}</dt>
                <dd className="font-mono text-foreground">{counts[key]?.toLocaleString()}</dd>
              </div>
            ))}
          </dl>
        )}

        {state.status === "partial" && (
          <p className="text-warning">{t("jobs.partialDescription")}</p>
        )}
        {state.status === "interrupted" && (
          <p className="text-warning">{t("jobs.interruptedDescription")}</p>
        )}
        {state.status === "cancelled" && (
          <p className="text-muted-foreground">{t("jobs.cancelledDescription")}</p>
        )}
        {state.error && <p className="break-words text-destructive">{state.error}</p>}
        {state.terminalReason &&
          state.terminalReason !== state.message &&
          state.terminalReason !== state.error && (
            <p className="break-words text-muted-foreground">
              {reasonKey ? t(reasonKey) : state.terminalReason}
            </p>
          )}
        {(completed || state.status === "partial") && state.result?.fileName && (
          <p className="break-all text-muted-foreground">
            {t("jobs.file")}{" "}
            <span className="font-mono text-foreground">{state.result.fileName}</span>
          </p>
        )}
        {(completed || state.status === "partial") && state.result?.directoryName && (
          <p className="break-all text-muted-foreground">
            {t("jobs.directory")}{" "}
            <span className="font-mono text-foreground">{state.result.directoryName}</span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
