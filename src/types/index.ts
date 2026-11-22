import type { LocaleOverride } from "@/i18n";
import type { DestinationKind, ExtractRequest } from "@/lib/export/contracts";
import type { LauncherOverride, LauncherProduct, LauncherState } from "@/lib/launcher-state";

export type DeepReadonly<T> = T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

export interface ConfluencePageMeta {
  id: string;
  title: string;
  spaceKey: string;
  baseUrl: string;
  url: string;
  version?: number;
  labels?: string[];
  ancestors?: Array<{ id: string; title: string }>;
  attachmentCount?: number;
}

export type ConfluenceExportType =
  | "single-page"
  | "block"
  | "watch-changed"
  | "subtree"
  | "space"
  | "linked-pages";

export type ExportPageOrigin = "root" | "linked" | "subtree" | "space" | "watch" | "block";

export type ExportFailureReason =
  | "not-found"
  | "permission-denied"
  | "unsupported-link"
  | "page-limit"
  | "linked-asset-limit"
  | "layout-unsupported"
  | "fetch-failed"
  | "attachment-list-failed"
  | "attachment-download-failed";

export interface ExportFailure {
  scope: "page" | "linked-page" | "attachment" | "linked-asset";
  page_id?: string;
  from_page_id?: string;
  href?: string;
  reason: ExportFailureReason;
  status?: number;
}

export interface AttachmentExtractionOutcome {
  declared: number | null;
  listed: number;
  eligible: number;
  archived: number;
  skippedSize: number;
  failedDownloads: number;
}
export interface LayoutExtractionOutcome {
  status: "none" | "preserved" | "flattened";
  sections: number;
}

export interface PageExtractionOutcome {
  attachments: AttachmentExtractionOutcome;
  plantUml: PlantUmlExtractionOutcome;
  layout: LayoutExtractionOutcome;
  failures: ExportFailure[];
}

export interface ConfluenceExportManifestAttachmentOutcome {
  declared: number | null;
  listed: number;
  eligible: number;
  archived: number;
  skipped_size: number;
  failed_downloads: number;
}

export interface ConfluenceExportManifestPlantUmlOutcome {
  discovered: number;
  archived: number;
  skipped_limit: number;
  failed_downloads: number;
  unsupported: number;
}
export interface ConfluenceExportManifestLayoutOutcome {
  status: LayoutExtractionOutcome["status"];
  sections: number;
}

export interface ConfluenceExportManifestPage {
  id: string;
  title: string;
  version: number | null;
  url: string;
  space: string | null;
  parent_id: string | null;
  ancestors: Array<{ id: string; title: string }>;
  archive_path: string;
  origin: ExportPageOrigin;
  link_depth: number | null;
  discovered_from: string[];
  attachment_outcome: ConfluenceExportManifestAttachmentOutcome;
  plantuml_outcome: ConfluenceExportManifestPlantUmlOutcome;
  layout_outcome: ConfluenceExportManifestLayoutOutcome;
  editable: ConfluenceExportManifestEditable;
}

export interface ConfluenceExportManifestSource {
  host: string;
  pageId?: string;
  rootPageId?: string;
  rootTitle?: string;
  title?: string;
  version?: number | null;
  space?: string | null;
  spaceKey?: string;
  spaceName?: string;
  url?: string;
  labels?: string[];
  ancestors?: Array<{ id: string; title: string }>;
  requestedPages?: number;
  skippedPages?: number;
}

export type ConfluenceExportManifestEditable =
  | {
      metadata_version: 1;
      status: "available";
      path: string;
      representation: "storage";
      version: number;
      source_hash: string;
    }
  | {
      metadata_version: 1;
      status: "unavailable";
      reason: EditableUnavailableReason;
    };

export interface ConfluenceExportManifest {
  manifest_version: 2;
  type: ConfluenceExportType;
  exported_at: string;
  preset: string;
  source: ConfluenceExportManifestSource;
  counts: {
    pages: number;
    tables_csv: number;
    images: number;
    attachments: number;
    plantuml_diagrams: number;
    requested_pages?: number;
    exported_pages?: number;
    skipped_pages?: number;
  };
  pages: ConfluenceExportManifestPage[];
  failures: ExportFailure[];
}

