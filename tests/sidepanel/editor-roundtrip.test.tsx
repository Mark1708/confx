import { webcrypto } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { BrowserApi } from "@/lib/browser/browser-api";
import { createEditorMarkdown } from "@/lib/editor-markdown";
import { createStorageMarkdown } from "@/lib/storage-roundtrip";
import { EditorWorld, trustedEditorSpec } from "../helpers/editor-worlds";
import { EditorRoundtripPanel } from "@/sidepanel/components/EditorRoundtripPanel";
import type { CurrentTabInfo } from "@/sidepanel/hooks/useCurrentTab";

vi.mock("@/sidepanel/hooks/useI18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const tab: CurrentTabInfo = {
  tabId: 7,
  host: "https://wiki.example.test/wiki",
  pageId: "100",
  accessState: "available",
  grantStatus: "idle",
  retry: async () => {},
  grantAccess: async () => {},
};

async function source(host = tab.host!) {
  return createEditorMarkdown(
    { representation: "editor", html: "<p>Original text</p>", title: "Source", pageId: "100" },
    { host, pageId: "100" },
  );
}

function localFile(text: string | Promise<string>, name = "page.md"): File {
  const file = new File([], name, { type: "text/markdown" });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new TextEncoder().encode(await text).buffer,
  });
  return file;
}

function ConditionalRoundtripPanel({ show }: { show: boolean }) {
  return show ? <EditorRoundtripPanel tab={tab} /> : null;
}

