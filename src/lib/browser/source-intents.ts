import { detectPageContext, type PageContextInput } from "@/lib/page-context";
import { canonicalBaseUrl, resolveSourceBase, type SourceContext } from "@/lib/source-context";
import type { ConfluencePageMeta, OpenConfxRequest, PickerResult } from "@/types";
import { BrowserApi } from "./browser-api";
import { storage } from "./storage";

interface IntentSource {
  tabId: number;
  windowId: number;
  url: string;
  origin: string;
}

export type SourceIntentRecord =
  | { id: string; kind: "open"; source: IntentSource; payload: OpenConfxRequest }
  | { id: string; kind: "picker"; source: IntentSource; payload: PickerResult };

const RECORD_PREFIX = "cx.sourceIntent.v1:";
const POINTER_PREFIX = "cx.sourceIntents.v1:";
const writes = new Map<string, Promise<void>>();
let trustedSession: Promise<void> | undefined;

/** Restore the boundary before any surface hydrates or writes session metadata. Failure stays fatal. */
export function ensureTrustedSession(): Promise<void> {
  trustedSession ??= Promise.resolve().then(() =>
    BrowserApi.setSessionAccessLevel("TRUSTED_CONTEXTS"),
  );
  return trustedSession;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid source intent");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid source intent text");
  return value;
}

function httpUrl(value: unknown): URL {
  const url = new URL(text(value));
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new Error("Source intents require an HTTP(S) document without credentials");
  }
  return url;
}

function sameDocument(left: URL, right: URL): boolean {
  return (
    left.origin === right.origin && left.pathname === right.pathname && left.search === right.search
  );
}

function sourceMetadata(value: unknown): IntentSource {
  const source = object(value);
  const url = httpUrl(source.url);
  if (
    typeof source.tabId !== "number" ||
    !Number.isSafeInteger(source.tabId) ||
    source.tabId <= 0 ||
    typeof source.windowId !== "number" ||
    !Number.isSafeInteger(source.windowId) ||
    source.windowId < 0 ||
    source.origin !== url.origin
  ) {
    throw new Error("Invalid source intent identity");
  }
  return { tabId: source.tabId, windowId: source.windowId, url: url.href, origin: url.origin };
}

function senderSource(sender: chrome.runtime.MessageSender): IntentSource {
  if (
    sender.id !== new URL(BrowserApi.getURL("")).host ||
    sender.frameId !== 0 ||
    !sender.tab ||
    !sameDocument(httpUrl(sender.tab.url), httpUrl(sender.url)) ||
    (sender.origin !== undefined && sender.origin !== httpUrl(sender.tab.url).origin)
  ) {
    throw new Error("Source intent sender is not the authoritative top-level document");
  }
  const url = httpUrl(sender.tab.url);
  return sourceMetadata({
    tabId: sender.tab.id,
    windowId: sender.tab.windowId,
    url: url.href,
    origin: url.origin,
  });
}

function baseForDocument(value: unknown, documentUrl: string): string {
  const url = httpUrl(value);
  if (url.search || url.hash) throw new Error("Invalid source intent base URL");
  return resolveSourceBase(documentUrl, url.href).baseUrl;
}

function contextForPayload(url: string, payload: OpenConfxRequest | PickerResult) {
  const input: PageContextInput = { url };
  if (payload.kind === "open-confx") {
    input.meta = {
      confluencePageId: payload.source === "confluence" ? payload.pageId : undefined,
      jiraIssueKey: payload.source === "jira" ? payload.issueKey : undefined,
    };
  } else {
    input.meta = { confluencePageId: payload.meta.id };
  }
  const context = detectPageContext(input);
  const direct = detectPageContext({ url });
  if (direct.kind !== "unknown" && context.kind !== direct.kind) {
    throw new Error("Source intent product does not match its document");
  }
  const pageId = payload.kind === "picker-result" ? payload.meta.id : payload.pageId;
  if (direct.kind === "confluence" && pageId && pageId !== direct.pageId) {
    throw new Error("Source intent page does not match its document");
  }
  if (
    payload.kind === "open-confx" &&
    (context.kind !== payload.source ||
      (direct.kind === "jira" && payload.issueKey !== direct.issueKey))
  ) {
    throw new Error("Source intent product does not match its document");
  }
  return {
    product: context.kind === "unknown" ? "other" : context.kind,
    baseUrl: canonicalBaseUrl(context.host ?? httpUrl(url).origin),
  };
}