export interface ConfluenceExportInventory {
  page: ConfluenceExportManifestPage;
  counts: {
    tables_csv: number;
    images: number;
    attachments: number;
    plantuml_diagrams: number;
  };
  failures: ExportFailure[];
}

export interface BuildConfluenceExportManifestOptions {
  type: ConfluenceExportType;
  exportedAt?: string;
  preset: string;
  source: ConfluenceExportManifestSource;
  pages: readonly ConfluenceExportInventory[];
  failures?: readonly ExportFailure[];
  additionalCounts?: {
    requested_pages?: number;
    exported_pages?: number;
    skipped_pages?: number;
  };
}

export interface PageTreeNode {
  id: string;
  title: string;
  hasChildren: boolean;
  children?: PageTreeNode[];
  depth: number;
}

export type RuleAction = "skip" | "to-csv" | "to-md" | "extract-images" | "keep-html" | "gfm-table";

export type RuleType = "selector" | "section" | "spoiler" | "table";

export interface ExtractionRule {
  id: string;
  name: string;
  type: RuleType;
  /** CSS-selector for `selector`/`table`; regex source for `section`. */
  matcher: string;
  action: RuleAction;
  enabled: boolean;
  /** Options flag-bag, e.g. { inlineImages: true, dropTitle: false } */
  options?: Record<string, boolean | string | number>;
}

export interface RulePreset {
  id: string;
  name: string;
  description: string;
  rules: ExtractionRule[];
}

export type ExportPresetId = "md-attachments" | "md-only" | "tables-only";

export interface ExportDefaults {
  presetId: ExportPresetId;
  package: {
    editable: boolean;
    images: boolean;
    attachments: boolean;
    plantUmlAssets: boolean;
    comments: boolean;
    history: boolean;
  };
  conversion: {
    includeFrontMatter: boolean;
    rewriteInternalLinks: boolean;
    deduplicateAssets: boolean;
    presetRules: ExtractionRule[];
  };
  maxDepth: number | null;
}

export type Theme = "light" | "dark" | "system";

export type ThemePalette = "violet" | "blue" | "forest" | "graphite" | "amber";

export type AppLocaleOverride = LocaleOverride;

export interface AppSettings {
  /** Settings schema version for migration tracking. */
  version: number;
  exportDefaults: ExportDefaults;
  confluenceBaseUrl?: string;
  concurrency: number;
  requestTimeout: number;
  maxRetries: number;
  maxConcurrency: number;
  maxAttachmentSize: number;
  customRules: ExtractionRule[];
  showConfluenceButton: boolean;
  showJiraButton: boolean;
  /** Базовый размер шрифта UI в px. Влияет на весь масштаб через rem. */
  fontSize: number;
  theme: Theme;
  palette: ThemePalette;
  locale: AppLocaleOverride;
}

export interface ExtractPageRequest {
  kind: "extract-page";
  pageId: string;
  host: string;
  presetId: string;
  /** Body-link traversal depth. Undefined preserves legacy root-only export. */
  linkedPageDepth?: number;
}

export interface ExtractWatchChangedRequest {
  kind: "extract-watch-changed";
  host: string;
  presetId: string;
  pageIds: string[];
  rootTitle: string;
  diff: unknown;
}

export interface ExtractSubtreeRequest {
  kind: "extract-subtree";
  rootPageId: string;
  host: string;
  presetId: string;
  /** Optional depth cap. Undefined means unlimited. */
  maxDepth?: number;
}

export interface SpaceExportOptions {
  label?: string;
  prefix?: string;
}

export interface ExtractSpaceRequest {
  kind: "extract-space";
  spaceKey: string;
  host: string;
  presetId: string;
  /** Optional depth cap. Undefined means unlimited. */
  maxDepth?: number;
  options?: SpaceExportOptions;
}

export interface ExtractBlockRequest {
  kind: "extract-block";
  html: string;
  pageMeta: ConfluencePageMeta;
  presetId: string;
}

export interface GetPageInfoRequest {
  kind: "get-page-info";
  host: string;
  pageId: string;
}

