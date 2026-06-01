/// <reference types="chrome" />

/**
 * Browser API abstraction layer.
 * Wraps chrome.* calls so Firefox (browser.*) support can be added later.
 */
export class BrowserApi {
  // ─── Runtime ──────────────────────────────────────────────────

  static getURL(path: string): string {
    return chrome.runtime.getURL(path);
  }

  static sendMessage(message: unknown): Promise<unknown> {
    return chrome.runtime.sendMessage(message);
  }

  static openOptionsPage(): Promise<void> {
    return chrome.runtime.openOptionsPage();
  }

  static onMessage(
    handler: (msg: unknown, sender: chrome.runtime.MessageSender) => boolean | void,
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

  // ─── Tabs ─────────────────────────────────────────────────────

  static queryTabs(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> {
    return chrome.tabs.query(queryInfo);
  }

  static createTab(properties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab> {
    return chrome.tabs.create(properties);
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

  static createWindow(createData: chrome.windows.CreateData = {}): Promise<chrome.windows.Window> {
    return chrome.windows.create(createData);
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

  static onActionClicked(handler: () => void | Promise<void>): void {
    chrome.action.onClicked.addListener(handler);
  }

  static openActionPopup(): Promise<void> {
    const action = chrome.action as typeof chrome.action & {
      openPopup?: () => Promise<void>;
    };

    if (typeof action.openPopup !== "function") {
      return Promise.reject(new Error("chrome.action.openPopup is not available"));
    }

    return action.openPopup();
  }

  // ─── Downloads ────────────────────────────────────────────────

  static download(options: chrome.downloads.DownloadOptions): Promise<number> {
    return chrome.downloads.download(options);
  }

  // ─── Scripting ────────────────────────────────────────────────

  static executeScript(
    injection: chrome.scripting.ScriptInjection<any[], any>,
  ): Promise<chrome.scripting.InjectionResult[]> {
    return chrome.scripting.executeScript(injection);
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
    _manifestVersion = chrome.runtime.getManifest().manifest_version as 2 | 3;
  }
  return _manifestVersion;
}
