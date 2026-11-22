import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserApi } from "@/lib/browser/browser-api";
import {
  captureEditorSnapshot,
  editorBridgeCommand,
  EditorBridgeError,
  updateEditorSnapshot,
} from "@/lib/browser/editor-bridge";
import {
  EditorWorld,
  type EditorWorldDocumentSpec,
  hostileSpoofSpec,
  trustedEditorSpec,
} from "../../helpers/editor-worlds";

const target = { host: "https://wiki.example.test/wiki", pageId: "123", tabId: 7 };
const initialHtml = "<p>Original</p>";
const desiredHtml = "<p>Changed</p>";

function installEditor() {
  document.head.innerHTML =
    '<meta name="ajs-page-id" content="123"><meta name="ajs-page-title" content="Example"><meta name="ajs-context-path" content="/wiki">';
  document.body.innerHTML = '<iframe id="wysiwygTextarea_ifr"></iframe>';
  const body = (document.getElementById("wysiwygTextarea_ifr") as HTMLIFrameElement)
    .contentDocument!.body;
  body.innerHTML = initialHtml;
  const editor = {
    initialized: true,
    getBody: vi.fn(() => body),
    getContent: vi.fn((_options: { format: string }) => body.innerHTML),
    setContent: vi.fn((html: string, _options: { format: string }) => {
      body.innerHTML = html;
    }),
    undoManager: { transact: vi.fn((callback: () => void) => callback()) },
    nodeChanged: vi.fn(),
    setDirty: vi.fn(),
    fire: vi.fn(),
    save: vi.fn(),
    resetContent: vi.fn(),
  };
  vi.stubGlobal("tinymce", { get: vi.fn(() => editor), activeEditor: editor, editors: [editor] });
  return { editor, body };
}

function capture() {
  return editorBridgeCommand({ operation: "capture", target });
}

function update(expectedHtml = initialHtml, html = desiredHtml) {
  return editorBridgeCommand({ operation: "update", target, expectedHtml, html });
}

interface EditorMutationBoundary {
  undoManager: { transact: unknown };
  setContent: unknown;
  nodeChanged: unknown;
  setDirty: unknown;
  fire: unknown;
  save: unknown;
  resetContent: unknown;
}

function expectNoMutation(editor: EditorMutationBoundary) {
  expect(editor.undoManager.transact).not.toHaveBeenCalled();
  expect(editor.setContent).not.toHaveBeenCalled();
  expect(editor.nodeChanged).not.toHaveBeenCalled();
  expect(editor.setDirty).not.toHaveBeenCalled();
  expect(editor.fire).not.toHaveBeenCalled();
  expect(editor.save).not.toHaveBeenCalled();
  expect(editor.resetContent).not.toHaveBeenCalled();
}