export interface GetChildrenRequest {
  kind: "get-children";
  host: string;
  pageId: string;
}

export interface StartPickerRequest {
  kind: "start-picker";
  tabId: number;
}

export interface OpenWorkspaceRequest {
  kind: "open-workspace";
  sourceTabId: number;
  tool: "export" | "edit";
}

export interface UpdateLauncherStateRequest {
  kind: "update-launcher-state";
  origin: string;
  product: LauncherProduct;
  /** Null removes this site's override; other sites are never replaced by a caller. */
  patch: Partial<LauncherOverride> | null;
}

export type UpdateLauncherStateResponse =
  | { ok: true; state: LauncherState }
  | { ok: false; error: string };

export type OpenConfxRequest = {
  kind: "open-confx";
  source: "confluence" | "jira";
  host: string;
  pageId?: string;
  issueKey?: string;
  title?: string;
};

export type ExtensionRequest =
  | ExtractPageRequest
  | ExtractWatchChangedRequest
  | ExtractSubtreeRequest
  | ExtractBlockRequest
  | ExtractSpaceRequest
  | ExtractJiraIssueRequest
  | ExtractJiraSearchRequest
  | GetPageInfoRequest
  | GetChildrenRequest
  | StartPickerRequest
  | OpenWorkspaceRequest
  | UpdateLauncherStateRequest
  | OpenConfxRequest;

export interface PickerResult {
  kind: "picker-result";
  html: string;
  meta: ConfluencePageMeta;
}

export type ExtensionMessage = ExtensionRequest | PickerResult;

export interface AttachmentInfo {
  id: string;
  title: string;
  mediaType: string;
  fileSize: number;
  downloadPath: string;
  containerId: string;
}

export interface SpaceInfo {
  key: string;
  name: string;
  homepageId: string;
  /** Description (may be empty) */
  description?: string;
}

export interface ExtractedTable {
  /** CSV text */
  csv: string;
  /** Suggested filename without extension */
  name: string;
  /** Section heading preceding the table, if any */
  section?: string;
}

export interface ExtractedImage {
  /** Original src or data-image-src */
  sourceUrl: string;
  /** Package-content-root-relative path, including the owning page folder. */
  archivePath: string;
  /** Binary content */
  blob: Blob;
  /** SHA-256 hex of the blob, for dedup */
  hash: string;
}

export interface ArchivedPlantUmlFile {
  archivePath: string;
  fileName: string;
  mediaType: string;
  fileSize: number;
  blob: Blob;
  hash: string;
}

export interface ExtractedPlantUmlAsset {
  png: ArchivedPlantUmlFile;
  source: ArchivedPlantUmlFile;
}

export interface PlantUmlExtractionOutcome {
  discovered: number;
  archived: number;
  skippedLimit: number;
  failedDownloads: number;
  unsupported: number;
}

export interface AttachmentReference {
  sourceUrl: string;
  /** Present only for an archived resource, never for a skipped download. */
  archivePath?: string;
  fileName: string;
  mediaType: string;
  fileSize: number;
  skipped?: boolean;
  skipReason?: string;
}

export interface ExtractedAttachment extends AttachmentReference {
  archivePath: string;
  blob: Blob;
  hash: string;
}

export interface ExtractedComment {
  id: string;
  author: string;
  createdAt: string;
  body: string;
  /** Markdown version of comment body */
  markdown: string;
  attachments: AttachmentReference[];
}
export interface ExtractedInlineCommentReply {
  id: string;
  author: string;
  updatedAt: string;
  body: string;
  /** Markdown version of inline comment body */
  markdown: string;
  attachments: AttachmentReference[];
}

export interface ExtractedInlineComment extends ExtractedInlineCommentReply {
  selection: string;
  markerRef: string;
  status: "open" | "resolved";
  replies: ExtractedInlineCommentReply[];
}

export interface VersionInfo {
  number: number;
  author: string;
  date: string;
  message?: string;
}

export type EditableUnavailableReason =
  | "filtered-content"
  | "source-unavailable"
  | "invalid-source"
  | "partial-export";

