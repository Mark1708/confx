export const ROUNDTRIP_FORMAT = "confx-roundtrip/2" as const;
export type RoundtripFormat = "confx-roundtrip/1" | typeof ROUNDTRIP_FORMAT;
export const MAX_ROUNDTRIP_TEXT_BYTES = 5 * 1024 * 1024;

export interface EditorSnapshot {
  representation: "editor";
  html: string;
  title: string;
  pageId?: string;
  capturedAt?: string;
}

export type RoundtripBlockKind = "paragraph" | "heading" | "table" | "code" | "opaque";

export interface RoundtripBlock {
  id: string;
  kind: RoundtripBlockKind;
  start: number;
  end: number;
  markdown: string;
  /** Exact final LF policy; fenced Markdown needs a delimiter LF even without one in source. */
  codeEndsWithNewline?: boolean;
}

export interface RoundtripPackage {
  format: RoundtripFormat;
  snapshot: EditorSnapshot;
  sourceHash: string;
  baselineMarkdown: string;
  blocks: RoundtripBlock[];
}

export interface RoundtripIssue {
  code: string;
  message: string;
  blockId?: string;
}

export interface RoundtripChange {
  blockId: string;
  kind: RoundtripBlockKind;
  before: string;
  after: string;
  supported: boolean;
}

export interface RoundtripResult {
  status: "unchanged" | "ready" | "blocked";
  /** Present only for a completely validated result; blocked changes are never partly applied. */
  html?: string;
  changes: RoundtripChange[];
  issues: RoundtripIssue[];
}
