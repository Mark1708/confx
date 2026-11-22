import { BrowserApi } from "./browser-api";
import type { EditorMarkdownTarget } from "../editor-markdown";
import type { EditorSnapshot } from "../offline-roundtrip/contracts";

export interface EditorTabTarget extends EditorMarkdownTarget {
  tabId: number;
}

/** Runtime-only browser document identity; never serialized into an export. */
export interface EditorDocumentTarget extends EditorTabTarget {
  documentId: string;
}

export interface EditorCapture {
  snapshot: EditorSnapshot;
  target: EditorDocumentTarget;
}

export interface EditorBridgeOptions {
  signal?: AbortSignal;
}

export type EditorBridgeErrorCode =
  | "editor-not-open"
  | "wrong-page"
  | "conflict"
  | "editor-unavailable"
  | "update-failed";

export class EditorBridgeError extends Error {
  constructor(
    public readonly code: EditorBridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EditorBridgeError";
  }
}

export type EditorBridgeRequest =
  | { operation: "capture"; target: EditorMarkdownTarget }
  | { operation: "update"; target: EditorMarkdownTarget; expectedHtml: string; html: string };

export type EditorBridgeResult =
  | { ok: true; snapshot: EditorSnapshot }
  | { ok: true; status: "unchanged" | "updated" }
  | { ok: false; code: EditorBridgeErrorCode; message: string };

export type EditorProbeResult =
  | { ok: true; pageId: string }
  | { ok: false; code: "wrong-page"; message: string };

interface TinyEditor {
  initialized?: boolean;
  getBody?: () => HTMLElement;
  getContent?: (options: { format: "html" }) => string;
  setContent?: (html: string, options: { format: "html" }) => unknown;
  undoManager?: { transact?: (callback: () => void) => void };
  nodeChanged?: () => void;
  setDirty?: (dirty: boolean) => void;
  dispatch?: (event: string) => unknown;
  fire?: (event: string) => unknown;
}

interface TinyManager {
  default?: TinyManager;
  get?: (id: string) => TinyEditor | null;
  activeEditor?: TinyEditor;
  editors?: TinyEditor[] | Record<string, TinyEditor>;
}

/**
 * Validate only public page identity in the trusted ISOLATED world. The browser
 * URL is real there and the arguments never contain editor HTML.
 */
export function editorBridgeProbe(target: EditorMarkdownTarget): EditorProbeResult {
  const fail = (): EditorProbeResult => ({
    ok: false,
    code: "wrong-page",
    message: "The tab is no longer on the selected Confluence site.",
  });
  try {
    const host = new URL(target.host);
    const current = new URL(location.href);
    const basePath = host.pathname.replace(/\/+$/, "");
    const contextPath = document.querySelector<HTMLMetaElement>(
      'meta[name="ajs-context-path"]',
    )?.content;
    const inferredPath =
      ["/wiki", "/confluence"].find(
        (path) => current.pathname === path || current.pathname.startsWith(`${path}/`),
      ) ?? "";
    if (
      !["https:", "http:"].includes(host.protocol) ||
      host.username ||
      host.password ||
      host.search ||
      host.hash ||
      current.origin !== host.origin ||
      !(current.pathname === basePath || current.pathname.startsWith(`${basePath}/`)) ||
      (contextPath !== undefined && contextPath.replace(/\/+$/, "") !== basePath) ||
      (contextPath === undefined && inferredPath !== basePath)
    ) {
      return fail();
    }
    const metaPageId = document
      .querySelector<HTMLMetaElement>('meta[name="ajs-page-id"]')
      ?.content.trim();
    const urlPageId = current.searchParams.get("pageId") || "";
    // As in MAIN, a populated authoritative meta wins over a stale query string.
    const pageId = metaPageId || urlPageId;
    if (!/^\d+$/.test(pageId) || pageId !== target.pageId) return fail();
    return { ok: true, pageId };
  } catch {
    return fail();
  }
}