export type ExtractedPageEditable =
  | {
      status: "available";
      markdown: string;
      representation: "storage";
      version: number;
      sourceHash: string;
    }
  | { status: "unavailable"; reason: EditableUnavailableReason };

export interface ExtractedPage {
  meta: ConfluencePageMeta;
  markdown: string;
  /** Self-contained storage editing sidecar; absent on legacy hand-constructed pages. */
  editable?: ExtractedPageEditable;
  tables: ExtractedTable[];
  images: ExtractedImage[];
  attachments: ExtractedAttachment[];
  plantUmlAssets: ExtractedPlantUmlAsset[];
  commentAttachments: ExtractedAttachment[];
  comments: ExtractedComment[];
  inlineComments: ExtractedInlineComment[];
  history: VersionInfo[];
  /** Folder inside ZIP (for subtree export) */
  folder: string;
  outcome: PageExtractionOutcome;
}

export type SubscriptionScope = "page" | "subtree";

export type ExportJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "interrupted";

export type ExportJobPhase = "discovering" | "reading" | "writing" | "finalizing" | "downloading";

export interface ExportJobOwner {
  instanceId: string;
  surface: "panel" | "popup" | "workspace" | "unknown";
  tabId?: number;
  windowId?: number;
}

export interface ExportJobCounts {
  processed: number | null;
  total: number | null;
  successfulPages: number | null;
  failedPages: number | null;
  successfulResources: number | null;
  failedResources: number | null;
  entriesWritten: number | null;
  bytesWritten: number | null;
}

export interface ExportRequestSummary {
  kind: ExtractRequest["kind"];
  destination: DestinationKind;
  presetId?: ExportPresetId;
  pageId?: string;
  rootPageId?: string;
  spaceKey?: string;
  issueKey?: string;
  selectionCount?: number;
  maxDepth?: number | null;
}

export interface ExportJobState {
  version: 2;
  id: string;
  sourceKey: string;
  owner: ExportJobOwner;
  request: ExportRequestSummary;
  status: ExportJobStatus;
  phase: ExportJobPhase | null;
  message: string;
  counts: ExportJobCounts;
  cancelRequested: boolean;
  error?: string;
  result?: { fileName: string; downloadId?: number; directoryName?: string };
  startedAt?: string;
  completedAt?: string;
  terminalReason?: string;
}

// ─── Jira Types ─────────────────────────────────────────────────────

export interface JiraIssueMeta {
  key: string;
  project: string;
  type: string;
  status: string;
  priority: string;
  resolution: string | null;
  summary: string;
  assignee: string | null;
  reporter: string | null;
  labels: string[];
  components: string[];
  versions: string[];
  fixVersions: string[];
  epicLink: string | null;
  /** ISO date string */
  created: string;
  /** ISO date string */
  updated: string;
  /** ISO date string or null */
  dueDate: string | null;
  baseUrl: string;
  url: string;
}

export interface JiraComment {
  id: string;
  author: string;
  createdAt: string;
  body: string;
  markdown: string;
}

export interface JiraAttachment {
  id: string;
  fileName: string;
  mediaType: string;
  fileSize: number;
  contentUrl: string;
}

export interface ExtractedJiraIssue {
  meta: JiraIssueMeta;
  description: string;
  comments: JiraComment[];
  attachments: JiraAttachment[];
  /** Markdown output */
  markdown: string;
  /** JSON output (structured) */
  json: Record<string, unknown>;
  /** CSV row (flat) */
  csvRow: string;
}

export interface ExtractJiraIssueRequest {
  kind: "extract-jira-issue";
  issueKey: string;
  host: string;
}

export interface ExtractJiraSearchRequest {
  kind: "extract-jira-search";
  jql: string;
  host: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly statusText: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class RateLimitError extends ApiError {
  constructor(message: string, status: number, statusText: string, path: string) {
    super(message, status, statusText, path);
    this.name = "RateLimitError";
  }
}

export class AuthError extends ApiError {
  constructor(message: string, status: number, statusText: string, path: string) {
    super(message, status, statusText, path);
    this.name = "AuthError";
  }
}

export class NetworkError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "NetworkError";
  }
}
