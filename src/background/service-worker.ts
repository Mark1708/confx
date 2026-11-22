import { BrowserApi, hasSidePanel, MessageBus, storage } from "@/lib/browser";
import {
  ensureTrustedSession,
  storeSourceIntent,
  type SourceIntentRecord,
} from "@/lib/browser/source-intents";
import type { UpdateLauncherStateResponse } from "@/types";
import { handleLauncherStateUpdate } from "./launcher-state";
import { startToolbarIcon } from "./toolbar-icon";

const SIDEPANEL_PATH = "sidepanel/index.html";
const FALLBACK_PREFIX = "cx.fallbackWindow.v2:";
const fallbackOpenings = new Map<number, Promise<void>>();

type IntentSource = SourceIntentRecord["source"];

function validateEnvironment(): boolean {
  if (!chrome.runtime?.id || !chrome.storage?.session || !chrome.tabs) {
    console.error("[cx] Required extension APIs are unavailable");
    return false;
  }
  return true;
}

function sourceFromTab(tab: chrome.tabs.Tab): IntentSource {
  const url = new URL(tab.pendingUrl ?? tab.url ?? "");
  if (
    typeof tab.id !== "number" ||
    !Number.isSafeInteger(tab.id) ||
    tab.id <= 0 ||
    !Number.isSafeInteger(tab.windowId) ||
    tab.windowId < 0 ||
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  ) {
    throw new Error("A source must be an existing HTTP(S) tab");
  }
  return { tabId: tab.id, windowId: tab.windowId, url: url.href, origin: url.origin };
}

function isPinnedFallback(url: string | undefined, tabId: number): boolean {
  try {
    const actual = new URL(url ?? "");
    const expected = new URL(BrowserApi.getURL(SIDEPANEL_PATH));
    return (
      actual.protocol === expected.protocol &&
      actual.host === expected.host &&
      actual.pathname === expected.pathname &&
      actual.searchParams.getAll("sourceTabId").length === 1 &&
      actual.searchParams.get("sourceTabId") === String(tabId)
    );
  } catch {
    return false;
  }
}

async function createOrFocusFallback(source: IntentSource): Promise<void> {
  const key = `${FALLBACK_PREFIX}${source.tabId}`;
  const existingId = (await storage.session.get(key))[key];
  if (typeof existingId === "number" && Number.isSafeInteger(existingId) && existingId >= 0) {
    try {
      const window = await BrowserApi.getWindow(existingId);
      const tabs = await BrowserApi.queryTabs({ windowId: existingId });
      if (
        window.type === "popup" &&
        tabs.some((tab) => isPinnedFallback(tab.pendingUrl ?? tab.url, source.tabId))
      ) {
        await BrowserApi.updateWindow(existingId, { focused: true });
        return;
      }
    } catch {
      // A stale window id is harmless; never navigate or repurpose a different surviving UI.
    }
  }
  const params = new URLSearchParams({ sourceTabId: String(source.tabId) });
  const created = await BrowserApi.createWindow({
    url: BrowserApi.getURL(`${SIDEPANEL_PATH}?${params}`),
    type: "popup",
    width: 600,
    height: 600,
  });
  if (typeof created.id !== "number") throw new Error("The source workspace did not open");
  await storage.session.set({ [key]: created.id });
}

function openFallback(source: IntentSource): Promise<void> {
  const pending = fallbackOpenings.get(source.tabId);
  if (pending) return pending;
  const opening = createOrFocusFallback(source);
  fallbackOpenings.set(source.tabId, opening);
  const cleanup = () => {
    if (fallbackOpenings.get(source.tabId) === opening) fallbackOpenings.delete(source.tabId);
  };
  void opening.then(cleanup, cleanup);
  return opening;
}

async function openForSource(source: IntentSource): Promise<void> {
  const actual = sourceFromTab(await BrowserApi.getTab(source.tabId));
  const [active] = await BrowserApi.queryTabs({ active: true, windowId: actual.windowId });
  const originalUrl = new URL(source.url);
  const currentUrl = new URL(actual.url);
  const sameDocument =
    originalUrl.origin === currentUrl.origin &&
    originalUrl.pathname === currentUrl.pathname &&
    originalUrl.search === currentUrl.search;
  if (active?.id === source.tabId && sameDocument) {
    if (BrowserApi.getManifest().action?.default_popup) {
      try {
        await BrowserApi.openActionPopup({ windowId: actual.windowId });
        return;
      } catch {
        // Browsers without a usable native popup still get an explicitly pinned fallback.
      }
    }
    if (hasSidePanel()) {
      try {
        await BrowserApi.openSidePanel({ windowId: actual.windowId });
        return;
      } catch {
        // Never open another window's active tab as the source when native panel opening fails.
      }
    }
  }
  await openFallback(actual);
}

function assertTrustedUi(sender: chrome.runtime.MessageSender): void {
  const url = new URL(sender.url ?? "");
  const extension = new URL(BrowserApi.getURL(""));
  if (
    sender.id !== extension.host ||
    url.protocol !== extension.protocol ||
    url.host !== extension.host ||
    (sender.frameId !== undefined && sender.frameId !== 0)
  ) {
    throw new Error("Only a trusted extension UI may open a workspace");
  }
}

if (validateEnvironment()) {
  startToolbarIcon();
  // Session handoffs remain trusted-only; launcher preferences stay local to this device.
  const trustedSession = ensureTrustedSession();
  void trustedSession.catch(() => {
    console.error("[cx] Cannot restore trusted-only session access");
  });

  if (hasSidePanel()) {
    BrowserApi.onInstalled(() => {
      BrowserApi.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
        console.error("[cx] Cannot initialize the native side panel");
      });
    });
    BrowserApi.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
      console.error("[cx] Cannot initialize the native side panel");
    });
  } else {
    BrowserApi.onActionClicked(async (tab) => {
      try {
        await trustedSession;
        await openFallback(sourceFromTab(tab));
      } catch {
        console.error("[cx] Cannot open a workspace for this source tab");
      }
    });
  }

  MessageBus.on("open-confx", async (message, sender) => {
    await trustedSession;
    const record = await storeSourceIntent(message, sender);
    await openForSource(record.source);
    return { ok: true };
  });

  MessageBus.on("picker-result", async (message, sender) => {
    await trustedSession;
    const record = await storeSourceIntent(message, sender);
    await openForSource(record.source);
    return { ok: true };
  });

  MessageBus.on(
    "update-launcher-state",
    async (message, sender): Promise<UpdateLauncherStateResponse> => ({
      ok: true,
      state: await handleLauncherStateUpdate(message, sender),
    }),
  );

  MessageBus.on("open-workspace", async (message, sender) => {
    assertTrustedUi(sender);
    if (
      !Number.isSafeInteger(message.sourceTabId) ||
      message.sourceTabId <= 0 ||
      (message.tool !== "export" && message.tool !== "edit")
    ) {
      throw new Error("Invalid workspace source or tool");
    }
    await trustedSession;
    const tab = await BrowserApi.getTab(message.sourceTabId);
    const source = sourceFromTab(tab);
    if (source.tabId !== message.sourceTabId) throw new Error("The source tab is unavailable");
    const params = new URLSearchParams({
      surface: "workspace",
      sourceTabId: String(source.tabId),
      tool: message.tool,
    });
    const created = await BrowserApi.createTab({
      windowId: source.windowId,
      openerTabId: source.tabId,
      url: BrowserApi.getURL(`${SIDEPANEL_PATH}?${params}`),
      active: true,
    });
    return { ok: true, tabId: created.id };
  });
}
