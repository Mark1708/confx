import { storage } from "@/lib/browser";
import { normalizePresetId } from "@/lib/rule-engine";
import type {
  ExportJobCounts,
  ExportJobOwner,
  ExportJobPhase,
  ExportJobState,
  ExportJobStatus,
  ExportPresetId,
  ExportRequestSummary,
} from "@/types";

export const EXPORT_ACTIVE_KEY = "cx.export.active.v2";
const JOB_PREFIX = "cx.exportJob.v2:";
const LEGACY_PREFIX = "cx:exportJob:";
const COUNT_KEYS: Array<keyof ExportJobCounts> = [
  "processed",
  "total",
  "successfulPages",
  "failedPages",
  "successfulResources",
  "failedResources",
  "entriesWritten",
  "bytesWritten",
];

export function exportJobStorageKey(id: string): string {
  return `${JOB_PREFIX}${id}`;
}

export function serializeJobState(state: ExportJobState): string {
  const metadata = parseState(state);
  if (!metadata) throw new Error("Invalid export job metadata");
  return JSON.stringify(metadata);
}

export function deserializeJobState(json: string): ExportJobState | null {
  try {
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if ("version" in value && value.version === 1)
      return migrateLegacyState(value as Record<string, unknown>);
    return parseState(value);
  } catch {
    return null;
  }
}

export async function saveJobState(state: ExportJobState): Promise<void> {
  await storage.session.set({
    [exportJobStorageKey(state.id)]: serializeJobState(state),
    [EXPORT_ACTIVE_KEY]: state.id,
  });
}

export async function loadJobState(id: string): Promise<ExportJobState | null> {
  const key = exportJobStorageKey(id);
  const items = await storage.session.get(key);
  const value = items[key];
  const state = typeof value === "string" ? deserializeJobState(value) : null;
  return state?.id === id ? state : null;
}

/** Legacy payload deletion is permitted only while the caller holds the export lock. */
export async function loadLastJobState(migrateLegacy = true): Promise<ExportJobState | null> {
  const active = await storage.session.get(EXPORT_ACTIVE_KEY);
  const id = active[EXPORT_ACTIVE_KEY];
  if (typeof id === "string") {
    const current = await loadJobState(id);
    if (current) return current;
  }

  const items = await storage.session.get(null);
  const legacy: Array<{ key: string; state: ExportJobState }> = [];
  for (const [key, value] of Object.entries(items)) {
    if (!key.startsWith(LEGACY_PREFIX) || typeof value !== "string") continue;
    const state = deserializeJobState(value);
    if (state?.status === "interrupted") legacy.push({ key, state });
  }
  let latest: ExportJobState | null = null;
  for (const item of legacy) {
    if (!latest || stateTime(item.state) > stateTime(latest)) latest = item.state;
  }
  if (!latest || !migrateLegacy) return latest;

  const sanitized: Record<string, unknown> = { [EXPORT_ACTIVE_KEY]: latest.id };
  for (const item of legacy)
    sanitized[exportJobStorageKey(item.state.id)] = serializeJobState(item.state);
  await storage.session.set(sanitized);
  await storage.session.remove(legacy.map((item) => item.key));
  return latest;
}

function parseState(input: unknown): ExportJobState | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (value.version !== 2) return null;
  const owner = parseOwner(value.owner);
  const request = parseRequest(value.request);
  const counts = parseCounts(value.counts);
  if (
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.sourceKey !== "string" ||
    !value.sourceKey ||
    !owner ||
    !request ||
    !counts ||
    !isStatus(value.status) ||
    !isPhase(value.phase) ||
    typeof value.message !== "string" ||
    typeof value.cancelRequested !== "boolean"
  )
    return null;
  if (value.phase === null && owner.surface !== "unknown") return null;
  if (
    !optionalString(value.error) ||
    !optionalString(value.startedAt) ||
    !optionalString(value.completedAt) ||
    !optionalString(value.terminalReason)
  )
    return null;
  let result: ExportJobState["result"];
  if (value.result !== undefined) {
    if (!value.result || typeof value.result !== "object" || Array.isArray(value.result))
      return null;
    const output = value.result as Record<string, unknown>;
    if (
      typeof output.fileName !== "string" ||
      (output.downloadId !== undefined && !isCount(output.downloadId)) ||
      (output.directoryName !== undefined && typeof output.directoryName !== "string")
    )
      return null;
    result = {
      fileName: output.fileName,
      ...(output.downloadId === undefined ? {} : { downloadId: output.downloadId }),
      ...(output.directoryName === undefined ? {} : { directoryName: output.directoryName }),
    };
  }
  return {
    version: 2,
    id: value.id,
    sourceKey: value.sourceKey,
    owner,
    request,
    status: value.status,
    phase: value.phase,
    message: value.message,
    counts,
    cancelRequested: value.cancelRequested,
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(result ? { result } : {}),
    ...(typeof value.startedAt === "string" ? { startedAt: value.startedAt } : {}),
    ...(typeof value.completedAt === "string" ? { completedAt: value.completedAt } : {}),
    ...(typeof value.terminalReason === "string" ? { terminalReason: value.terminalReason } : {}),
  };
}

