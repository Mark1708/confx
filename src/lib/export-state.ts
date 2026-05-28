import type { ConfluencePageMeta, ExportJobConfig, ExportJobState, ExportJobStatus } from "@/types";
import { storage } from "@/lib/browser";

const EXPORT_STATE_VERSION = 1;
const STORAGE_KEY_PREFIX = "cx:exportJob:";

export function serializeJobState(state: ExportJobState): string {
  return JSON.stringify({ version: EXPORT_STATE_VERSION, ...state });
}

export function deserializeJobState(json: string): ExportJobState | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return parseSerializedJobState(parsed);
  } catch (_error: unknown) {
    return null;
  }
}

export async function saveJobState(state: ExportJobState): Promise<void> {
  try {
    await storage.session.set({ [getStorageKey(state.id)]: serializeJobState(state) });
  } catch (_error: unknown) {
    return;
  }
}

export async function loadJobState(jobId: string): Promise<ExportJobState | null> {
  try {
    const items = await storage.session.get(getStorageKey(jobId));
    const value: unknown = items[getStorageKey(jobId)];
    return typeof value === "string" ? deserializeJobState(value) : null;
  } catch (_error: unknown) {
    return null;
  }
}

export async function loadLastJobState(): Promise<ExportJobState | null> {
  try {
    const items = await storage.session.get(null);
    const states = Object.entries(items)
      .filter(([key]) => key.startsWith(STORAGE_KEY_PREFIX))
      .map(([, value]) => (typeof value === "string" ? deserializeJobState(value) : null))
      .filter(isExportJobState);

    return findMostRecentJobState(states);
  } catch (_error: unknown) {
    return null;
  }
}

export async function clearJobState(jobId: string): Promise<void> {
  try {
    await storage.session.remove(getStorageKey(jobId));
  } catch (_error: unknown) {
    return;
  }
}

function getStorageKey(jobId: string): string {
  return `${STORAGE_KEY_PREFIX}${jobId}`;
}

function parseSerializedJobState(value: unknown): ExportJobState | null {
  if (!isRecord(value) || value.version !== EXPORT_STATE_VERSION) return null;

  const state = parseJobState(value);
  if (!state) return null;

  return state;
}

function parseJobState(value: Record<string, unknown>): ExportJobState | null {
  const config = parseConfig(value.config);
  const progress = parseProgress(value.progress);

  if (!isString(value.id) || !isStatus(value.status) || !config || !progress) return null;

  const error = parseOptionalString(value.error);
  const result = parseResult(value.result);
  const startedAt = parseOptionalString(value.startedAt);
  const completedAt = parseOptionalString(value.completedAt);
  const resumeFromIndex = parseOptionalNumber(value.resumeFromIndex);
  const processedPageIds = parseOptionalStringArray(value.processedPageIds);

  if (
    error === null ||
    result === null ||
    startedAt === null ||
    completedAt === null ||
    resumeFromIndex === null ||
    processedPageIds === null
  ) {
    return null;
  }

  return {
    id: value.id,
    status: value.status,
    config,
    progress,
    error,
    result,
    startedAt,
    completedAt,
    resumeFromIndex,
    processedPageIds,
  };
}

function parseConfig(value: unknown): ExportJobConfig | null {
  if (!isRecord(value) || !isExportKind(value.kind) || !isString(value.host)) {
    return null;
  }

  const presetId = parseOptionalString(value.presetId);
  const pageId = parseOptionalString(value.pageId);
  const rootPageId = parseOptionalString(value.rootPageId);
  const spaceKey = parseOptionalString(value.spaceKey);
  const spaceOptions = parseOptionalSpaceOptions(value.spaceOptions);
  const maxDepth = parseOptionalNumber(value.maxDepth);
  const html = parseOptionalString(value.html);
  const pageMeta = parseOptionalPageMeta(value.pageMeta);
  const issueKey = parseOptionalString(value.issueKey);
  const jql = parseOptionalString(value.jql);

  if (
    presetId === null ||
    pageId === null ||
    rootPageId === null ||
    spaceKey === null ||
    spaceOptions === null ||
    maxDepth === null ||
    html === null ||
    pageMeta === null ||
    issueKey === null ||
    jql === null
  ) {
    return null;
  }

  return {
    kind: value.kind,
    host: value.host,
    presetId,
    pageId,
    rootPageId,
    spaceKey,
    spaceOptions,
    maxDepth,
    html,
    pageMeta,
    issueKey,
    jql,
  };
}

