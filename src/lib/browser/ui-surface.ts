import type { ExportJobOwner } from "@/types";
import { BrowserApi, hasSidePanel } from "./browser-api";

export interface UiSurfaceBinding {
  owner: Omit<ExportJobOwner, "instanceId">;
  mode: "active" | "pinned" | "unbound";
  sourceTabId?: number;
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function windowId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isHttpSource(tab: chrome.tabs.Tab, ownTabId: number, expectedId: number): boolean {
  if (tab.id !== expectedId || tab.id === ownTabId) return false;
  try {
    const url = new URL(tab.pendingUrl ?? tab.url ?? "");
    return (
      (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

async function resolvePin(ownTabId: number): Promise<number | undefined> {
  const params = new URL(location.href).searchParams;
  const values = params.getAll("sourceTabId");
  if (values.length !== 1 || !/^[1-9]\d*$/.test(values[0])) return undefined;
  const id = Number(values[0]);
  if (!positiveId(id) || id === ownTabId) return undefined;
  try {
    return isHttpSource(await BrowserApi.getTab(id), ownTabId, id) ? id : undefined;
  } catch {
    return undefined;
  }
}

function isSurfacePath(path: string | undefined): boolean {
  return !!path && new URL(BrowserApi.getURL(path)).pathname === new URL(location.href).pathname;
}

/** Resolve the executing UI, never the browser's last active tab or a query-supplied surface label. */
export async function resolveUiSurface(): Promise<UiSurfaceBinding> {
  const ownTab = await BrowserApi.getCurrentTab();
  if (ownTab) {
    if (!positiveId(ownTab.id) || !windowId(ownTab.windowId)) {
      throw new Error("Cannot identify this extension tab");
    }
    // Vivaldi can return a hidden native-panel pseudo-tab from getCurrent().
    // Only a listed browser tab executing this document owns workspace capabilities.
    const tabs = await BrowserApi.queryTabs({ windowId: ownTab.windowId });
    const listedTab = tabs.find((tab) => tab.id === ownTab.id);
    if (listedTab) {
      const actual = new URL(listedTab.pendingUrl ?? listedTab.url ?? "");
      const current = new URL(location.href);
      if (
        actual.protocol !== current.protocol ||
        actual.host !== current.host ||
        actual.pathname !== current.pathname ||
        actual.search !== current.search
      ) {
        throw new Error("The browser tab does not own this extension document");
      }
      const ownWindow = await BrowserApi.getWindow(ownTab.windowId);
      if (ownWindow.type !== "normal" && ownWindow.type !== "popup") {
        throw new Error("Unsupported extension window");
      }
      const owner: UiSurfaceBinding["owner"] = {
        surface: ownWindow.type === "normal" ? "workspace" : "popup",
        tabId: ownTab.id,
        windowId: ownTab.windowId,
      };
      const sourceTabId = await resolvePin(ownTab.id);
      return sourceTabId === undefined
        ? { owner, mode: "unbound" }
        : { owner, mode: "pinned", sourceTabId };
    }
  }

  const ownWindow = await BrowserApi.getCurrentWindow();
  if (!windowId(ownWindow.id) || ownWindow.type !== "normal") {
    throw new Error("Cannot identify the owning browser window");
  }
  const manifest = BrowserApi.getManifest() as chrome.runtime.Manifest & {
    side_panel?: { default_path?: string };
  };
  if (isSurfacePath(manifest.action?.default_popup)) {
    return { owner: { surface: "popup", windowId: ownWindow.id }, mode: "active" };
  }
  if (hasSidePanel() && isSurfacePath(manifest.side_panel?.default_path)) {
    return { owner: { surface: "panel", windowId: ownWindow.id }, mode: "active" };
  }
  throw new Error("Cannot identify this extension surface");
}

/** Focus an existing owner without replacing its URL or interrupting its live controller. */
export async function focusUiSurface(owner: ExportJobOwner): Promise<void> {
  if (positiveId(owner.tabId)) {
    const tab = await BrowserApi.getTab(owner.tabId);
    const expected = new URL(BrowserApi.getURL("sidepanel/index.html"));
    const actual = new URL(tab.url ?? "");
    if (
      actual.protocol !== expected.protocol ||
      actual.host !== expected.host ||
      actual.pathname !== expected.pathname ||
      !windowId(tab.windowId)
    ) {
      throw new Error("The export owner is no longer an extension workspace");
    }
    await BrowserApi.updateTab(owner.tabId, { active: true });
    await BrowserApi.updateWindow(tab.windowId, { focused: true });
    return;
  }
  if (!windowId(owner.windowId)) throw new Error("The export owner is unavailable");
  // Native open must consume the original click gesture, before any focus await yields control.
  let opening: Promise<void>;
  if (owner.surface === "panel" && hasSidePanel()) {
    opening = BrowserApi.openSidePanel({ windowId: owner.windowId });
  } else if (owner.surface === "popup" && BrowserApi.getManifest().action?.default_popup) {
    opening = BrowserApi.openActionPopup({ windowId: owner.windowId });
  } else {
    throw new Error("The export owner is unavailable");
  }
  await opening;
  await BrowserApi.updateWindow(owner.windowId, { focused: true });
}
