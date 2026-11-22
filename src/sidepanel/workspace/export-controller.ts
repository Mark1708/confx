import type { I18nKey } from "@/i18n";
import { watchStorageKey } from "@/lib/browser/storage-watch";
import { focusUiSurface } from "@/lib/browser/ui-surface";
import type {
  ExportRunDraft,
  ExportSink,
  PreparedExport,
  ProgressEvent,
} from "@/lib/export/contracts";
import { prepareExport } from "@/lib/export/prepare";
import {
  createDirectorySink,
  createMemoryZipSink,
  createStreamedZipSink,
} from "@/lib/export/sinks";
import { ExportJob, isTerminalJobStatus } from "@/lib/export-job";
import {
  EXPORT_ACTIVE_KEY,
  exportJobStorageKey,
  loadLastJobState,
  saveJobState,
} from "@/lib/export-state";
import { isAbortError } from "@/lib/http-client";
import { canonicalBaseUrl, resolveSourceBase, type SourceContext } from "@/lib/source-context";
import type { AppSettings, ExportJobOwner, ExportJobState } from "@/types";
import { downloadBlob, type ExportDownloader } from "../download";
import { runExport, type ExportRunner, type SinkOpener } from "./run-export";

const EXPORT_LOCK = "cx.export.v2";

/** Terminal failure categories with a localized user message; persisted as terminal reasons. */
export const EXPORT_FAILURE_REASONS = [
  "permission-denied",
  "writer-failure",
  "zip-limit-exceeded",
  "destination-collision",
] as const;
export type ExportFailureReason = (typeof EXPORT_FAILURE_REASONS)[number];

export const EXPORT_FAILURE_MESSAGE_KEYS: Readonly<Record<ExportFailureReason, I18nKey>> = {
  "permission-denied": "jobs.reasons.permissionDenied",
  "writer-failure": "jobs.reasons.writerFailure",
  "zip-limit-exceeded": "jobs.reasons.zipLimitExceeded",
  "destination-collision": "jobs.reasons.destinationCollision",
};

export function failureMessageKey(reason: string): I18nKey | null {
  return (EXPORT_FAILURE_REASONS as readonly string[]).includes(reason)
    ? EXPORT_FAILURE_MESSAGE_KEYS[reason as ExportFailureReason]
    : null;
}

export interface ExportLockManager {
  request<T>(
    name: string,
    options: { ifAvailable?: true; signal?: AbortSignal },
    callback: (lock: Lock | null) => T | Promise<T>,
  ): Promise<T>;
}

/** The three destination sinks behind one run pipeline; injectable for focused tests. */
export interface ExportSinkFactories {
  memory(rootName: string): { sink: ExportSink; blob(): Promise<Blob> };
  directory(
    parent: FileSystemDirectoryHandle,
    options: { rootName: string; jobId: string },
    signal?: AbortSignal,
  ): Promise<ExportSink>;
  streamed(
    parent: FileSystemDirectoryHandle,
    options: { rootName: string; jobId: string },
    signal?: AbortSignal,
  ): Promise<ExportSink>;
}

const defaultSinks: ExportSinkFactories = {
  memory: createMemoryZipSink,
  directory: createDirectorySink,
  streamed: createStreamedZipSink,
};

export interface ExportControllerOptions {
  owner: ExportJobOwner;
  locks?: ExportLockManager | null;
  runExport?: ExportRunner;
  download?: ExportDownloader;
  sinks?: ExportSinkFactories;
  focusOwner?: (owner: ExportJobOwner) => Promise<void>;
}

export interface ExportControllerView {
  ready: boolean;
  state: ExportJobState | null;
  busy: boolean;
  ownsJob: boolean;
  selecting: boolean;
  error: string | null;
  /** When set, `error` is the diagnostic detail and this code picks the localized message. */
  errorCode: ExportFailureReason | null;
}

type DestinationSelection = "download-zip" | Promise<FileSystemDirectoryHandle>;

function isErrorLike(value: unknown): value is { name?: unknown; cause?: unknown } {
  return typeof value === "object" && value !== null;
}

const FAILURE_NAMES: Readonly<Record<string, ExportFailureReason>> = {
  ZIP_LIMIT_EXCEEDED: "zip-limit-exceeded",
  DestinationCollisionError: "destination-collision",
  SinkWriterError: "writer-failure",
};