/** Serialized into the page's MAIN world; all runtime dependencies must stay inside this function. */
export function editorBridgeCommand(request: EditorBridgeRequest): EditorBridgeResult {
  const fail = (code: EditorBridgeErrorCode, message: string): EditorBridgeResult => ({
    ok: false,
    code,
    message,
  });
  let failureCode: EditorBridgeErrorCode = "wrong-page";
  try {
    const host = new URL(request.target.host);
    const current = new URL(location.href);
    const basePath = host.pathname.replace(/\/+$/, "");
    const contextPath = document.querySelector<HTMLMetaElement>(
      'meta[name="ajs-context-path"]',
    )?.content;
    const inferredPath =
      ["/wiki", "/confluence"].find(
        (path) => current.pathname === path || current.pathname.startsWith(`${path}/`),
      ) ?? "";
    if (
      !["https:", "http:"].includes(host.protocol) ||
      host.username ||
      host.password ||
      host.search ||
      host.hash ||
      current.origin !== host.origin ||
      !(current.pathname === basePath || current.pathname.startsWith(`${basePath}/`)) ||
      (contextPath !== undefined && contextPath.replace(/\/+$/, "") !== basePath) ||
      (contextPath === undefined && inferredPath !== basePath)
    ) {
      return fail("wrong-page", "The tab is no longer on the selected Confluence site.");
    }
    const metaPageId = document
      .querySelector<HTMLMetaElement>('meta[name="ajs-page-id"]')
      ?.content.trim();
    // A populated meta is authoritative: never override a different/invalid ID with a stale URL.
    const pageId = metaPageId || current.searchParams.get("pageId") || "";
    if (!/^\d+$/.test(pageId) || pageId !== request.target.pageId) {
      return fail("wrong-page", "The tab is no longer editing the selected page.");
    }

    failureCode = "editor-unavailable";
    const iframe = document.getElementById("wysiwygTextarea_ifr") as HTMLIFrameElement | null;
    if (!iframe || iframe.tagName !== "IFRAME" || !iframe.contentDocument?.body) {
      return fail("editor-not-open", "Open the page's Confluence editor first.");
    }
    const body = iframe.contentDocument.body;
    const globals = window as Window & {
      tinymce?: TinyManager;
      tinyMCE?: TinyManager;
      require?: (name: string) => TinyManager;
      requirejs?: (name: string) => TinyManager;
    };
    const managers = new Set<TinyManager | undefined>([globals.tinymce, globals.tinyMCE]);
    // A string-only AMD lookup is synchronous and cannot request a remote module.
    for (const loader of new Set([globals.require, globals.requirejs])) {
      if (typeof loader !== "function") continue;
      try {
        const module = loader("tinymce");
        managers.add(module?.default ?? module);
      } catch {
        // The module may not already be loaded. Do not load it or retry.
      }
    }
    const candidates = new Set<TinyEditor>();
    for (const manager of managers) {
      if (!manager) continue;
      try {
        if (manager.activeEditor) candidates.add(manager.activeEditor);
        for (const editor of Object.values(manager.editors ?? {})) candidates.add(editor);
      } catch {
        // Another registry can still expose the same live editor.
      }
      try {
        const editor = manager.get?.("wysiwygTextarea");
        if (editor) candidates.add(editor);
      } catch {
        // Other candidates still need the exact iframe body identity check.
      }
    }
    const matches: TinyEditor[] = [];
    for (const editor of candidates) {
      try {
        if (editor?.getBody?.() === body) matches.push(editor);
      } catch {
        // Stale editors can retain inaccessible iframe references.
      }
    }
    if (matches.length !== 1) {
      return fail(
        "editor-unavailable",
        "A unique editor for the Confluence iframe is unavailable.",
      );
    }
    const editor = matches[0];
    if (editor.initialized === false || typeof editor.getContent !== "function") {
      return fail("editor-unavailable", "The Confluence editor is not ready.");
    }
    const html = editor.getContent({ format: "html" });
    if (typeof html !== "string") {
      return fail("editor-unavailable", "The editor did not return HTML.");
    }
    if (request.operation === "capture") {
      const title =
        document.querySelector<HTMLMetaElement>('meta[name="ajs-page-title"]')?.content ||
        document.body.getAttribute("data-title") ||
        document.title;
      return {
        ok: true,
        snapshot: {
          representation: "editor",
          html,
          title,
          pageId,
          capturedAt: new Date().toISOString(),
        },
      };
    }
    if (html === request.html) return { ok: true, status: "unchanged" };
    if (html !== request.expectedHtml) {
      return fail(
        "conflict",
        "The editor changed after capture. Export it again before applying edits.",
      );
    }
    const changeEvent = typeof editor.dispatch === "function" ? editor.dispatch : editor.fire;
    if (
      typeof editor.setContent !== "function" ||
      typeof editor.undoManager?.transact !== "function" ||
      typeof editor.nodeChanged !== "function" ||
      typeof editor.setDirty !== "function" ||
      typeof changeEvent !== "function"
    ) {
      return fail("editor-unavailable", "The editor's undo and change APIs are unavailable.");
    }
    failureCode = "update-failed";
    const beforeBody = body.innerHTML;
    editor.undoManager.transact(() => {
      editor.setContent!(request.html, { format: "html" });
    });
    const afterHtml = editor.getContent({ format: "html" });
    if (typeof afterHtml !== "string" || (afterHtml === html && body.innerHTML === beforeBody)) {
      return fail("update-failed", "The editor did not accept the changed content.");
    }
    editor.nodeChanged();
    editor.setDirty(true);
    changeEvent.call(editor, "change");
    return { ok: true, status: "updated" };
  } catch {
    return fail(
      failureCode,
      failureCode === "update-failed"
        ? "The editor update failed. Inspect the current editor before trying again."
        : "The selected page or its editor is unavailable.",
    );
  }
}

