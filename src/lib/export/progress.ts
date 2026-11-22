import type { ExportOutcome, ProgressEvent, ProgressHandler } from "./contracts";

export function p(
  handler: ProgressHandler | undefined,
  current: number,
  total: number,
  message: string,
  detail?: Pick<ProgressEvent, "phase" | "counts">,
): void {
  handler?.({ current, total, message, ...detail });
}

export function outcomeCounts(outcome: ExportOutcome): Omit<ExportOutcome, "partial"> {
  return {
    successfulPages: outcome.successfulPages,
    failedPages: outcome.failedPages,
    successfulResources: outcome.successfulResources,
    failedResources: outcome.failedResources,
    entriesWritten: outcome.entriesWritten,
  };
}