/** Walks the error chain: sink failures wrap their cause and must stay classifiable. */
function classifyExportFailure(error: unknown): ExportFailureReason | null {
  const seen = new Set<unknown>();
  let fallback: ExportFailureReason | null = null;
  for (let cause: unknown = error; isErrorLike(cause) && !seen.has(cause); cause = cause.cause) {
    seen.add(cause);
    const { name } = cause;
    if (typeof name !== "string") continue;
    if (name === "NotAllowedError") return "permission-denied";
    const mapped = FAILURE_NAMES[name];
    if (mapped === "writer-failure") fallback = mapped;
    else if (mapped) return mapped;
  }
  return fallback;
}

export class ExportController {
  private readonly owner: ExportJobOwner;
  private readonly locks: ExportLockManager | null;
  private readonly runner: ExportRunner;
  private readonly downloader: ExportDownloader;
  private readonly sinks: ExportSinkFactories;
  private readonly focus: (owner: ExportJobOwner) => Promise<void>;
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<() => void>();
  private view: ExportControllerView = {
    ready: false,
    state: null,
    busy: false,
    ownsJob: false,
    selecting: false,
    error: null,
    errorCode: null,
  };
  private initialization: Promise<void> | null = null;
  private refreshTask: Promise<void> | null = null;
  private refreshAgain = false;
  private observer: Promise<void> | null = null;
  private stopActiveWatch: (() => void) | null = null;
  private stopJobWatch: (() => void) | null = null;
  private watchedId: string | null = null;
  private active: ExportJob | null = null;
  private starting = false;
  private selectionGeneration = 0;
  private persistence: Promise<void> = Promise.resolve();
  private persistenceFailure: unknown;
  private persistenceFailed = false;
  private disposed = false;