function isEditorProbeResult(value: unknown): value is EditorProbeResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!("ok" in value) || typeof value.ok !== "boolean") return false;
  if (value.ok) return "pageId" in value && typeof value.pageId === "string";
  return (
    "code" in value &&
    value.code === "wrong-page" &&
    "message" in value &&
    typeof value.message === "string"
  );
}

function pinnedDocumentId(target: EditorTabTarget | EditorDocumentTarget): string | undefined {
  if (!("documentId" in target)) return undefined;
  if (typeof target.documentId !== "string" || !target.documentId) {
    throw new EditorBridgeError("editor-unavailable", "The selected editor document is unknown.");
  }
  return target.documentId;
}

async function resolveDocumentId(
  target: EditorTabTarget,
  signal: AbortSignal | undefined,
): Promise<string> {
  signal?.throwIfAborted();
  let results: chrome.scripting.InjectionResult[];
  try {
    results = await BrowserApi.executeScript({
      target: { tabId: target.tabId },
      world: "ISOLATED",
      func: editorBridgeProbe,
      args: [{ host: target.host, pageId: target.pageId }],
    });
  } catch {
    throw new EditorBridgeError("editor-unavailable", "The selected editor tab is inaccessible.");
  }
  const top = results.find((entry) => entry.frameId === 0);
  const probe = top?.result;
  if (!top || typeof top.documentId !== "string" || !top.documentId) {
    // documentIds targeting is mandatory; never fall back to tabId or frameIds.
    throw new EditorBridgeError("editor-unavailable", "The selected editor document is unknown.");
  }
  if (!isEditorProbeResult(probe)) {
    throw new EditorBridgeError("editor-unavailable", "The selected page did not respond safely.");
  }
  if (!probe.ok) throw new EditorBridgeError(probe.code, probe.message);
  return top.documentId;
}

async function injectMain(
  target: EditorTabTarget,
  documentId: string,
  request: EditorBridgeRequest,
  signal: AbortSignal | undefined,
): Promise<EditorBridgeResult> {
  signal?.throwIfAborted();
  const publicTarget: EditorMarkdownTarget = { host: target.host, pageId: target.pageId };
  const mainRequest: EditorBridgeRequest =
    request.operation === "capture"
      ? { operation: "capture", target: publicTarget }
      : {
          operation: "update",
          target: publicTarget,
          expectedHtml: request.expectedHtml,
          html: request.html,
        };
  let results: chrome.scripting.InjectionResult[];
  try {
    results = await BrowserApi.executeScript({
      target: { tabId: target.tabId, documentIds: [documentId] },
      world: "MAIN",
      func: editorBridgeCommand,
      args: [mainRequest],
    });
  } catch {
    throw new EditorBridgeError("editor-unavailable", "The selected editor tab is inaccessible.");
  }
  const result = results.find((entry) => entry.frameId === 0)?.result as
    | EditorBridgeResult
    | undefined;
  if (!result || typeof result.ok !== "boolean") {
    throw new EditorBridgeError("editor-unavailable", "The editor did not respond.");
  }
  if (!result.ok) throw new EditorBridgeError(result.code, result.message);
  return result;
}

async function executeEditorCommand(
  target: EditorTabTarget | EditorDocumentTarget,
  request: EditorBridgeRequest,
  signal: AbortSignal | undefined,
): Promise<{ result: EditorBridgeResult; documentId: string }> {
  const existing = pinnedDocumentId(target);
  const documentId = existing ?? (await resolveDocumentId(target, signal));
  // A pin is never re-resolved: navigation after validation must fail on the old document.
  signal?.throwIfAborted();
  const result = await injectMain(target, documentId, request, signal);
  return { result, documentId };
}

export async function captureEditorSnapshot(
  target: EditorTabTarget,
  options: EditorBridgeOptions = {},
): Promise<EditorCapture> {
  const { result, documentId } = await executeEditorCommand(
    target,
    { operation: "capture", target },
    options.signal,
  );
  if (result.ok && "snapshot" in result) {
    return {
      snapshot: result.snapshot,
      target: {
        tabId: target.tabId,
        host: target.host,
        pageId: target.pageId,
        documentId,
      },
    };
  }
  throw new EditorBridgeError("editor-unavailable", "The editor did not return a snapshot.");
}

export async function updateEditorSnapshot(
  target: EditorTabTarget | EditorDocumentTarget,
  input: { expectedHtml: string; html: string },
  options: EditorBridgeOptions = {},
): Promise<{ status: "unchanged" | "updated" }> {
  const { result } = await executeEditorCommand(
    target,
    { operation: "update", target: { host: target.host, pageId: target.pageId }, ...input },
    options.signal,
  );
  if (result.ok && "status" in result) return { status: result.status };
  throw new EditorBridgeError("update-failed", "The editor did not return an update result.");
}