function parseOptionalSpaceOptions(value: unknown): ExportJobConfig["spaceOptions"] | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;

  const label = parseOptionalString(value.label);
  const prefix = parseOptionalString(value.prefix);
  if (label === null || prefix === null) return null;

  return {
    ...(label === undefined ? {} : { label }),
    ...(prefix === undefined ? {} : { prefix }),
  };
}

function parseProgress(value: unknown): ExportJobState["progress"] | null {
  if (!isRecord(value) || !isNumber(value.current) || !isNumber(value.total) || !isString(value.message)) {
    return null;
  }

  return { current: value.current, total: value.total, message: value.message };
}

function parseResult(value: unknown): { fileName: string } | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !isString(value.fileName)) return null;
  return { fileName: value.fileName };
}

function parseOptionalPageMeta(value: unknown): ConfluencePageMeta | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  if (
    !isString(value.id) ||
    !isString(value.title) ||
    !isString(value.spaceKey) ||
    !isString(value.baseUrl) ||
    !isString(value.url)
  ) {
    return null;
  }

  const version = parseOptionalNumber(value.version);
  const labels = parseOptionalStringArray(value.labels);
  const ancestors = parseOptionalAncestors(value.ancestors);
  const attachmentCount = parseOptionalNumber(value.attachmentCount);

  if (version === null || labels === null || ancestors === null || attachmentCount === null) return null;

  return {
    id: value.id,
    title: value.title,
    spaceKey: value.spaceKey,
    baseUrl: value.baseUrl,
    url: value.url,
    version,
    labels,
    ancestors,
    attachmentCount,
  };
}

function parseOptionalAncestors(value: unknown): ConfluencePageMeta["ancestors"] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;

  const ancestors = value.map(parseAncestor);
  if (ancestors.some((ancestor) => ancestor === null)) return null;

  return ancestors.filter(isAncestor);
}

function parseAncestor(value: unknown): { id: string; title: string } | null {
  if (!isRecord(value) || !isString(value.id) || !isString(value.title)) return null;
  return { id: value.id, title: value.title };
}

function isAncestor(value: { id: string; title: string } | null): value is { id: string; title: string } {
  return value !== null;
}

function parseOptionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return isString(value) ? value : null;
}

function parseOptionalNumber(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return isNumber(value) ? value : null;
}

function parseOptionalStringArray(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  return value.every(isString) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExportJobState(value: ExportJobState | null): value is ExportJobState {
  return value !== null;
}

function findMostRecentJobState(states: ExportJobState[]): ExportJobState | null {
  return states.reduce<ExportJobState | null>((latest, state) => {
    if (!latest) return state;
    return getStateTime(state) > getStateTime(latest) ? state : latest;
  }, null);
}

function getStateTime(state: ExportJobState): number {
  const timestamp = state.completedAt ?? state.startedAt;
  if (!timestamp) return 0;

  const time = Date.parse(timestamp);
  return Number.isNaN(time) ? 0 : time;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStatus(value: unknown): value is ExportJobStatus {
  return (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function isExportKind(value: unknown): value is ExportJobConfig["kind"] {
  return (
    value === "extract-page" ||
    value === "extract-subtree" ||
    value === "extract-block" ||
    value === "extract-space" ||
    value === "extract-jira-issue" ||
    value === "extract-jira-search"
  );
}