  constructor(options: ExportControllerOptions) {
    this.owner = {
      instanceId: options.owner.instanceId,
      surface: options.owner.surface,
      ...(options.owner.tabId === undefined ? {} : { tabId: options.owner.tabId }),
      ...(options.owner.windowId === undefined ? {} : { windowId: options.owner.windowId }),
    };
    this.locks =
      options.locks === undefined
        ? typeof navigator === "undefined"
          ? null
          : (navigator.locks ?? null)
        : options.locks;
    this.runner = options.runExport ?? runExport;
    this.downloader = options.download ?? downloadBlob;
    this.sinks = options.sinks ?? defaultSinks;
    this.focus = options.focusOwner ?? focusUiSurface;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ExportControllerView => this.view;

  initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.initializeOnce();
    }
    return this.initialization;
  }

  prepare(
    source: SourceContext,
    draft: ExportRunDraft,
    loadedSettings: AppSettings,
  ): PreparedExport {
    if (this.disposed) throw new Error("Export workspace is closed");
    const baseUrl = resolveSourceBase(source.pageUrl, source.baseUrl).baseUrl;
    const requestBase = canonicalBaseUrl(
      draft.request.kind === "extract-block" ? draft.request.pageMeta.baseUrl : draft.request.host,
    );
    if (new URL(requestBase).origin !== new URL(baseUrl).origin) {
      throw new Error("Export request origin does not match the source");
    }
    if (draft.request.kind === "extract-watch-changed" && requestBase !== baseUrl) {
      throw new Error("Watch subscription base does not match the current source");
    }
    if (
      draft.request.kind === "extract-block" &&
      new URL(draft.request.pageMeta.url).origin !== new URL(baseUrl).origin
    ) {
      throw new Error("Selected fragment origin does not match the source");
    }
    return prepareExport(
      { ...source, baseUrl },
      draft.request,
      loadedSettings,
      draft.defaults,
      draft.destination,
    );
  }

  async start(prepared: PreparedExport, selection: DestinationSelection): Promise<void> {
    // Attach a rejection handler immediately: a rejected native picker must not
    // escape when a second click, disposal, or another owner's lock rejects start.
    const pendingSelection =
      selection === "download-zip"
        ? null
        : selection.then(
            (handle) => ({ handle, error: undefined }),
            (error: unknown) => ({ handle: undefined, error }),
          );
    if (this.disposed || this.starting || this.active) return;
    this.starting = true;
    const generation = ++this.selectionGeneration;
    this.publish({ error: null, errorCode: null });
    try {
      let handle: FileSystemDirectoryHandle | null = null;
      if (pendingSelection) {
        this.publish({ selecting: true });
        const picked = await pendingSelection;
        if (this.disposed || generation !== this.selectionGeneration) return;
        this.publish({ selecting: false });
        if (picked.error !== undefined) {
          // A cancelled picker is silent; a denied one keeps its distinct terminal message.
          if (!isAbortError(picked.error)) {
            this.publish({
              error: errorMessage(picked.error),
              errorCode: classifyExportFailure(picked.error),
            });
          }
          return;
        }
        handle = picked.handle ?? null;
      }
      if (this.disposed || generation !== this.selectionGeneration) return;
      const mismatch = destinationMismatch(prepared.destination, selection, handle);
      if (mismatch) {
        this.publish({ error: mismatch });
        return;
      }
      await this.initialize();
      if (this.disposed || generation !== this.selectionGeneration) return;
      if (!this.locks) {
        this.publish({ error: "Web Locks are not supported; export cannot start safely" });
        return;
      }
      if (this.owner.surface === "unknown") {
        this.publish({ error: "An export requires a live workspace owner" });
        return;
      }
      if (prepared.destination !== "download-zip" && this.owner.surface !== "workspace") {
        this.publish({ error: "This export destination needs the workspace tab" });
        return;
      }
      await this.locks.request(EXPORT_LOCK, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          await this.readForeignOwner();
          this.observeRelease();
          return;
        }
        if (this.disposed || generation !== this.selectionGeneration) return;
        await this.runOwned(prepared, handle);
      });
    } catch (error: unknown) {
      if (!this.disposed) this.publish({ error: errorMessage(error) });
    } finally {
      this.starting = false;
      if (generation === this.selectionGeneration) this.publish({ selecting: false });
      this.releaseOwned();
    }
  }

  private releaseOwned(): void {
    if (!this.active) return;
    const state = this.active.toState();
    this.active = null;
    this.publish({ state, busy: false, ownsJob: false });
  }

  cancel(): boolean {
    const job = this.active;
    if (job && !isTerminalJobStatus(job.status)) {
      if (this.view.state?.cancelRequested) return true;
      job.cancel();
      const state = job.toState();
      this.publish({ state });
      void this.persist(state).catch(() => undefined);
      return true;
    }
    if (this.view.selecting) {
      this.selectionGeneration += 1;
      this.publish({ selecting: false });
      return true;
    }
    return false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.selectionGeneration += 1;
    this.lifetime.abort();
    this.active?.abort(new DOMException("Export owner closed", "AbortError"));
    this.stopActiveWatch?.();
    this.stopJobWatch?.();
    this.stopActiveWatch = null;
    this.stopJobWatch = null;
    this.listeners.clear();
  }

  async focusOwner(): Promise<void> {
    const owner = this.view.state?.owner;
    if (owner && owner.surface !== "unknown") await this.focus(owner);
  }

  private async initializeOnce(): Promise<void> {
    if (this.disposed) return;
    this.stopActiveWatch = watchStorageKey("session", EXPORT_ACTIVE_KEY, () => {
      void this.refresh();
    });
    if (!this.locks) {
      try {
        const saved = await loadLastJobState(false);
        const state =
          saved && !isTerminalJobStatus(saved.status)
            ? { ...saved, status: "interrupted" as const, terminalReason: "lock-unavailable" }
            : saved;
        this.publish({ state, error: "Web Locks are not supported; export cannot start safely" });
      } catch (error: unknown) {
        this.publish({ error: errorMessage(error) });
      }
    } else {
      await this.refresh();
    }
    this.publish({ ready: true });
  }

  private buildSinkOpener(
    prepared: PreparedExport,
    handle: FileSystemDirectoryHandle | null,
    capture: { blob: (() => Promise<Blob>) | null },
    signal: AbortSignal,
  ): SinkOpener {
    return (info) => {
      if (prepared.destination !== "download-zip") {
        const createSink =
          prepared.destination === "directory" ? this.sinks.directory : this.sinks.streamed;
        return createSink(
          handle as FileSystemDirectoryHandle,
          {
            rootName: info.rootName,
            jobId: prepared.id,
          },
          signal,
        );
      }
      const memory = this.sinks.memory(info.rootName);
      capture.blob = memory.blob;
      return memory.sink;
    };
  }

  private async runOwned(
    prepared: PreparedExport,
    handle: FileSystemDirectoryHandle | null,
  ): Promise<void> {
    const job = new ExportJob(prepared, this.owner);
    this.active = job;
    this.persistenceFailure = undefined;
    this.persistenceFailed = false;
    const capture: { blob: (() => Promise<Blob>) | null } = { blob: null };
    const createSink = this.buildSinkOpener(prepared, handle, capture, job.signal);
    let openedSink: ExportSink | null = null;
    // Closure assignments are invisible to control-flow analysis; read through a typed getter.
    const sinkOf = (): ExportSink | null => openedSink;
    const openSink: SinkOpener = async (info) => {
      const sink = await createSink(info);
      openedSink = sink;
      return sink;
    };
    this.publish({ state: job.toState(), busy: true, ownsJob: true, error: null, errorCode: null });
    try {
      await this.persist(job.toState());
      this.ensureLive(job);
      job.start();
      this.publish({ state: job.toState() });
      await this.persist(job.toState());
      this.ensureLive(job);
      const result = await this.runner(
        prepared,
        (progress) => {
          this.onProgress(job, progress);
        },
        job.signal,
        openSink,
      );
      await this.persistence;
      this.ensureLive(job);
      const finalState = job.toState();
      job.updateProgress({
        current: finalState.counts.processed ?? 0,
        total: finalState.counts.total ?? 0,
        message: finalState.message,
        phase: "finalizing",
        counts: {
          ...finalState.counts,
          entriesWritten: result.receipt.entriesWritten,
          bytesWritten: result.receipt.bytesWritten,
        },
      });
      if (prepared.destination === "download-zip") {
        job.setPhase("downloading");
        this.publish({ state: job.toState() });
        await this.persist(job.toState());
        this.ensureLive(job);
        if (!capture.blob) {
          throw new Error("The export runner did not initialize the ZIP destination");
        }
        const zipBlob = await capture.blob();
        this.ensureLive(job);
        const downloadId = await this.downloader(zipBlob, result.fileName, job.signal);
        this.ensureLive(job);
        job.complete({ fileName: result.fileName, downloadId }, result.outcome);
      } else {
        job.complete(
          {
            fileName: result.fileName,
            ...(result.receipt.directoryName === undefined
              ? {}
              : { directoryName: result.receipt.directoryName }),
          },
          result.outcome,
        );
      }
      this.publish({ state: job.toState() });
      await this.persist(job.toState());
    } catch (error: unknown) {
      // The sink creator owns cleanup: a runner that throws without unwinding must not leak a native writable.
      await sinkOf()
        ?.abort(error)
        .catch(() => undefined);
      if (!isTerminalJobStatus(job.status)) {
        if (this.disposed) job.interrupt();
        else if (this.persistenceFailed)
          job.fail("Export metadata could not be saved", "persistence-failed");
        else if (isAbortError(error)) job.finishCancelled();
        else job.fail(errorMessage(error), classifyExportFailure(error) ?? "export-failed");
        this.publish({ state: job.toState() });
        try {
          await this.persist(job.toState());
        } catch {
          // persist already records the visible diagnostic and aborts live I/O.
        }
      }
      if (!this.disposed && !this.persistenceFailed && !isAbortError(error)) {
        this.publish({ error: errorMessage(error), errorCode: classifyExportFailure(error) });
      }
    } finally {
      // Queued writes and download cleanup finish before the owning lock returns.
      await this.persistence;
    }
  }

  private onProgress(job: ExportJob, progress: ProgressEvent): void {
    if (this.active !== job || job.signal.aborted || isTerminalJobStatus(job.status)) return;
    job.updateProgress(progress);
    const state = job.toState();
    this.publish({ state });
    void this.persist(state).catch(() => undefined);
  }

  private ensureLive(job: ExportJob): void {
    if (this.persistenceFailed) throw this.persistenceFailure;
    if (this.disposed) throw new DOMException("Export owner closed", "AbortError");
    job.signal.throwIfAborted();
  }

  private persist(state: ExportJobState): Promise<void> {
    const write = this.persistence.then(() => saveJobState(state));
    this.persistence = write.catch((error: unknown) => {
      if (!this.persistenceFailed) this.persistenceFailure = error;
      this.persistenceFailed = true;
      this.active?.abort(error);
      this.publish({ error: `Could not persist export metadata: ${errorMessage(error)}` });
    });
    return write;
  }

  private refresh(): Promise<void> {
    if (this.disposed || this.active || !this.locks) return Promise.resolve();
    if (this.refreshTask) {
      this.refreshAgain = true;
      return this.refreshTask;
    }
    this.refreshTask = this.reconcile()
      .catch((error: unknown) => {
        if (!this.disposed)
          this.publish({ error: `Could not read export metadata: ${errorMessage(error)}` });
      })
      .finally(() => {
        this.refreshTask = null;
        if (this.refreshAgain) {
          this.refreshAgain = false;
          void this.refresh();
        }
      });
    return this.refreshTask;
  }

  private async reconcile(): Promise<void> {
    if (!this.locks) return;
    const acquired = await this.locks.request(EXPORT_LOCK, { ifAvailable: true }, async (lock) => {
      if (this.disposed || this.active) return false;
      if (!lock) {
        await this.readForeignOwner();
        this.observeRelease();
        return false;
      }
      await this.reconcileLocked();
      return true;
    });
    if (acquired && !this.active && !this.disposed) this.publish({ busy: false, ownsJob: false });
  }

  private async readForeignOwner(): Promise<void> {
    const state = await loadLastJobState(false);
    if (!this.active && !this.disposed) this.publish({ state, busy: true, ownsJob: false });
  }

  private observeRelease(): void {
    if (this.observer || !this.locks || this.disposed) return;
    this.observer = this.locks
      .request(EXPORT_LOCK, { signal: this.lifetime.signal }, async () => {
        if (!this.disposed && !this.active) await this.reconcileLocked();
      })
      .then(() => {
        if (!this.disposed && !this.active) this.publish({ busy: false, ownsJob: false });
      })
      .catch((error: unknown) => {
        if (!this.disposed && !isAbortError(error)) this.publish({ error: errorMessage(error) });
      })
      .finally(() => {
        this.observer = null;
      });
  }

  private async reconcileLocked(): Promise<void> {
    // Never decide staleness from a read made before acquiring this lock.
    let state = await loadLastJobState();
    if (this.disposed || this.active) return;
    if (state && !isTerminalJobStatus(state.status)) {
      state = {
        ...state,
        status: "interrupted",
        completedAt: new Date().toISOString(),
        terminalReason: "owner-lost",
      };
      await saveJobState(state);
    }
    this.publish({ state });
  }

  private publish(patch: Partial<ExportControllerView>): void {
    if (this.disposed) return;
    const next = { ...this.view, ...patch };
    if (
      Object.keys(patch).every(
        (key) =>
          this.view[key as keyof ExportControllerView] === next[key as keyof ExportControllerView],
      )
    )
      return;
    if (patch.state) {
      Object.freeze(patch.state.owner);
      Object.freeze(patch.state.request);
      Object.freeze(patch.state.counts);
      if (patch.state.result) Object.freeze(patch.state.result);
      Object.freeze(patch.state);
    }
    this.view = Object.freeze(next);
    const id = next.state?.id ?? null;
    if (id !== this.watchedId && this.stopActiveWatch) {
      this.stopJobWatch?.();
      this.watchedId = id;
      this.stopJobWatch = id
        ? watchStorageKey("session", exportJobStorageKey(id), () => {
            void this.refresh();
          })
        : null;
    }
    for (const listener of this.listeners) listener();
  }
}

function destinationMismatch(
  destination: PreparedExport["destination"],
  selection: DestinationSelection,
  handle: FileSystemDirectoryHandle | null,
): string | null {
  if (destination === "download-zip") {
    return selection === "download-zip" ? null : "Download ZIP requires the download destination";
  }
  if (selection === "download-zip") {
    return `The ${destination} destination requires a native picker choice`;
  }
  return handle?.kind === "directory"
    ? null
    : `The ${destination} destination requires a directory choice`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
