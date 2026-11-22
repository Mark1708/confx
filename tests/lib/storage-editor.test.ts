import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserApi } from "@/lib/browser/browser-api";
import { EditorBridgeError } from "@/lib/browser/editor-bridge";
import { ConfluenceApi } from "@/lib/confluence-api";
import { updateEditorFromStorage } from "@/lib/storage-editor";
import { createStorageMarkdown, readStorageMarkdown } from "@/lib/storage-roundtrip";
import { EditorWorld, hostileSpoofSpec, trustedEditorSpec } from "../helpers/editor-worlds";

const target = { host: "https://wiki.example.test/wiki", pageId: "123", tabId: 7 };
const macro =
  '<ac:structured-macro ac:name="toc" ac:macro-id="keep-me"><ac:parameter ac:name="maxLevel">3</ac:parameter></ac:structured-macro>';
const original = `<p>Original <strong>text</strong></p>${macro}`;
const changed = `<p>Updated <strong>text</strong></p>${macro}`;
const placeholder =
  '<p><img data-macro-name="toc" data-macro-id="keep-me" src="/placeholder/toc"></p>';
const editorOriginal = `<p>Original <strong>text</strong></p>${placeholder}`;
const editorChanged = `<p>Updated <strong>text</strong></p>${placeholder}`;

async function sourcePackage() {
  return (
    await readStorageMarkdown(
      await createStorageMarkdown(
        {
          representation: "storage",
          html: original,
          title: "Example",
          pageId: "123",
          version: 8,
        },
        target,
      ),
    )
  ).package;
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}

