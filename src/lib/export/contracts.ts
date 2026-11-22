import type { I18nKey, Translator } from "@/i18n";
import type { FetchOptions } from "@/lib/http-client";
import type { SourceContext } from "@/lib/source-context";
import type {
  AppLocaleOverride,
  DeepReadonly,
  ExportDefaults,
  ExportJobCounts,
  ExportJobPhase,
  ExtensionRequest,
  ExtractionRule,
} from "@/types";

export type ExtractRequest = Extract<
  ExtensionRequest,
  {
    kind:
      | "extract-page"
      | "extract-watch-changed"
      | "extract-subtree"
      | "extract-block"
      | "extract-space"
      | "extract-jira-issue"
      | "extract-jira-search";
  }
>;

export type JiraExtractRequest = Extract<
  ExtractRequest,
  { kind: "extract-jira-issue" | "extract-jira-search" }
>;
export type ConfluenceExtractRequest = Exclude<ExtractRequest, JiraExtractRequest>;

const EXTRACT_REQUEST_KINDS: ReadonlySet<string> = new Set([
  "extract-page",
  "extract-watch-changed",
  "extract-subtree",
  "extract-block",
  "extract-space",
  "extract-jira-issue",
  "extract-jira-search",
]);

/** Runtime narrowing for message payloads that reach the export pipeline. */
export function isExtractRequest(request: ExtensionRequest): request is ExtractRequest {
  return EXTRACT_REQUEST_KINDS.has(request.kind);
}

export type DestinationKind = "download-zip" | "directory" | "streamed-zip";

export interface PreparedExport<R extends ExtractRequest = ExtractRequest> {
  readonly id: string;
  readonly source: Readonly<SourceContext>;
  readonly request: DeepReadonly<R>;
  readonly defaults: DeepReadonly<ExportDefaults>;
  readonly effectiveRules: readonly DeepReadonly<ExtractionRule>[];
  readonly network: Readonly<FetchOptions>;
  readonly discoveryConcurrency: number;
  readonly maxAttachmentSize: number;
  readonly rootName: string;
  readonly destination: DestinationKind;
  readonly locale: AppLocaleOverride;
}

export interface ExportRunDraft {
  request: ExtractRequest;
  defaults: ExportDefaults;
  destination: DestinationKind;
}

export interface ExportOutcome {
  partial: boolean;
  successfulPages: number;
  failedPages: number;
  successfulResources: number | null;
  failedResources: number | null;
  entriesWritten: number | null;
}

export interface ProgressEvent {
  current: number;
  total: number;
  message: string;
  phase?: ExportJobPhase;
  counts?: Partial<ExportJobCounts>;
}

export type ProgressHandler = (p: ProgressEvent) => void;
export type ProgressTranslator = Translator<I18nKey>;

export interface ArchiveEntry {
  path: string;
  body: Blob | string;
}

export type EmitEntry = (entry: ArchiveEntry) => Promise<void>;

export interface ExportPackageInfo {
  rootName: string;
  fileName: string;
}

export interface ExportContext {
  signal: AbortSignal;
  onProgress?: ProgressHandler;
  onPackage(info: ExportPackageInfo): void;
}

export interface ExportSummary extends ExportPackageInfo {
  outcome: ExportOutcome;
}

export interface ExportReceipt {
  fileName: string;
  downloadId?: number;
  directoryName?: string;
  entriesWritten: number;
  bytesWritten: number;
}

export interface ExportSinkStats {
  entriesWritten: number;
  bytesWritten: number;
}

export interface ExportSink {
  write(entry: ArchiveEntry, signal: AbortSignal): Promise<void>;
  finish(summary: ExportSummary, signal: AbortSignal): Promise<ExportReceipt>;
  abort(reason: unknown): Promise<void>;
  stats(): ExportSinkStats;
}
