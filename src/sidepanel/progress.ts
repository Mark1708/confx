import type { createTranslator } from "@/i18n";

export interface ProgressEvent {
  current: number;
  total: number;
  message: string;
}

export type ProgressHandler = (p: ProgressEvent) => void;
export type ProgressTranslator = ReturnType<typeof createTranslator>;

export function p(
  handler: ProgressHandler | undefined,
  current: number,
  total: number,
  message: string,
): void {
  handler?.({ current, total, message });
}

export function buildArchiveProgress(t: ProgressTranslator, skippedPages: number): string {
  if (skippedPages > 0) {
    return t("export.progress.buildingArchiveWithSkipped", {
      count: skippedPages,
    });
  }

  return t("export.progress.buildingArchive");
}

export function buildSkippedSuffix(t: ProgressTranslator, skippedPages: number): string {
  return skippedPages > 0 ? t("export.progress.skippedSuffix", { count: skippedPages }) : "";
}
