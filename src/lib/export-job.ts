import type { ExportOutcome, PreparedExport, ProgressEvent } from "@/lib/export/contracts";
import { sourceKey } from "@/lib/source-context";
import type {
  ExportJobCounts,
  ExportJobOwner,
  ExportJobPhase,
  ExportJobState,
  ExportJobStatus,
  ExportRequestSummary,
} from "@/types";

export function isTerminalJobStatus(status: ExportJobStatus): boolean {
  return status !== "pending" && status !== "running";
}

function summarizeRequest(prepared: PreparedExport): ExportRequestSummary {
  const request = prepared.request;
  const summary: ExportRequestSummary = {
    kind: request.kind,
    destination: prepared.destination,
    presetId: prepared.defaults.presetId,
  };
  switch (request.kind) {
    case "extract-page":
      summary.pageId = request.pageId;
      break;
    case "extract-subtree":
      summary.rootPageId = request.rootPageId;
      summary.maxDepth = request.maxDepth ?? prepared.defaults.maxDepth;
      break;
    case "extract-space":
      summary.spaceKey = request.spaceKey;
      summary.maxDepth = request.maxDepth ?? prepared.defaults.maxDepth;
      break;
    case "extract-watch-changed":
      summary.selectionCount = request.pageIds.length;
      break;
    case "extract-block":
      summary.pageId = request.pageMeta.id;
      break;
    case "extract-jira-issue":
      summary.issueKey = request.issueKey;
      break;
    case "extract-jira-search":
      break;
  }
  return summary;
}

export class ExportJob {
  private readonly controller = new AbortController();
  private state: ExportJobState;

  constructor(prepared: PreparedExport, owner: ExportJobOwner) {
    this.state = {
      version: 2,
      id: prepared.id,
      sourceKey: sourceKey(prepared.source),
      owner: {
        instanceId: owner.instanceId,
        surface: owner.surface,
        ...(owner.tabId === undefined ? {} : { tabId: owner.tabId }),
        ...(owner.windowId === undefined ? {} : { windowId: owner.windowId }),
      },
      request: summarizeRequest(prepared),
      status: "pending",
      phase: "discovering",
      message: "",
      counts: {
        processed: 0,
        total: null,
        successfulPages: null,
        failedPages: null,
        successfulResources: null,
        failedResources: null,
        entriesWritten: null,
        bytesWritten: null,
      },
      cancelRequested: false,
    };
  }

  get id(): string {
    return this.state.id;
  }

  get status(): ExportJobStatus {
    return this.state.status;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  start(): void {
    this.ensureTransition("running");
    this.signal.throwIfAborted();
    this.state = { ...this.state, status: "running", startedAt: new Date().toISOString() };
  }

  updateProgress(progress: ProgressEvent): void {
    if (this.state.status !== "running" || this.signal.aborted) return;
    const counts: ExportJobCounts = {
      ...this.state.counts,
      processed: progress.current,
      total: progress.total,
    };
    for (const key of Object.keys(counts) as Array<keyof ExportJobCounts>) {
      const measured = progress.counts?.[key];
      if (measured !== undefined) counts[key] = measured;
    }
    this.state = {
      ...this.state,
      phase: progress.phase ?? this.state.phase,
      message: progress.message,
      counts,
    };
  }

  setPhase(phase: ExportJobPhase): void {
    if (this.state.status === "running" && !this.signal.aborted)
      this.state = { ...this.state, phase };
  }

  complete(result: NonNullable<ExportJobState["result"]>, outcome: ExportOutcome): void {
    const status = outcome.partial ? "partial" : "completed";
    this.ensureTransition(status);
    this.signal.throwIfAborted();
    this.state = {
      ...this.state,
      status,
      counts: {
        ...this.state.counts,
        successfulPages: outcome.successfulPages,
        failedPages: outcome.failedPages,
        successfulResources: outcome.successfulResources,
        failedResources: outcome.failedResources,
        entriesWritten: outcome.entriesWritten,
      },
      result: {
        fileName: result.fileName,
        ...(result.downloadId === undefined ? {} : { downloadId: result.downloadId }),
        ...(result.directoryName === undefined ? {} : { directoryName: result.directoryName }),
      },
      completedAt: new Date().toISOString(),
      terminalReason: status,
    };
  }

  fail(error: string, reason = "export-failed"): void {
    this.ensureTransition("failed");
    this.state = {
      ...this.state,
      status: "failed",
      error,
      completedAt: new Date().toISOString(),
      terminalReason: reason,
    };
    // Terminal failure also stops outstanding job work; the abort reason is the
    // failure itself, so cancellation classification is never implied.
    this.controller.abort(new Error(error));
  }

  cancel(): void {
    if (isTerminalJobStatus(this.state.status) || this.state.cancelRequested) return;
    this.state = { ...this.state, cancelRequested: true };
    this.controller.abort(new DOMException("Export cancelled", "AbortError"));
  }

  abort(reason: unknown): void {
    this.controller.abort(reason);
  }

  finishCancelled(): void {
    this.ensureTransition("cancelled");
    this.state = {
      ...this.state,
      status: "cancelled",
      cancelRequested: true,
      completedAt: new Date().toISOString(),
      terminalReason: "cancelled",
    };
  }

  interrupt(): void {
    this.ensureTransition("interrupted");
    this.controller.abort(new DOMException("Export owner closed", "AbortError"));
    this.state = {
      ...this.state,
      status: "interrupted",
      completedAt: new Date().toISOString(),
      terminalReason: "owner-closed",
    };
  }

  toState(): ExportJobState {
    return {
      ...this.state,
      owner: { ...this.state.owner },
      request: { ...this.state.request },
      counts: { ...this.state.counts },
      ...(this.state.result ? { result: { ...this.state.result } } : {}),
    };
  }

  private ensureTransition(next: ExportJobStatus): void {
    if (this.state.status === "pending" && next === "running") return;
    if (
      this.state.status === "pending" &&
      (next === "failed" || next === "cancelled" || next === "interrupted")
    )
      return;
    if (this.state.status === "running" && isTerminalJobStatus(next)) return;
    throw new Error(`Invalid export job transition: ${this.state.status} -> ${next}`);
  }
}
