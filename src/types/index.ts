import type { LocaleOverride } from "@/i18n";

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

export type OutputFormat = "md-csv-images" | "md-only" | "html-archive";

export type Theme = "light" | "dark";

export type AppLocaleOverride = LocaleOverride;

export interface AppSettings {
  /** Settings schema version for migration tracking. */
  version: number;
  /** Confluence host — filled from current tab on first use, editable. */
  host: string;
  confluenceBaseUrl?: string;
  outputFormat: OutputFormat;
  concurrency: number;
  requestTimeout: number;
  maxRetries: number;
  maxConcurrency: number;
  includeFrontMatter: boolean;
  includeComments: boolean;
  includeHistory: boolean;
  rewriteInternalLinks: boolean;
  deduplicateImages: boolean;
  exportAttachments: boolean;
  maxAttachmentSize: number;
  skipUnchanged: boolean;
  maxDepth: number;
  activePresetId: string;
  customRules: ExtractionRule[];
  showConfluenceButton: boolean;
  showJiraButton: boolean;
  /** Базовый размер шрифта UI в px. Влияет на весь масштаб через rem. */
  fontSize: number;
  theme: Theme;
  locale: AppLocaleOverride;
}

export interface ExtractPageRequest {
  kind: "extract-page";
  pageId: string;
  host: string;
  presetId: string;
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

export interface OpenMdViewerRequest {
  kind: "open-md-viewer";
  host: string;
  pageId: string;
  title?: string;
}

export type OpenJiraExportRequest = {
  kind: "open-jira-export";
  issueKey: string;
  host: string;
};

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
  | OpenMdViewerRequest
  | OpenJiraExportRequest
  | OpenConfxRequest;

export interface ProgressUpdate {
  kind: "progress";
  jobId: string;
  current: number;
  total: number;
  message: string;
  bytesDownloaded?: number;
}

export interface ExtractResult {
  kind: "extract-result";
  jobId: string;
  ok: boolean;
  error?: string;
  zipBase64?: string;
  fileName?: string;
}

export interface PickerResult {
  kind: "picker-result";
  html: string;
  meta: ConfluencePageMeta;
}

export type ExtensionMessage = ExtensionRequest | ProgressUpdate | ExtractResult | PickerResult;

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
  /** Path inside the ZIP (e.g. "images/foo.png") */
  zipPath: string;
  /** Binary content */
  blob: Blob;
  /** SHA-256 hex of the blob, for dedup */
  hash: string;
}

export interface ExtractedAttachment {
  sourceUrl: string;
  zipPath: string;
  blob: Blob;
  hash: string;
  fileName: string;
  mediaType: string;
  fileSize: number;
  skipped?: boolean;
  skipReason?: string;
}

export interface ExtractedComment {
  id: string;
  author: string;
  createdAt: string;
  body: string;
  /** Markdown version of comment body */
  markdown: string;
}

export interface VersionInfo {
  number: number;
  author: string;
  date: string;
  message?: string;
}

export interface ExtractedPage {
  meta: ConfluencePageMeta;
  markdown: string;
  tables: ExtractedTable[];
  images: ExtractedImage[];
  attachments: ExtractedAttachment[];
  comments: ExtractedComment[];
  history: VersionInfo[];
  /** Folder inside ZIP (for subtree export) */
  folder: string;
}

export type SubscriptionScope = "page" | "subtree";

export type ExportJobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface ExportJobConfig {
  kind:
    | "extract-page"
    | "extract-watch-changed"
    | "extract-subtree"
    | "extract-block"
    | "extract-space"
    | "extract-jira-issue"
    | "extract-jira-search";
  host: string;
  presetId?: string;
  pageId?: string;
  rootPageId?: string;
  spaceKey?: string;
  spaceOptions?: SpaceExportOptions;
  maxDepth?: number;
  html?: string;
  pageMeta?: ConfluencePageMeta;
  issueKey?: string;
  jql?: string;
}

export interface ExportProgressEvent {
  jobId: string;
  status: ExportJobStatus;
  current: number;
  total: number;
  message: string;
  /** Number of pages processed */
  pagesDone?: number;
  /** Total pages to process */
  pagesTotal?: number;
  /** Bytes downloaded so far */
  bytesDownloaded?: number;
}

export interface ExportJobState {
  id: string;
  status: ExportJobStatus;
  config: ExportJobConfig;
  progress: { current: number; total: number; message: string };
  error?: string;
  result?: { fileName: string };
  startedAt?: string;
  completedAt?: string;
  /** For subtree resume: index of last successfully processed page */
  resumeFromIndex?: number;
  /** Serialized list of already-processed page IDs for resume */
  processedPageIds?: string[];
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