function normalizePayload(value: unknown, source: IntentSource): OpenConfxRequest | PickerResult {
  const payload = object(value);
  if (payload.kind === "open-confx") {
    if (payload.source !== "confluence" && payload.source !== "jira") {
      throw new Error("Invalid source intent product");
    }
    const result: OpenConfxRequest = {
      kind: "open-confx",
      source: payload.source,
      host: baseForDocument(payload.host, source.url),
    };
    if (payload.pageId !== undefined) result.pageId = text(payload.pageId);
    if (payload.issueKey !== undefined) result.issueKey = text(payload.issueKey);
    if (payload.title !== undefined) result.title = text(payload.title);
    const context = contextForPayload(source.url, result);
    if (result.host !== context.baseUrl) {
      throw new Error("Source intent base does not match its product context");
    }
    return result;
  }
  if (payload.kind !== "picker-result") throw new Error("Invalid source intent kind");
  const meta = object(payload.meta);
  if (!sameDocument(httpUrl(meta.url), httpUrl(source.url))) {
    throw new Error("Picked content does not belong to the sender document");
  }
  const pageMeta: ConfluencePageMeta = {
    id: text(meta.id),
    title: text(meta.title),
    spaceKey: text(meta.spaceKey),
    baseUrl: baseForDocument(meta.baseUrl, source.url),
    url: source.url,
  };
  if (meta.version !== undefined) {
    if (
      typeof meta.version !== "number" ||
      !Number.isSafeInteger(meta.version) ||
      meta.version <= 0
    ) {
      throw new Error("Invalid picked page version");
    }
    pageMeta.version = meta.version;
  }
  if (meta.labels !== undefined) {
    if (!Array.isArray(meta.labels)) throw new Error("Invalid picked page labels");
    pageMeta.labels = meta.labels.map(text);
  }
  if (meta.ancestors !== undefined) {
    if (!Array.isArray(meta.ancestors)) throw new Error("Invalid picked page ancestors");
    pageMeta.ancestors = meta.ancestors.map((value) => {
      const ancestor = object(value);
      return { id: text(ancestor.id), title: text(ancestor.title) };
    });
  }
  if (meta.attachmentCount !== undefined) {
    if (
      typeof meta.attachmentCount !== "number" ||
      !Number.isSafeInteger(meta.attachmentCount) ||
      meta.attachmentCount < 0
    ) {
      throw new Error("Invalid picked page attachment count");
    }
    pageMeta.attachmentCount = meta.attachmentCount;
  }
  const result: PickerResult = { kind: "picker-result", html: text(payload.html), meta: pageMeta };
  contextForPayload(source.url, result);
  return result;
}

function intentId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9-]{1,128}$/.test(value);
}

function parseRecord(value: unknown): SourceIntentRecord | null {
  try {
    const record = object(value);
    if (!intentId(record.id)) return null;
    const source = sourceMetadata(record.source);
    const payload = normalizePayload(record.payload, source);
    if (record.kind === "open" && payload.kind === "open-confx") {
      return { id: record.id, kind: "open", source, payload };
    }
    if (record.kind === "picker" && payload.kind === "picker-result") {
      return { id: record.id, kind: "picker", source, payload };
    }
    return null;
  } catch {
    return null;
  }
}

function recordIdentity(record: SourceIntentRecord): string {
  const context = contextForPayload(record.source.url, record.payload);
  return `${record.source.tabId}:${context.product}:${context.baseUrl}`;
}

function sourceIdentity(source: SourceContext): string {
  const url = httpUrl(source.pageUrl);
  baseForDocument(source.baseUrl, url.href);
  const context = detectPageContext({
    url: url.href,
    meta: {
      confluencePageId: source.product === "confluence" ? source.pageId : undefined,
      jiraIssueKey: source.product === "jira" ? source.issueKey : undefined,
    },
  });
  const product = context.kind === "unknown" ? "other" : context.kind;
  if (!Number.isSafeInteger(source.tabId) || source.tabId <= 0 || product !== source.product) {
    throw new Error("Invalid source intent reader");
  }
  return `${source.tabId}:${product}:${canonicalBaseUrl(context.host ?? url.origin)}`;
}

function pointerKey(identity: string, kind: SourceIntentRecord["kind"]): string {
  return `${POINTER_PREFIX}${encodeURIComponent(identity)}:${kind}`;
}