describe("editor bridge command", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "location",
      new URL("https://wiki.example.test/wiki/pages/editpage.action?pageId=123"),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  it("captures serialized HTML without changing the body, dirty state or events", () => {
    const { editor, body } = installEditor();
    expect(capture()).toEqual({
      ok: true,
      snapshot: {
        representation: "editor",
        html: initialHtml,
        title: "Example",
        pageId: "123",
        capturedAt: expect.any(String),
      },
    });
    expect(body.innerHTML).toBe(initialHtml);
    expect(editor.getContent).toHaveBeenCalledExactlyOnceWith({ format: "html" });
    expectNoMutation(editor);
  });

  it("discovers an already-loaded AMD TinyMCE without asynchronous module requests", () => {
    const { editor } = installEditor();
    vi.stubGlobal("tinymce", undefined);
    const loader = vi.fn((name: string) => {
      expect(name).toBe("tinymce");
      return { default: { editors: { main: editor } } };
    });
    vi.stubGlobal("require", loader);
    vi.stubGlobal("requirejs", loader);
    expect(capture()).toMatchObject({ ok: true });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it.each([
    "https://other.example.test/wiki/pages/editpage.action?pageId=123",
    "https://wiki.example.test/confluence/pages/editpage.action?pageId=123",
  ])("rejects a navigated tab at %s before reading or writing", (url) => {
    const { editor } = installEditor();
    vi.stubGlobal("location", new URL(url));
    expect(capture()).toMatchObject({ ok: false, code: "wrong-page" });
    expect(update()).toMatchObject({ ok: false, code: "wrong-page" });
    expect(editor.getContent).not.toHaveBeenCalled();
    expectNoMutation(editor);
  });

  it("uses the real page meta over a stale query and rechecks it on writes", () => {
    const { editor } = installEditor();
    expect(capture()).toMatchObject({ ok: true });
    document.querySelector('meta[name="ajs-page-id"]')!.setAttribute("content", "456");
    expect(update()).toMatchObject({ ok: false, code: "wrong-page" });
    expectNoMutation(editor);
  });

  it("allows only a numeric query fallback when page meta is absent", () => {
    installEditor();
    document.querySelector('meta[name="ajs-page-id"]')!.remove();
    expect(capture()).toMatchObject({ ok: true, snapshot: { pageId: "123" } });
    vi.stubGlobal(
      "location",
      new URL("https://wiki.example.test/wiki/pages/editpage.action?pageId=not-a-page"),
    );
    expect(capture()).toMatchObject({ ok: false, code: "wrong-page" });
  });

  it("never chooses an editor whose body is not the Confluence iframe body", () => {
    const { editor } = installEditor();
    editor.getBody.mockReturnValue(document.createElement("body"));
    expect(capture()).toMatchObject({ ok: false, code: "editor-unavailable" });
    expect(editor.getContent).not.toHaveBeenCalled();
    expectNoMutation(editor);
  });

  it("reports a missing iframe and an unavailable editor separately", () => {
    installEditor();
    vi.stubGlobal("tinymce", undefined);
    expect(capture()).toMatchObject({ ok: false, code: "editor-unavailable" });
    document.body.innerHTML = "";
    expect(capture()).toMatchObject({ ok: false, code: "editor-not-open" });
  });

  it("returns unchanged before conflict checking with no events or transaction", () => {
    const { editor } = installEditor();
    expect(update("stale baseline", initialHtml)).toEqual({ ok: true, status: "unchanged" });
    expect(editor.getContent).toHaveBeenCalledTimes(1);
    expectNoMutation(editor);
  });

  it("rejects a conflicting local baseline without a write", () => {
    const { editor } = installEditor();
    expect(update("stale baseline")).toMatchObject({ ok: false, code: "conflict" });
    expect(editor.getContent).toHaveBeenCalledTimes(1);
    expectNoMutation(editor);
  });

  it("changes the real body in exactly one undo transaction and accepts serialization differences", () => {
    const { editor, body } = installEditor();
    editor.getContent.mockImplementation(() =>
      body.innerHTML === desiredHtml ? '<p class="normalized">Changed</p>' : body.innerHTML,
    );
    expect(update()).toEqual({ ok: true, status: "updated" });
    expect(body.innerHTML).toBe(desiredHtml);
    expect(editor.undoManager.transact).toHaveBeenCalledTimes(1);
    expect(editor.setContent).toHaveBeenCalledExactlyOnceWith(desiredHtml, { format: "html" });
    expect(editor.getContent).toHaveBeenCalledTimes(2);
    expect(editor.nodeChanged).toHaveBeenCalledTimes(1);
    expect(editor.setDirty).toHaveBeenCalledExactlyOnceWith(true);
    expect(editor.fire).toHaveBeenCalledExactlyOnceWith("change");
    expect(editor.save).not.toHaveBeenCalled();
    expect(editor.resetContent).not.toHaveBeenCalled();
  });

  it("reports ignored content and thrown changes as failures without rollback", () => {
    const { editor } = installEditor();
    editor.setContent.mockImplementation(() => {});
    expect(update()).toMatchObject({ ok: false, code: "update-failed" });
    expect(editor.setContent).toHaveBeenCalledTimes(1);
    editor.setContent.mockImplementation(() => {
      throw new Error("private editor details");
    });
    expect(update()).toMatchObject({ ok: false, code: "update-failed" });
    expect(editor.setContent).toHaveBeenCalledTimes(2);
  });

  it("requires supported undo and change APIs before writing", () => {
    const { editor } = installEditor();
    Object.assign(editor.undoManager, { transact: undefined });
    expect(update()).toMatchObject({ ok: false, code: "editor-unavailable" });
    expect(editor.setContent).not.toHaveBeenCalled();
  });

  it("injects the actual self-contained command in MAIN and translates structured failures", async () => {
    const { body } = installEditor();
    const injection = vi.spyOn(BrowserApi, "executeScript").mockImplementation(async (request) => {
      // Recreate from source to reject accidental module-scope dependencies.
      const command = new Function(`return (${request.func!.toString()})`)() as (
        ...args: unknown[]
      ) => unknown;
      if (request.world === "ISOLATED") {
        expect(request.target).toEqual({ tabId: 7 });
        return [{ frameId: 0, documentId: "legacy-document", result: command(request.args![0]) }];
      }
      expect(request.target).toEqual({ tabId: 7, documentIds: ["legacy-document"] });
      return [{ frameId: 0, documentId: "legacy-document", result: command(request.args![0]) }];
    });
    const captured = await captureEditorSnapshot(target);
    expect(captured.snapshot).toMatchObject({ html: initialHtml });
    expect(
      await updateEditorSnapshot(captured.target, {
        expectedHtml: initialHtml,
        html: desiredHtml,
      }),
    ).toEqual({ status: "updated" });
    expect(body.innerHTML).toBe(desiredHtml);
    await expect(
      updateEditorSnapshot(captured.target, {
        expectedHtml: initialHtml,
        html: "<p>Another</p>",
      }),
    ).rejects.toMatchObject({ name: "EditorBridgeError", code: "conflict" });
    expect(injection).toHaveBeenCalledTimes(4);
    expect(new EditorBridgeError("conflict", "Changed")).toBeInstanceOf(Error);
  });

  it("uses dispatch on modern TinyMCE and never also fires the legacy event", () => {
    const { editor } = installEditor();
    const dispatch = vi.fn();
    Object.assign(editor, { dispatch });
    expect(update()).toEqual({ ok: true, status: "updated" });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith("change");
    expect(editor.fire).not.toHaveBeenCalled();
  });

  it("rejects ambiguous matching editor instances without reading content", () => {
    const { editor } = installEditor();
    vi.stubGlobal("tinyMCE", { activeEditor: { ...editor } });
    expect(capture()).toMatchObject({ ok: false, code: "editor-unavailable" });
    expect(editor.getContent).not.toHaveBeenCalled();
  });

  it("rejects invalid authoritative page metadata rather than trusting the query", () => {
    const { editor } = installEditor();
    document.querySelector('meta[name="ajs-page-id"]')!.setAttribute("content", "not-a-page");
    expect(update()).toMatchObject({ ok: false, code: "wrong-page" });
    expectNoMutation(editor);
  });

  it("captures the body title and then document title when page-title meta is absent", () => {
    installEditor();
    document.querySelector('meta[name="ajs-page-title"]')!.remove();
    document.body.setAttribute("data-title", "Body title");
    expect(capture()).toMatchObject({ ok: true, snapshot: { title: "Body title" } });
    document.body.removeAttribute("data-title");
    document.title = "Document title";
    expect(capture()).toMatchObject({ ok: true, snapshot: { title: "Document title" } });
  });
});

describe("editor bridge document pinning across isolated and MAIN worlds", () => {
  const privateHtml = '<p data-secret="editor">PRIVATE-EDIT-9f2c</p>';

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function installWorld(spec: EditorWorldDocumentSpec) {
    const world = new EditorWorld(target.tabId, spec);
    vi.spyOn(BrowserApi, "executeScript").mockImplementation(world.executeScript);
    return world;
  }

  it("captures through a trusted probe, pins the browser documentId, and updates that editor", async () => {
    const world = installWorld(trustedEditorSpec(target.host, target.pageId, initialHtml));
    const captured = await captureEditorSnapshot(target);

    expect(captured.snapshot).toMatchObject({ html: initialHtml, pageId: target.pageId });
    expect(captured.target).toMatchObject({
      tabId: target.tabId,
      host: target.host,
      pageId: target.pageId,
      documentId: world.activeDocument().documentId,
    });
    expect(world.isolatedRequests()).toHaveLength(1);
    expect(JSON.stringify(world.isolatedRequests()[0]!.args)).not.toContain(initialHtml);

    expect(
      await updateEditorSnapshot(captured.target, {
        expectedHtml: initialHtml,
        html: privateHtml,
      }),
    ).toEqual({ status: "updated" });
    expect(world.activeDocument().editor.setContent).toHaveBeenCalledExactlyOnceWith(privateHtml, {
      format: "html",
    });
    expect(world.activeDocument().body.innerHTML).toBe(privateHtml);
    for (const request of world.mainRequests()) {
      expect(request.target).toEqual({
        tabId: target.tabId,
        documentIds: [world.activeDocument().documentId],
      });
    }
  });

  it("never delivers private HTML to a hostile replacement spoofing the trusted MAIN world", async () => {
    const world = installWorld(hostileSpoofSpec(target.host, target.pageId, initialHtml));

    await expect(
      updateEditorSnapshot(target, { expectedHtml: initialHtml, html: privateHtml }),
    ).rejects.toMatchObject({ name: "EditorBridgeError", code: "wrong-page" });
    expect(world.activeDocument().editor.setContent).not.toHaveBeenCalled();
    expect(world.activeDocument().body.innerHTML).toBe(initialHtml);
    expect(world.editorReceived(privateHtml)).toBe(false);
    expect(JSON.stringify(world.isolatedRequests()[0]?.args ?? [])).not.toContain(privateHtml);
  });

  it("fails closed when the validated document navigates before the MAIN injection", async () => {
    const world = installWorld(trustedEditorSpec(target.host, target.pageId, initialHtml));
    world.afterProbe = () => {
      world.navigate(hostileSpoofSpec(target.host, target.pageId, initialHtml));
    };

    await expect(
      updateEditorSnapshot(target, { expectedHtml: initialHtml, html: privateHtml }),
    ).rejects.toBeInstanceOf(EditorBridgeError);
    expect(world.mainRequests()).toHaveLength(0);
    expect(world.activeDocument().editor.setContent).not.toHaveBeenCalled();
    expect(world.activeDocument().body.innerHTML).toBe(initialHtml);
    expect(world.editorReceived(privateHtml)).toBe(false);
  });

  it("does not apply to a same-site replacement document after the initial capture", async () => {
    const world = installWorld(trustedEditorSpec(target.host, target.pageId, initialHtml));
    const captured = await captureEditorSnapshot(target);
    const replacement = world.navigate(trustedEditorSpec(target.host, target.pageId, initialHtml));

    await expect(
      updateEditorSnapshot(captured.target, {
        expectedHtml: initialHtml,
        html: privateHtml,
      }),
    ).rejects.toBeInstanceOf(EditorBridgeError);
    expect(replacement.editor.setContent).not.toHaveBeenCalled();
    expect(replacement.body.innerHTML).toBe(initialHtml);
  });

  it("fails closed without a frameId fallback when InjectionResult omits documentId", async () => {
    const world = installWorld(trustedEditorSpec(target.host, target.pageId, initialHtml));
    world.omitDocumentId = true;

    await expect(
      updateEditorSnapshot(target, { expectedHtml: initialHtml, html: privateHtml }),
    ).rejects.toMatchObject({ name: "EditorBridgeError", code: "editor-unavailable" });
    expect(world.mainRequests()).toHaveLength(0);
    expect(world.activeDocument().editor.setContent).not.toHaveBeenCalled();
    expect(world.activeDocument().body.innerHTML).toBe(initialHtml);
  });

  it("rejects an aborted update after the probe resolves and before any MAIN payload transfer", async () => {
    const world = installWorld(trustedEditorSpec(target.host, target.pageId, initialHtml));
    const gate = Promise.withResolvers<unknown>();
    world.isolatedGate = gate.promise;
    const controller = new AbortController();
    const pending = updateEditorSnapshot(
      target,
      { expectedHtml: initialHtml, html: privateHtml },
      { signal: controller.signal },
    );

    controller.abort();
    gate.resolve(undefined);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(world.mainRequests()).toHaveLength(0);
    expect(world.activeDocument().editor.setContent).not.toHaveBeenCalled();
    expect(world.activeDocument().body.innerHTML).toBe(initialHtml);
  });
});
