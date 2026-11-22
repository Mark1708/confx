import { vi, type Mock } from "vitest";
import { BrowserApi } from "@/lib/browser/browser-api";

/**
 * A deterministic simulation of one browser tab whose documents expose two
 * execution worlds. The ISOLATED world always sees the browser-owned URL, while
 * the MAIN world can be spoofed by page script (location, DOM metadata and
 * TinyMCE). Injection results carry the browser-owned documentId, and any
 * injection pinned to a document that is no longer the tab's active document is
 * rejected exactly like chrome.scripting does.
 */
export interface EditorWorldMeta {
  pageId?: string;
  title?: string;
  contextPath?: string;
}

export interface EditorWorldDocumentSpec {
  /** The real URL reported to the trusted ISOLATED world. */
  realUrl: string;
  /** The URL the MAIN world claims; defaults to the real URL. */
  mainUrl?: string;
  editorHtml?: string;
  meta?: EditorWorldMeta;
}

export interface EditorWorldEditor {
  initialized: boolean;
  getBody: Mock<() => HTMLElement>;
  getContent: Mock<(options: { format: string }) => string>;
  setContent: Mock<(html: string, options: { format: string }) => void>;
  undoManager: { transact: Mock<(callback: () => void) => void> };
  nodeChanged: Mock<() => void>;
  setDirty: Mock<(dirty: boolean) => void>;
  fire: Mock<(event: string) => unknown>;
}

export interface EditorWorldDocument {
  documentId: string;
  realUrl: string;
  mainUrl: string;
  body: HTMLElement;
  editor: EditorWorldEditor;
}

export interface EditorWorldRequest {
  world: "ISOLATED" | "MAIN";
  target: { tabId: number; documentIds?: string[]; frameIds?: number[] };
  args: unknown[];
  documentId: string;
}

type InjectionDetails = Parameters<typeof BrowserApi.executeScript>[0];

/** Injection result whose browser-owned documentId can be omitted deliberately. */
type SimulatedInjectionResult = Omit<chrome.scripting.InjectionResult, "documentId"> & {
  documentId?: string;
};

let nextDocumentNumber = 0;

function installDom(spec: EditorWorldDocumentSpec): { dom: Document; body: HTMLElement } {
  const dom = document.implementation.createHTMLDocument(spec.meta?.title ?? "Simulated");
  const appendMeta = (name: string, content: string): void => {
    const meta = dom.createElement("meta");
    meta.setAttribute("name", name);
    meta.setAttribute("content", content);
    dom.head.append(meta);
  };
  if (spec.meta?.pageId !== undefined) appendMeta("ajs-page-id", spec.meta.pageId);
  if (spec.meta?.title !== undefined) appendMeta("ajs-page-title", spec.meta.title);
  if (spec.meta?.contextPath !== undefined) appendMeta("ajs-context-path", spec.meta.contextPath);

  const iframe = dom.createElement("iframe");
  iframe.id = "wysiwygTextarea_ifr";
  dom.body.append(iframe);
  let contentDocument = iframe.contentDocument;
  if (!contentDocument) {
    contentDocument = document.implementation.createHTMLDocument("Editor frame");
    Object.defineProperty(iframe, "contentDocument", {
      value: contentDocument,
      configurable: true,
    });
  }
  const body = contentDocument.body;
  body.innerHTML = spec.editorHtml ?? "";
  return { dom, body };
}

function installEditor(body: HTMLElement): EditorWorldEditor {
  const editor: EditorWorldEditor = {
    initialized: true,
    getBody: vi.fn(() => body),
    getContent: vi.fn(() => body.innerHTML),
    setContent: vi.fn((html: string) => {
      body.innerHTML = html;
    }),
    undoManager: { transact: vi.fn((callback: () => void) => callback()) },
    nodeChanged: vi.fn(),
    setDirty: vi.fn(),
    fire: vi.fn(),
  };
  return editor;
}

function runInWorld<T>(
  func: (...args: never[]) => T,
  args: unknown[],
  context: { window: unknown; document: Document; location: { href: string } },
): T {
  // Recreate from source so accidental module-scope dependencies fail loudly.
  const factory = new Function(
    "window",
    "document",
    "location",
    `"use strict"; return (${func.toString()});`,
  ) as (
    window: unknown,
    document: Document,
    location: { href: string },
  ) => (...args: unknown[]) => T;
  const command = factory(context.window, context.document, context.location);
  return command(...args);
}