function parseOwner(input: unknown): ExportJobOwner | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (
    typeof value.instanceId !== "string" ||
    (value.surface !== "panel" &&
      value.surface !== "popup" &&
      value.surface !== "workspace" &&
      value.surface !== "unknown") ||
    (value.tabId !== undefined && !isCount(value.tabId)) ||
    (value.windowId !== undefined && !isCount(value.windowId))
  )
    return null;
  return {
    instanceId: value.instanceId,
    surface: value.surface,
    ...(value.tabId === undefined ? {} : { tabId: value.tabId }),
    ...(value.windowId === undefined ? {} : { windowId: value.windowId }),
  };
}

function parseRequest(input: unknown): ExportRequestSummary | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (
    !isKind(value.kind) ||
    (value.destination !== "download-zip" &&
      value.destination !== "directory" &&
      value.destination !== "streamed-zip") ||
    (value.presetId !== undefined && !isPresetId(value.presetId)) ||
    !optionalString(value.pageId) ||
    !optionalString(value.rootPageId) ||
    !optionalString(value.spaceKey) ||
    !optionalString(value.issueKey) ||
    (value.selectionCount !== undefined && !isCount(value.selectionCount)) ||
    (value.maxDepth !== undefined && value.maxDepth !== null && !isCount(value.maxDepth))
  )
    return null;
  return {
    kind: value.kind,
    destination: value.destination,
    ...(isPresetId(value.presetId) ? { presetId: value.presetId } : {}),
    ...(typeof value.pageId === "string" ? { pageId: value.pageId } : {}),
    ...(typeof value.rootPageId === "string" ? { rootPageId: value.rootPageId } : {}),
    ...(typeof value.spaceKey === "string" ? { spaceKey: value.spaceKey } : {}),
    ...(typeof value.issueKey === "string" ? { issueKey: value.issueKey } : {}),
    ...(isCount(value.selectionCount) ? { selectionCount: value.selectionCount } : {}),
    ...(value.maxDepth === null || isCount(value.maxDepth) ? { maxDepth: value.maxDepth } : {}),
  };
}

function parseCounts(input: unknown): ExportJobCounts | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const counts = {} as ExportJobCounts;
  for (const key of COUNT_KEYS) {
    const count = value[key];
    if (count !== null && !isCount(count)) return null;
    counts[key] = count;
  }
  return counts;
}

function migrateLegacyState(value: Record<string, unknown>): ExportJobState | null {
  if (
    typeof value.id !== "string" ||
    !value.config ||
    typeof value.config !== "object" ||
    Array.isArray(value.config)
  )
    return null;
  const config = value.config as Record<string, unknown>;
  if (!isKind(config.kind)) return null;
  const progress =
    value.progress && typeof value.progress === "object" && !Array.isArray(value.progress)
      ? (value.progress as Record<string, unknown>)
      : {};
  const request: ExportRequestSummary = { kind: config.kind, destination: "download-zip" };
  if (
    typeof config.presetId === "string" &&
    [
      "md-attachments",
      "md-only",
      "tables-only",
      "generic",
      "all-csv",
      "full-page",
      "api-doc",
    ].includes(config.presetId)
  ) {
    request.presetId = normalizePresetId(config.presetId);
  }
  if (typeof config.pageId === "string") request.pageId = config.pageId;
  if (typeof config.rootPageId === "string") request.rootPageId = config.rootPageId;
  if (typeof config.spaceKey === "string") request.spaceKey = config.spaceKey;
  if (typeof config.issueKey === "string") request.issueKey = config.issueKey;
  if (config.maxDepth === null || isCount(config.maxDepth)) request.maxDepth = config.maxDepth;
  return {
    version: 2,
    id: value.id,
    sourceKey: "legacy",
    owner: { instanceId: "legacy", surface: "unknown" },
    request,
    status: "interrupted",
    phase: null,
    message: "Previous export was interrupted",
    counts: {
      processed: isCount(progress.current) ? progress.current : null,
      total: isCount(progress.total) ? progress.total : null,
      successfulPages: null,
      failedPages: null,
      successfulResources: null,
      failedResources: null,
      entriesWritten: null,
      bytesWritten: null,
    },
    cancelRequested: false,
    ...(typeof value.startedAt === "string" ? { startedAt: value.startedAt } : {}),
    ...(typeof value.completedAt === "string" ? { completedAt: value.completedAt } : {}),
    terminalReason: "legacy-owner-unavailable",
  };
}

function stateTime(state: ExportJobState): number {
  const time = Date.parse(state.completedAt ?? state.startedAt ?? "");
  return Number.isNaN(time) ? 0 : time;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isPresetId(value: unknown): value is ExportPresetId {
  return value === "md-attachments" || value === "md-only" || value === "tables-only";
}

function isStatus(value: unknown): value is ExportJobStatus {
  return (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "partial" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "interrupted"
  );
}

function isPhase(value: unknown): value is ExportJobPhase | null {
  return (
    value === null ||
    value === "discovering" ||
    value === "reading" ||
    value === "writing" ||
    value === "finalizing" ||
    value === "downloading"
  );
}

function isKind(value: unknown): value is ExportRequestSummary["kind"] {
  return (
    value === "extract-page" ||
    value === "extract-subtree" ||
    value === "extract-space" ||
    value === "extract-block" ||
    value === "extract-watch-changed" ||
    value === "extract-jira-issue" ||
    value === "extract-jira-search"
  );
}
