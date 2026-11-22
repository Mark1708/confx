import { webcrypto } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserApi } from "@/lib/browser/browser-api";
import { createEditorMarkdown } from "@/lib/editor-markdown";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { WorkspaceShell } from "@/sidepanel/components/WorkspaceShell";
import type { CurrentTabInfo } from "@/sidepanel/hooks/useCurrentTab";
import type { WorkspaceDraft } from "@/sidepanel/workspace/contracts";

const hooks = vi.hoisted(() => ({ shell: {} as Record<string, unknown> }));
vi.mock("@/sidepanel/workspace/WorkspaceProvider", () => ({ useWorkspaceShell: () => hooks.shell }));
vi.mock("@/sidepanel/hooks/useI18n", () => ({ useI18n: () => ({ locale: "en", t: (key: string) => key }) }));
vi.mock("@/sidepanel/hooks/useTheme", () => ({ useTheme: () => {} }));
vi.mock("@/sidepanel/hooks/useFontSize", () => ({ useFontSize: () => {} }));
vi.mock("@/sidepanel/hooks/useSubscriptions", () => ({ useSubscriptions: () => ({ subscriptions: [] }) }));

const tab: CurrentTabInfo = {
  tabId: 7,
  windowId: 1,
  url: "https://wiki.example.test/wiki/pages/viewpage.action?pageId=100",
  host: "https://wiki.example.test/wiki",
  pageId: "100",
  accessState: "available",
  grantStatus: "idle",
  retry: async () => {},
  grantAccess: async () => {},
};

function Host({ currentTab = tab }: { currentTab?: CurrentTabInfo }) {
  const source = { tabId: currentTab.tabId!, windowId: 1, product: "confluence" as const, baseUrl: currentTab.host!, pageId: currentTab.pageId!, pageUrl: currentTab.url! };
  const [draft, setDraft] = useState<WorkspaceDraft>({
    source,
    section: "edit",
    scope: "page",
    defaults: null,
    destination: "download-zip",
    subtree: { filter: "", expandedIds: [], serverSearch: { status: "idle", query: "", count: 0 } },
    space: { label: "", prefix: "" },
    jira: { jql: "" },
    watch: { expandedId: null, selectedPageIds: {} },
    lastIntentIds: {},
  });
  hooks.shell = {
    tab: currentTab, source, sourceKey: `${source.tabId}:${source.product}:${source.baseUrl}`,
    draft, patchDraft: (patch: Partial<WorkspaceDraft>) => setDraft((value) => ({ ...value, ...patch })),
    controller: null, exportView: { state: null, error: null, errorCode: null, busy: false, ownsJob: false },
    workspace: { hydrated: true }, settings: { data: DEFAULT_SETTINGS, error: null },
    binding: { mode: "pinned", owner: { surface: "workspace", tabId: 31, windowId: 1 } },
    store: { flush: async () => {} }, error: null,
  };
  return <WorkspaceShell><p>Export content</p></WorkspaceShell>;
}

describe("production workspace editor lifetime", () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalScrollTo = HTMLElement.prototype.scrollTo;
  beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto);
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.spyOn(BrowserApi, "executeScript").mockResolvedValue([]);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    HTMLElement.prototype.scrollTo = originalScrollTo;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const button = (key: string) => [...container.querySelectorAll("button")].find((node) => node.textContent === key)!;
  async function loadEdit() {
    const markdown = await createEditorMarkdown({ representation: "editor", html: "<p>Lorem original</p>", title: "Lorem", pageId: "100" }, { host: tab.host!, pageId: "100" });
    const file = new File([], "lorem-edit.md", { type: "text/markdown" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode(markdown.replace("Lorem original", "Ipsum edited")).buffer });
    const input = container.querySelector<HTMLInputElement>("#editor-markdown")!;
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await vi.waitFor(async () => {
      await act(async () => { await pause(0); });
      expect(button("editorRoundtrip.apply").disabled).toBe(false);
    });
  }

  it("retains the parsed file, diff and pending confirmation across hidden sections without writing", async () => {
    await act(async () => root.render(<Host />));
    await loadEdit();
    await act(async () => button("editorRoundtrip.apply").click());
    const input = container.querySelector("#editor-markdown");
    const confirmation = button("editorRoundtrip.confirmApply");
    expect(confirmation).toBeDefined();
    await act(async () => button("sidepanel.sections.export").click());
    expect(input?.closest("section")?.hidden).toBe(true);
    await act(async () => button("sidepanel.sections.watch").click());
    await act(async () => button("sidepanel.sections.edit").click());
    expect(container.querySelector("#editor-markdown")).toBe(input);
    expect(button("editorRoundtrip.confirmApply")).toBe(confirmation);
    expect(container.querySelector("ins")?.textContent).toContain("Ipsum edited");
    expect(BrowserApi.executeScript).not.toHaveBeenCalled();
  });

  it("clears the loaded file and confirmation when the actual source page identity changes", async () => {
    await act(async () => root.render(<Host />));
    await loadEdit();
    await act(async () => button("editorRoundtrip.apply").click());
    await act(async () => root.render(<Host currentTab={{ ...tab, pageId: "101", url: "https://wiki.example.test/wiki/pages/viewpage.action?pageId=101" }} />));
    expect(button("editorRoundtrip.confirmApply")).toBeUndefined();
    expect(button("editorRoundtrip.apply").disabled).toBe(true);
    expect(container.querySelector("ins")).toBeNull();
    expect(container.textContent).not.toContain("lorem-edit.md");
    expect(BrowserApi.executeScript).not.toHaveBeenCalled();
  });

  it("opens the sole options surface rather than replacing the loaded editor workflow", async () => {
    vi.spyOn(BrowserApi, "openOptionsPage").mockResolvedValue(undefined);
    await act(async () => root.render(<Host />));
    await loadEdit();
    const input = container.querySelector("#editor-markdown");
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="sidepanel.header.settings"]')!.click());
    expect(BrowserApi.openOptionsPage).toHaveBeenCalledTimes(1);
    expect(container.querySelector("#editor-markdown")).toBe(input);
    expect(button("editorRoundtrip.apply").disabled).toBe(false);
  });
});
