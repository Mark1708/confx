import { produceConfluenceExport } from "@/lib/export/confluence";
import type {
  ArchiveEntry,
  ConfluenceExtractRequest,
  ExportContext,
  ExportOutcome,
  ExportPackageInfo,
  ExportReceipt,
  ExportSink,
  ExportSummary,
  JiraExtractRequest,
  PreparedExport,
  ProgressEvent,
  ProgressHandler,
} from "@/lib/export/contracts";
import { produceJiraExport } from "@/lib/export/jira";

/**
 * Sinks are constructed exactly once, when package metadata is known: the ZIP sinks
 * need the archive root name for their encoder, and the directory sink needs it for
 * the created folder name. `onPackage` fires before the first emit, so construction
 * started there is awaited before the first write.
 */
export type SinkOpener = (info: ExportPackageInfo) => ExportSink | Promise<ExportSink>;

export interface ExportRunResult {
  fileName: string;
  outcome: ExportOutcome;
  receipt: ExportReceipt;
}

export type ExportRunner = (
  prepared: PreparedExport,
  onProgress: ProgressHandler,
  signal: AbortSignal,
  openSink: SinkOpener,
) => Promise<ExportRunResult>;

/** Destination write failures stay distinguishable from producer errors at the terminal state. */
export class SinkWriterError extends Error {
  constructor(cause: unknown) {
    super("Writing to the export destination failed", { cause });
    this.name = "SinkWriterError";
  }
}

/** Sink-agnostic run: producers emit entries, the injected sink decides where they land. */
export const runExport: ExportRunner = async (prepared, onProgress, signal, openSink) => {
  signal.throwIfAborted();
  let sink: ExportSink | undefined;
  let opened: Promise<{ sink: ExportSink } | { error: unknown }> | undefined;
  let info: ExportPackageInfo | undefined;
  let latest: ProgressEvent | undefined;
  const report = (progress: ProgressEvent) => {
    latest = progress;
    onProgress({
      ...progress,
      counts: {
        ...progress.counts,
        entriesWritten: sink?.stats().entriesWritten ?? 0,
        bytesWritten: sink?.stats().bytesWritten ?? 0,
      },
    });
  };
  const context: ExportContext = {
    signal,
    onProgress: report,
    onPackage(packageInfo) {
      if (info) throw new Error("Export package was already initialized");
      info = { rootName: packageInfo.rootName, fileName: packageInfo.fileName };
      opened = Promise.resolve(openSink(info)).then(
        (created) => {
          sink = created;
          return { sink: created };
        },
        (error: unknown) => ({ error }),
      );
    },
  };
  const emit = async (entry: ArchiveEntry) => {
    signal.throwIfAborted();
    if (!opened) throw new Error("Export package metadata is missing before its first entry");
    const opening = await opened;
    if ("error" in opening) throw opening.error;
    const active = opening.sink;
    try {
      await active.write(entry, signal);
    } catch (error) {
      // Cancellation keeps its native abort identity; real write failures are marked.
      if (signal.aborted) throw error;
      throw new SinkWriterError(error);
    }
    if (latest) report({ ...latest, phase: "writing" });
  };
  try {
    const summary: ExportSummary =
      prepared.request.kind === "extract-jira-issue" ||
      prepared.request.kind === "extract-jira-search"
        ? await produceJiraExport(prepared as PreparedExport<JiraExtractRequest>, context, emit)
        : await produceConfluenceExport(
            prepared as PreparedExport<ConfluenceExtractRequest>,
            context,
            emit,
          );
    signal.throwIfAborted();
    if (
      !opened ||
      !info ||
      info.rootName !== summary.rootName ||
      info.fileName !== summary.fileName
    ) {
      throw new Error("Export package metadata changed during production");
    }
    const opening = await opened;
    if ("error" in opening) throw opening.error;
    const active = opening.sink;
    if (latest) report({ ...latest, phase: "finalizing" });
    let receipt: ExportReceipt;
    try {
      receipt = await active.finish(summary, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new SinkWriterError(error);
    }
    signal.throwIfAborted();
    if (latest) report({ ...latest, phase: "finalizing" });
    return {
      fileName: receipt.fileName,
      outcome: { ...summary.outcome, entriesWritten: receipt.entriesWritten },
      receipt,
    };
  } catch (error) {
    try {
      const opening = opened ? await opened : null;
      const created = sink ?? (opening && "sink" in opening ? opening.sink : null);
      await created?.abort(error);
    } catch {
      // The original failure wins; sink abort is best-effort terminal cleanup.
    }
    throw error;
  }
};