describe("published Storage edits applied to the open editor", () => {
  let body: HTMLElement;
  let publishedVersion: number;
  let publishedStorage: string;
  let desiredConversion: string;
  let liveConversion: string;
  let beforeConversion: (() => void | Promise<void>) | undefined;
  let pageReads: number;
  let secondVersion: number | undefined;
  const requests: Array<{ method: string; path: string }> = [];
  const api = new ConfluenceApi(
    { origin: "https://wiki.example.test", basePath: "/wiki" },
    { maxRetries: 0 },
  );

  beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto);
    requests.length = 0;
    publishedVersion = 8;
    publishedStorage = original;
    desiredConversion = changed;
    liveConversion = original;
    beforeConversion = undefined;
    pageReads = 0;
    secondVersion = undefined;
    vi.stubGlobal("location", new URL(`${target.host}/pages/editpage.action?pageId=123`));
    document.head.innerHTML =
      '<meta name="ajs-page-id" content="123"><meta name="ajs-page-title" content="Example"><meta name="ajs-context-path" content="/wiki">';
    document.body.innerHTML = '<iframe id="wysiwygTextarea_ifr"></iframe>';
    body = (document.getElementById("wysiwygTextarea_ifr") as HTMLIFrameElement).contentDocument!
      .body;
    body.innerHTML = editorOriginal;
    const editor = {
      initialized: true,
      getBody: () => body,
      getContent: () => body.innerHTML,
      setContent: (html: string) => {
        body.innerHTML = html;
      },
      undoManager: { transact: (action: () => void) => action() },
      nodeChanged() {},
      setDirty() {},
      fire() {},
    };
    vi.stubGlobal("tinymce", { get: () => editor, editors: [editor] });
    vi.spyOn(BrowserApi, "executeScript").mockImplementation(async (details) => {
      const command = details.func as (...args: unknown[]) => unknown;
      return [
        {
          frameId: 0,
          documentId: "storage-test-document",
          result: command(...details.args!),
        },
      ];
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        requests.push({ method, path: url.pathname });
        if (method === "GET" && url.pathname === "/wiki/rest/api/content/123") {
          pageReads += 1;
          return json({
            id: "123",
            type: "page",
            status: "current",
            title: "Example",
            version: {
              number: pageReads > 1 ? (secondVersion ?? publishedVersion) : publishedVersion,
            },
            body: { storage: { representation: "storage", value: publishedStorage } },
          });
        }
        if (method === "POST" && url.pathname.startsWith("/wiki/rest/api/contentbody/convert/")) {
          const payload = JSON.parse(String(init?.body));
          expect(payload.content).toEqual({ id: "123" });
          if (
            url.pathname.endsWith("/editor") &&
            payload.representation === "storage" &&
            payload.value === changed
          ) {
            await beforeConversion?.();
            return json({ representation: "editor", value: editorChanged });
          }
          if (url.pathname.endsWith("/storage") && payload.representation === "editor") {
            if (payload.value === editorOriginal)
              return json({ representation: "storage", value: liveConversion });
            if (payload.value === editorChanged)
              return json({ representation: "storage", value: desiredConversion });
          }
        }
        throw new Error(`Unexpected request: ${method} ${url.pathname}`);
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  it("updates the actual editor without publishing and retains its opaque macro", async () => {
    expect(await updateEditorFromStorage(target, await sourcePackage(), changed, api)).toEqual({
      status: "updated",
    });
    expect(body.innerHTML).toBe(editorChanged);
    expect(body.querySelector('[data-macro-id="keep-me"]')).not.toBeNull();
    expect(
      requests.every(
        ({ method, path }) =>
          method === "GET" || (method === "POST" && path.includes("/contentbody/convert/")),
      ),
    ).toBe(true);
  });

  it("does not contact the page or server for unchanged Storage", async () => {
    expect(await updateEditorFromStorage(target, await sourcePackage(), original, api)).toEqual({
      status: "unchanged",
    });
    expect(requests).toEqual([]);
    expect(BrowserApi.executeScript).not.toHaveBeenCalled();
    expect(body.innerHTML).toBe(editorOriginal);
  });

  it("rejects a newer published page before changing its open editor", async () => {
    publishedVersion = 9;
    await expect(
      updateEditorFromStorage(target, await sourcePackage(), changed, api),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(body.innerHTML).toBe(editorOriginal);
  });

  it("rejects raw source changes at the same version even when XML structure is equivalent", async () => {
    publishedStorage = original.replace(
      'ac:name="toc" ac:macro-id="keep-me"',
      'ac:macro-id="keep-me" ac:name="toc"',
    );
    await expect(
      updateEditorFromStorage(target, await sourcePackage(), changed, api),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(body.innerHTML).toBe(editorOriginal);
    expect(requests).toEqual([{ method: "GET", path: "/wiki/rest/api/content/123" }]);
  });

  it("does not overwrite unpublished changes in a shared draft", async () => {
    liveConversion = original.replace("Original", "Someone else's draft");
    await expect(
      updateEditorFromStorage(target, await sourcePackage(), changed, api),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(body.innerHTML).toBe(editorOriginal);
  });

  it("blocks a converter that silently discards protected macro parameters", async () => {
    desiredConversion = changed.replace('<ac:parameter ac:name="maxLevel">3</ac:parameter>', "");
    await expect(
      updateEditorFromStorage(target, await sourcePackage(), changed, api),
    ).rejects.toThrow(/conversion|preserv|loss/i);
    expect(body.innerHTML).toBe(editorOriginal);
  });

  it("rechecks published version after asynchronous conversions", async () => {
    secondVersion = 9;
    await expect(
      updateEditorFromStorage(target, await sourcePackage(), changed, api),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(body.innerHTML).toBe(editorOriginal);
  });

  it("refuses to overwrite an editor changed during conversion", async () => {
    beforeConversion = () => {
      body.innerHTML = "<p>A concurrent edit</p>";
    };
    await expect(
      updateEditorFromStorage(target, await sourcePackage(), changed, api),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(body.innerHTML).toBe("<p>A concurrent edit</p>");
  });

  it("rejects an API configured for another site without contacting it", async () => {
    const other = new ConfluenceApi("https://other.example.test", { maxRetries: 0 });
    await expect(
      updateEditorFromStorage(target, await sourcePackage(), changed, other),
    ).rejects.toMatchObject({ code: "wrong-page" });
    expect(requests).toEqual([]);
    expect(body.innerHTML).toBe(editorOriginal);
  });

  it("does not apply converted HTML to a hostile replacement spoofing the trusted editor", async () => {
    const world = new EditorWorld(
      target.tabId,
      trustedEditorSpec(target.host, target.pageId, editorOriginal),
    );
    vi.mocked(BrowserApi.executeScript).mockImplementation(world.executeScript);
    beforeConversion = () => {
      world.navigate(hostileSpoofSpec(target.host, target.pageId, editorOriginal));
    };

    await expect(
      updateEditorFromStorage(target, await sourcePackage(), changed, api),
    ).rejects.toBeInstanceOf(EditorBridgeError);
    expect(world.activeDocument().editor.setContent).not.toHaveBeenCalled();
    expect(world.activeDocument().body.innerHTML).toBe(editorOriginal);
    expect(world.editorReceived(editorChanged)).toBe(false);
  });

  it("aborts before applying when the editor surface is disposed during conversion", async () => {
    const world = new EditorWorld(
      target.tabId,
      trustedEditorSpec(target.host, target.pageId, editorOriginal),
    );
    vi.mocked(BrowserApi.executeScript).mockImplementation(world.executeScript);
    const gate = Promise.withResolvers<void>();
    const reachedConversion = Promise.withResolvers<void>();
    beforeConversion = () => {
      reachedConversion.resolve();
      return gate.promise;
    };
    const controller = new AbortController();
    const pending = updateEditorFromStorage(target, await sourcePackage(), changed, api, {
      signal: controller.signal,
    });

    await reachedConversion.promise;
    controller.abort();
    gate.resolve();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(world.activeDocument().editor.setContent).not.toHaveBeenCalled();
    expect(world.activeDocument().body.innerHTML).toBe(editorOriginal);
    expect(world.editorReceived(editorChanged)).toBe(false);
  });
});