describe("direct editor Markdown workflow", () => {
  let container: HTMLDivElement;
  let root: Root;
  let injection: MockInstance;
  beforeEach(async () => {
    vi.stubGlobal("crypto", webcrypto);
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    injection = vi.spyOn(BrowserApi, "executeScript");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<EditorRoundtripPanel tab={tab} />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const applyButton = () =>
    [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "editorRoundtrip.apply",
    )!;

  async function choose(file: File, wait = true) {
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    if (wait) {
      await vi.waitFor(async () => {
        await act(async () => {
          await pause(0);
        });
        if (
          applyButton().disabled &&
          !container.querySelector('[role="status"], [role="alert"], details')
        ) {
          throw new Error("The local file is still being processed");
        }
      });
    }
  }

  it.each(["host-access-missing", "injection-failed", undefined] as const)(
    "allows local file selection while tab access is %s, without writing to the editor",
    async (accessState) => {
      await act(async () => root.render(<EditorRoundtripPanel tab={{ ...tab, accessState }} />));
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      expect(input.disabled).toBe(false);
      await choose(localFile((await source()).replace("Original text", "Updated text")));
      expect(applyButton().disabled).toBe(true);
      expect(injection).not.toHaveBeenCalled();
    },
  );

  it("retains a locally loaded edit when page detection subsequently becomes available", async () => {
    await act(async () =>
      root.render(
        <EditorRoundtripPanel
          tab={{ ...tab, tabId: undefined, pageId: null, accessState: undefined }}
        />,
      ),
    );
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.disabled).toBe(false);
    await choose(localFile((await source()).replace("Original text", "Updated text")));
    expect(applyButton().disabled).toBe(true);
    await act(async () => root.render(<EditorRoundtripPanel tab={tab} />));
    expect(applyButton().disabled).toBe(false);
    expect(injection).not.toHaveBeenCalled();
  });

  it("disables application if the active page changes after a local file was loaded", async () => {
    await choose(localFile((await source()).replace("Original text", "Updated text")));
    expect(applyButton().disabled).toBe(false);
    await act(async () => root.render(<EditorRoundtripPanel tab={{ ...tab, pageId: "101" }} />));
    expect(applyButton().disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(injection).not.toHaveBeenCalled();
  });

  it("never writes an unmodified exported file or offers an update for it", async () => {
    await choose(localFile(await source()));
    expect(applyButton().disabled).toBe(true);
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(injection).not.toHaveBeenCalled();
  });
  it("loads a full-export Storage MD locally before page access without contacting the editor", async () => {
    await act(async () =>
      root.render(<EditorRoundtripPanel tab={{ ...tab, accessState: "host-access-missing" }} />),
    );
    const markdown = await createStorageMarkdown(
      {
        representation: "storage",
        html: "<p>Storage original</p>",
        title: "Published",
        pageId: "100",
        version: 3,
      },
      { host: tab.host!, pageId: "100" },
    );
    await choose(localFile(markdown.replace("Storage original", "Storage updated"), "editable.md"));
    expect(container.querySelector("details")?.textContent).toContain("Storage updated");
    expect(applyButton().disabled).toBe(true);
    expect(injection).not.toHaveBeenCalled();
    await act(async () => root.render(<EditorRoundtripPanel tab={tab} />));
    expect(applyButton().disabled).toBe(false);
  });

  it("does not offer an unchanged full-export Storage MD for application", async () => {
    const markdown = await createStorageMarkdown(
      {
        representation: "storage",
        html: "<p>Storage original</p>",
        title: "Published",
        pageId: "100",
        version: 3,
      },
      { host: tab.host!, pageId: "100" },
    );
    await choose(localFile(markdown, "editable.md"));
    expect(applyButton().disabled).toBe(true);
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(injection).not.toHaveBeenCalled();
  });

  it("invalidates a previously applicable edit when the replacement file is invalid", async () => {
    await choose(localFile((await source()).replace("Original text", "Updated text")));
    expect(applyButton().disabled).toBe(false);
    await choose(localFile("# Not an editable export"));
    expect(applyButton().disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(injection).not.toHaveBeenCalled();
  });

  it("does not offer another site's page for updating the active page", async () => {
    const markdown = (await source("https://other.example.test/wiki")).replace(
      "Original text",
      "Updated text",
    );
    await choose(localFile(markdown));
    expect(applyButton().disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(injection).not.toHaveBeenCalled();
  });

  it("does not mutate the editor when confirmation is cancelled", async () => {
    const nativeConfirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await choose(localFile((await source()).replace("Original text", "Updated text")));
    await act(async () => applyButton().click());
    const cancel = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "editorRoundtrip.cancel",
    );
    expect(cancel).toBeDefined();
    expect(nativeConfirm).not.toHaveBeenCalled();
    await act(async () => cancel!.click());
    expect(applyButton().disabled).toBe(false);
    expect(injection).not.toHaveBeenCalled();
  });

  it("loads a dropped MD without opening a native file picker or modifying the editor", async () => {
    const region = container.querySelector('[role="region"]');
    expect(region).not.toBeNull();
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { files: [localFile((await source()).replace("Original text", "Updated text"))] },
    });
    await act(async () => region!.dispatchEvent(event));
    await vi.waitFor(async () => {
      await act(async () => {
        await pause(0);
      });
      expect(applyButton().disabled).toBe(false);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(injection).not.toHaveBeenCalled();
  });

  it("invalidates inline confirmation when another MD file replaces the reviewed edit", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const markdown = await source();
    await choose(localFile(markdown.replace("Original text", "First update")));
    await act(async () => applyButton().click());
    const confirmButton = () =>
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "editorRoundtrip.confirmApply",
      );
    expect(confirmButton()).toBeDefined();
    await choose(localFile(markdown.replace("Original text", "Second update")));
    expect(confirmButton()).toBeUndefined();
    expect(applyButton().disabled).toBe(false);
    expect(injection).not.toHaveBeenCalled();
  });

  it("cannot restore a stale applicable file after a newer file failed to load", async () => {
    const { promise: pending, resolve } = Promise.withResolvers<string>();
    const markdown = (await source()).replace("Original text", "Updated text");
    await choose(localFile(pending, "older.md"), false);
    await choose(localFile("# Invalid", "newer.md"));
    await act(async () => resolve(markdown));
    expect(applyButton().disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(injection).not.toHaveBeenCalled();
  });

  it("does not apply converted private HTML after unmount during a Storage conversion", async () => {
    const storageOriginal = "<p>Storage original</p>";
    const storageUpdated = "<p>Storage updated</p>";
    const privateEditorHtml = "<p>Storage updated PRIVATE-EDIT-9f2c</p>";
    const world = new EditorWorld(
      tab.tabId!,
      trustedEditorSpec(tab.host!, tab.pageId!, storageOriginal),
    );
    injection.mockImplementation(world.executeScript);
    vi.stubGlobal("chrome", { storage: { sync: { get: async () => ({}) } } });
    const gate = Promise.withResolvers<void>();
    const reachedConversion = Promise.withResolvers<void>();
    const response = (value: unknown) =>
      new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        if (method === "GET" && url.pathname === "/wiki/rest/api/content/100") {
          return response({
            id: "100",
            type: "page",
            status: "current",
            title: "Published",
            version: { number: 3 },
            body: { storage: { representation: "storage", value: storageOriginal } },
          });
        }
        if (method === "POST" && url.pathname.startsWith("/wiki/rest/api/contentbody/convert/")) {
          const payload = JSON.parse(String(init?.body));
          expect(payload.content).toEqual({ id: "100" });
          if (
            url.pathname.endsWith("/storage") &&
            payload.representation === "editor" &&
            payload.value === storageOriginal
          ) {
            return response({ representation: "storage", value: storageOriginal });
          }
          if (
            url.pathname.endsWith("/editor") &&
            payload.representation === "storage" &&
            payload.value === storageUpdated
          ) {
            return response({ representation: "editor", value: privateEditorHtml });
          }
          if (
            url.pathname.endsWith("/storage") &&
            payload.representation === "editor" &&
            payload.value === privateEditorHtml
          ) {
            reachedConversion.resolve();
            await gate.promise;
            return response({ representation: "storage", value: storageUpdated });
          }
        }
        throw new Error(`Unexpected request: ${method} ${url.pathname}`);
      }),
    );
    const markdown = await createStorageMarkdown(
      {
        representation: "storage",
        html: storageOriginal,
        title: "Published",
        pageId: tab.pageId!,
        version: 3,
      },
      { host: tab.host!, pageId: tab.pageId! },
    );

    await act(async () => root.render(<ConditionalRoundtripPanel show={true} />));
    await choose(localFile(markdown.replace("Storage original", "Storage updated"), "editable.md"));
    await act(async () => applyButton().click());
    const confirm = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "editorRoundtrip.confirmApply",
    );
    expect(confirm).toBeDefined();
    await act(async () => confirm!.click());
    await reachedConversion.promise;

    await act(async () => root.render(<ConditionalRoundtripPanel show={false} />));
    gate.resolve();
    await act(async () => {
      await pause(20);
    });
    expect(world.activeDocument().editor.setContent).not.toHaveBeenCalled();
    expect(world.activeDocument().body.innerHTML).toBe(storageOriginal);
    expect(world.editorReceived(privateEditorHtml)).toBe(false);
  });
});
