/// <reference types="chrome" />
import { isCurrentOriginPattern } from "./tab-access";

/**
 * Browser API abstraction layer.
 * Wraps chrome.* calls so Firefox (browser.*) support can be added later.
 */
export class BrowserApi {
  // ─── Runtime ──────────────────────────────────────────────────

  static getURL(path: string): string {
    return chrome.runtime.getURL(path);
  }

  static getManifest(): chrome.runtime.Manifest {
    return chrome.runtime.getManifest();
  }

  static sendMessage(message: unknown): Promise<unknown> {
    return chrome.runtime.sendMessage(message);
  }

  static openOptionsPage(): Promise<void> {
    return chrome.runtime.openOptionsPage();
  }

  static onMessage(
    handler: (
      msg: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response: unknown) => void,
    ) => boolean | void,
  ): () => void {
    chrome.runtime.onMessage.addListener(
      handler as Parameters<typeof chrome.runtime.onMessage.addListener>[0],
    );
    return () =>
      chrome.runtime.onMessage.removeListener(
        handler as Parameters<typeof chrome.runtime.onMessage.removeListener>[0],
      );
  }

  static onInstalled(handler: () => void | Promise<void>): void {
    chrome.runtime.onInstalled.addListener(handler);
  }

  static getOffscreenContexts(documentUrl: string): Promise<chrome.runtime.ExtensionContext[]> {
    return chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [documentUrl],
    });
  }

  // ─── Offscreen ────────────────────────────────────────────────

  static createMatchMediaDocument(url: string, justification: string): Promise<void> {
    return chrome.offscreen.createDocument({
      url,
      reasons: [chrome.offscreen.Reason.MATCH_MEDIA],
      justification,
    });
  }

  static closeOffscreenDocument(): Promise<void> {
    return chrome.offscreen.closeDocument();
  }

  // ─── Tabs ─────────────────────────────────────────────────────

  static getTab(tabId: number): Promise<chrome.tabs.Tab> {
    return chrome.tabs.get(tabId);
  }

  static getCurrentTab(): Promise<chrome.tabs.Tab | undefined> {
    return chrome.tabs.getCurrent();
  }

  static queryTabs(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> {
    return chrome.tabs.query(queryInfo);
  }

  static async createTab(properties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab> {
    const created = await chrome.tabs.create(properties);
    return navigateCreatedBlankTab(created, properties.url);
  }

  static updateTab(
    tabId: number,
    updateProperties: chrome.tabs.UpdateProperties,
  ): Promise<chrome.tabs.Tab> {
    return chrome.tabs.update(tabId, updateProperties);
  }

  static onTabActivated(handler: (info: chrome.tabs.TabActiveInfo) => void): () => void {
    chrome.tabs.onActivated.addListener(handler);
    return () => chrome.tabs.onActivated.removeListener(handler);
  }

  static onTabUpdated(
    handler: (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => void,
  ): () => void {
    chrome.tabs.onUpdated.addListener(handler);
    return () => chrome.tabs.onUpdated.removeListener(handler);
  }

  static onTabRemoved(
    handler: (tabId: number, removeInfo: chrome.tabs.TabRemoveInfo) => void,
  ): () => void {
    chrome.tabs.onRemoved.addListener(handler);
    return () => chrome.tabs.onRemoved.removeListener(handler);
  }

  // ─── Windows ──────────────────────────────────────────────────

  static getWindow(windowId: number): Promise<chrome.windows.Window> {
    return chrome.windows.get(windowId);
  }

  static getCurrentWindow(): Promise<chrome.windows.Window> {
    return chrome.windows.getCurrent();
  }

  static updateWindow(
    windowId: number,
    updateInfo: chrome.windows.UpdateInfo,
  ): Promise<chrome.windows.Window> {
    return chrome.windows.update(windowId, updateInfo);
  }

  static async createWindow(
    createData: chrome.windows.CreateData = {},
  ): Promise<chrome.windows.Window> {
    const created = await chrome.windows.create(createData);
    if (typeof createData.url === "string" && typeof created.id === "number") {
      // Popups may come back without their tab despite the URL being requested;
      // resolve only this window's own tabs, never an ambient one.
      const tabs = created.tabs?.length
        ? created.tabs
        : await chrome.tabs.query({ windowId: created.id });
      if (tabs.length !== 1) throw new Error("The created window has no unique destination tab");
      await navigateCreatedBlankTab(tabs[0], createData.url);
    }
    return created;
  }

  static onWindowRemoved(handler: (windowId: number) => void): () => void {
    chrome.windows.onRemoved.addListener(handler);
    return () => chrome.windows.onRemoved.removeListener(handler);
  }

  // ─── SidePanel ────────────────────────────────────────────────

  static setPanelBehavior(behavior: { openPanelOnActionClick: boolean }): Promise<void> {
    return chrome.sidePanel.setPanelBehavior(behavior);
  }

  static openSidePanel(options: { windowId: number }): Promise<void> {
    return chrome.sidePanel.open(options);
  }

  // ─── Action ───────────────────────────────────────────────────

  static onActionClicked(handler: (tab: chrome.tabs.Tab) => void | Promise<void>): void {
    chrome.action.onClicked.addListener(handler);
  }

  static setActionIcon(details: chrome.action.TabIconDetails): Promise<void> {
    return chrome.action.setIcon(details);
  }

  static openActionPopup(options?: chrome.action.OpenPopupOptions): Promise<void> {
    const action = chrome.action as typeof chrome.action & {
      openPopup?: (options?: chrome.action.OpenPopupOptions) => Promise<void>;
    };

    if (typeof action.openPopup !== "function") {
      return Promise.reject(new Error("chrome.action.openPopup is not available"));
    }

    return action.openPopup(options);
  }

  // ─── Downloads ────────────────────────────────────────────────

  static download(options: chrome.downloads.DownloadOptions): Promise<number> {
    return chrome.downloads.download(options);
  }

  static searchDownloads(
    query: chrome.downloads.DownloadQuery,
  ): Promise<chrome.downloads.DownloadItem[]> {
    return chrome.downloads.search(query);
  }

  static cancelDownload(downloadId: number): Promise<void> {
    return chrome.downloads.cancel(downloadId);
  }

  static onDownloadChanged(handler: (delta: chrome.downloads.DownloadDelta) => void): () => void {
    chrome.downloads.onChanged.addListener(handler);
    return () => chrome.downloads.onChanged.removeListener(handler);
  }

  // ─── Storage ──────────────────────────────────────────────────

  static setSessionAccessLevel(accessLevel: chrome.storage.AccessLevel): Promise<void> {
    return chrome.storage.session.setAccessLevel({ accessLevel });
  }

  static onStorageChanged(
    handler: (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void,
  ): () => void {
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }

  // ─── Permissions ──────────────────────────────────────────────

  static async containsOriginPermission(originPattern: string): Promise<boolean> {
    assertCurrentOriginPattern(originPattern);
    return chrome.permissions.contains({ origins: [originPattern] });
  }

  static async requestOriginPermission(originPattern: string): Promise<boolean> {
    assertCurrentOriginPattern(originPattern);
    return chrome.permissions.request({ origins: [originPattern] });
  }

  // ─── Scripting ────────────────────────────────────────────────

  static executeScript(
    injection: chrome.scripting.ScriptInjection<any[], any>,
  ): Promise<chrome.scripting.InjectionResult[]> {
    return chrome.scripting.executeScript(injection);
  }
}

function assertCurrentOriginPattern(originPattern: string): void {
  if (!isCurrentOriginPattern(originPattern)) {
    throw new Error("Invalid current-origin permission pattern");
  }
}

// ─── Capabilities ────────────────────────────────────────────────

export function hasSidePanel(): boolean {
  return typeof chrome !== "undefined" && typeof chrome.sidePanel?.setPanelBehavior === "function";
}

export function hasActionPopup(): boolean {
  return typeof chrome !== "undefined" && typeof chrome.action?.openPopup === "function";
}

export function hasSidebarAction(): boolean {
  // Firefox/Opera support — not yet implemented
  return false;
}

let _manifestVersion: 2 | 3 | undefined;
export function manifestVersion(): 2 | 3 {
  if (_manifestVersion === undefined) {
    _manifestVersion = BrowserApi.getManifest().manifest_version as 2 | 3;
  }
  return _manifestVersion;
}

async function navigateCreatedBlankTab(
  tab: chrome.tabs.Tab,
  requestedUrl: string | undefined,
): Promise<chrome.tabs.Tab> {
  // Some Chromium derivatives finish creation on about:blank despite the URL.
  // Do not restart an in-flight navigation or a document that already redirected.
  if (
    !requestedUrl ||
    requestedUrl === "about:blank" ||
    typeof tab.id !== "number" ||
    tab.pendingUrl ||
    (tab.url && tab.url !== "about:blank")
  ) {
    return tab;
  }
  return chrome.tabs.update(tab.id, { url: requestedUrl });
}