export class EditorWorld {
  readonly requests: EditorWorldRequest[] = [];

  /** Awaited before every ISOLATED execution; used to model pending probes. */
  isolatedGate: Promise<unknown> | undefined;

  /** Runs after a successful ISOLATED execution, before its result is returned. */
  afterProbe: (() => void) | undefined;

  /** Omits documentId from injection results to model unsupported browsers. */
  omitDocumentId = false;

  private current: EditorWorldDocument & { dom: Document };

  constructor(
    private readonly tabId: number,
    spec: EditorWorldDocumentSpec,
  ) {
    this.current = this.createDocument(spec);
  }

  activeDocument(): EditorWorldDocument & { dom: Document } {
    return this.current;
  }

  navigate(spec: EditorWorldDocumentSpec): EditorWorldDocument {
    this.current = this.createDocument(spec);
    return this.current;
  }

  mainRequests(): EditorWorldRequest[] {
    return this.requests.filter((request) => request.world === "MAIN");
  }

  isolatedRequests(): EditorWorldRequest[] {
    return this.requests.filter((request) => request.world === "ISOLATED");
  }

  /** True only if the active document's MAIN-world editor consumed the private HTML. */
  editorReceived(html: string): boolean {
    return this.current.editor.setContent.mock.calls.some(
      (call) => call[0] === html || String(call[0]).includes(html),
    );
  }

  executeScript = async (
    details: InjectionDetails,
  ): Promise<chrome.scripting.InjectionResult<unknown>[]> => {
    if (details.target.tabId !== this.tabId) throw new Error("No tab with given id");
    if (details.target.frameIds) throw new Error("frameIds targeting is not supported");
    if (details.target.documentIds && details.target.documentIds.length > 1) {
      throw new Error("Multiple document targets are not supported");
    }
    const pinned = details.target.documentIds?.[0];
    if (pinned && pinned !== this.current.documentId) {
      // The pinned document navigated away; Chrome rejects before any script runs.
      throw new Error("No target with given id found");
    }
    const active = this.current;
    const world = details.world ?? "ISOLATED";
    if (world === "ISOLATED") {
      if (this.isolatedGate) await this.isolatedGate;
    }
    const result = runInWorld(details.func as (...args: never[]) => unknown, details.args ?? [], {
      window:
        world === "MAIN"
          ? {
              tinymce: {
                get: () => active.editor,
                activeEditor: active.editor,
                editors: [active.editor],
              },
            }
          : {},
      document: active.dom,
      location: { href: world === "MAIN" ? active.mainUrl : active.realUrl },
    });
    if (world === "ISOLATED") this.afterProbe?.();
    const injection: SimulatedInjectionResult = {
      documentId: active.documentId,
      frameId: 0,
      result,
    };
    this.requests.push({
      world,
      target: {
        tabId: details.target.tabId,
        documentIds: details.target.documentIds ? [...details.target.documentIds] : undefined,
      },
      args: details.args ? [...details.args] : [],
      documentId: active.documentId,
    });
    if (this.omitDocumentId) delete injection.documentId;
    // The simulation's optional documentId is exactly Chrome's required field.
    const results = [injection] as chrome.scripting.InjectionResult<unknown>[];
    return results;
  };

  private createDocument(spec: EditorWorldDocumentSpec): EditorWorldDocument & { dom: Document } {
    nextDocumentNumber += 1;
    const { dom, body } = installDom(spec);
    return {
      documentId: `simulated-document-${nextDocumentNumber}`,
      realUrl: spec.realUrl,
      mainUrl: spec.mainUrl ?? spec.realUrl,
      body,
      editor: installEditor(body),
      dom,
    };
  }
}

export function trustedEditorSpec(
  host: string,
  pageId: string,
  html: string,
): EditorWorldDocumentSpec {
  const base = new URL(host);
  return {
    realUrl: `${host}/pages/editpage.action?pageId=${pageId}`,
    editorHtml: html,
    meta: { pageId, title: "Simulated page", contextPath: base.pathname.replace(/\/+$/, "") },
  };
}

export function hostileSpoofSpec(
  host: string,
  pageId: string,
  html: string,
): EditorWorldDocumentSpec {
  const trusted = trustedEditorSpec(host, pageId, html);
  return {
    ...trusted,
    realUrl: "https://attacker.example.test/steal-editor-secret",
    // Page script in MAIN can lie about its URL; ISOLATED still sees realUrl.
    mainUrl: trusted.realUrl,
  };
}
