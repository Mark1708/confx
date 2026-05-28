import type { ExportJobConfig, ExportJobState, ExportJobStatus } from "@/types";

interface ExportJobResult {
  fileName: string;
}

interface ExportJobProgress {
  current: number;
  total: number;
  message: string;
}

const INITIAL_PROGRESS: ExportJobProgress = {
  current: 0,
  total: 0,
  message: "",
};

export class ExportJob {
  private _status: ExportJobStatus = "pending";
  private _abortController: AbortController | null = null;
  private _error: string | undefined;
  private _result: ExportJobResult | undefined;
  private _progress: ExportJobProgress = INITIAL_PROGRESS;
  private _startedAt: string | undefined;
  private _completedAt: string | undefined;

  constructor(
    readonly id: string,
    readonly config: ExportJobConfig,
  ) {}

  get status(): ExportJobStatus {
    return this._status;
  }

  get abortController(): AbortController | null {
    return this._abortController;
  }

  get error(): string | undefined {
    return this._error;
  }

  get result(): ExportJobResult | undefined {
    return this._result;
  }

  get progress(): ExportJobProgress {
    return this._progress;
  }

  get startedAt(): string | undefined {
    return this._startedAt;
  }

  get completedAt(): string | undefined {
    return this._completedAt;
  }

  get signal(): AbortSignal | undefined {
    return this._abortController?.signal;
  }

  start(): void {
    this.ensureTransition("running");
    this._status = "running";
    this._abortController = new AbortController();
    this._startedAt = new Date().toISOString();
  }

  complete(fileName: string): void {
    this.ensureTransition("completed");
    this._status = "completed";
    this._result = { fileName };
    this._completedAt = new Date().toISOString();
  }

  fail(error: string): void {
    this.ensureTransition("failed");
    this._status = "failed";
    this._error = error;
    this._completedAt = new Date().toISOString();
  }

  cancel(): void {
    this.ensureTransition("cancelled");
    this._abortController?.abort();
    this._status = "cancelled";
    this._completedAt = new Date().toISOString();
  }

  updateProgress(current: number, total: number, message: string): void {
    if (this._status !== "running") return;
    this._progress = { current, total, message };
  }

  toState(): ExportJobState {
    return {
      id: this.id,
      status: this._status,
      config: this.config,
      progress: this._progress,
      error: this._error,
      result: this._result,
      startedAt: this._startedAt,
      completedAt: this._completedAt,
    };
  }

  private ensureTransition(nextStatus: ExportJobStatus): void {
    if (this._status === "pending" && nextStatus === "running") return;
    if (this._status === "running" && isTerminalStatus(nextStatus)) return;
    throw new Error(`Invalid export job transition: ${this._status} -> ${nextStatus}`);
  }
}

function isTerminalStatus(status: ExportJobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function createExportJob(config: ExportJobConfig): ExportJob {
  return new ExportJob(crypto.randomUUID(), config);
}