/** Only the service worker writes handoffs, after restricting session access to trusted contexts. */
export async function storeSourceIntent(
  input: OpenConfxRequest | PickerResult,
  sender: chrome.runtime.MessageSender,
): Promise<SourceIntentRecord> {
  const source = senderSource(sender);
  const payload = normalizePayload(input, source);
  const id = crypto.randomUUID();
  const record: SourceIntentRecord =
    payload.kind === "open-confx"
      ? { id, kind: "open", source, payload }
      : { id, kind: "picker", source, payload };
  const pointer = pointerKey(recordIdentity(record), record.kind);
  const previousWrite = writes.get(pointer) ?? Promise.resolve();
  const write = previousWrite.then(async () => {
    await ensureTrustedSession();
    const previous = (await storage.session.get(pointer))[pointer];
    await storage.session.set({ [`${RECORD_PREFIX}${id}`]: record, [pointer]: id });
    if (intentId(previous) && previous !== id) {
      const oldKey = `${RECORD_PREFIX}${previous}`;
      const oldRecord = parseRecord((await storage.session.get(oldKey))[oldKey]);
      if (
        oldRecord &&
        oldRecord.kind === record.kind &&
        recordIdentity(oldRecord) === recordIdentity(record)
      ) {
        await storage.session.remove(oldKey);
      }
    }
    return record;
  });
  const settled = write.then(
    () => {},
    () => {},
  );
  writes.set(pointer, settled);
  void settled.then(() => {
    if (writes.get(pointer) === settled) writes.delete(pointer);
  });
  return write;
}

export async function readSourceIntents(source: SourceContext): Promise<SourceIntentRecord[]> {
  let identity: string;
  try {
    identity = sourceIdentity(source);
  } catch {
    return [];
  }
  const kinds = ["open", "picker"] as const;
  const pointers = kinds.map((kind) => pointerKey(identity, kind));
  const stored = await storage.session.get(pointers);
  const targets = kinds.flatMap((kind, index) => {
    const id = stored[pointers[index]];
    return intentId(id) ? [{ id, kind }] : [];
  });
  if (targets.length === 0) return [];
  const records = await storage.session.get(targets.map(({ id }) => `${RECORD_PREFIX}${id}`));
  return targets.flatMap(({ id, kind }) => {
    const record = parseRecord(records[`${RECORD_PREFIX}${id}`]);
    return record && record.id === id && record.kind === kind && recordIdentity(record) === identity
      ? [record]
      : [];
  });
}

/** A clear never removes a shared pointer: an old capture cannot erase a newer capture. */
export async function clearSourceIntent(input: SourceIntentRecord): Promise<void> {
  const record = parseRecord(input);
  if (!record) return;
  const key = `${RECORD_PREFIX}${record.id}`;
  const stored = parseRecord((await storage.session.get(key))[key]);
  if (
    stored &&
    stored.id === record.id &&
    stored.kind === record.kind &&
    stored.source.tabId === record.source.tabId &&
    stored.source.windowId === record.source.windowId &&
    stored.source.url === record.source.url &&
    stored.source.origin === record.source.origin
  ) {
    await storage.session.remove(key);
  }
}

export function watchSourceIntents(
  source: SourceContext,
  onRecords: (records: SourceIntentRecord[]) => void,
): () => void {
  const identity = sourceIdentity(source);
  const pointers = [pointerKey(identity, "open"), pointerKey(identity, "picker")];
  let disposed = false;
  let generation = 0;
  const unsubscribe = BrowserApi.onStorageChanged((changes, areaName) => {
    if (areaName !== "session") return;
    const relevant =
      pointers.some((key) => key in changes) ||
      Object.entries(changes).some(([key, change]) => {
        if (!key.startsWith(RECORD_PREFIX)) return false;
        const oldRecord = parseRecord(change.oldValue);
        const newRecord = parseRecord(change.newValue);
        return (
          (oldRecord && recordIdentity(oldRecord) === identity) ||
          (newRecord && recordIdentity(newRecord) === identity)
        );
      });
    if (!relevant) return;
    const current = ++generation;
    void readSourceIntents(source)
      .then((records) => {
        if (!disposed && current === generation) onRecords(records);
      })
      .catch(() => {
        console.error("[cx] Cannot read source-scoped handoffs");
      });
  });
  return () => {
    disposed = true;
    generation += 1;
    unsubscribe();
  };
}
