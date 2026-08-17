import { BrowserApi, hasSidePanel, MessageBus, storage } from "@/lib/browser";
import type { OpenMdViewerRequest } from "@/types";

/**
 * Service worker в MV3 не имеет DOM API (нет DOMParser, document и т.д.),
 * поэтому весь extraction pipeline выполняется в sidepanel.
 * SW здесь нужен только для настройки поведения side panel и проксирования
 * сообщений от контент-скрипта (например, "открыть MD-просмотрщик").
 *
 * Chrome toolbar action opens the side panel via openPanelOnActionClick.
 * Yandex toolbar action uses manifest default_popup. Content-initiated opens
 * try chrome.action.openPopup() first and fall back to sidePanel or a detached
 * popup window when the native popup API is unavailable.
 */

const SIDEPANEL_URL = "sidepanel/index.html";
const FALLBACK_WINDOW_ID_KEY = "cx:fallbackWindowId";
const PICKER_RESULT_KEY = "cx:pickerResult";
const OPEN_CONFX_INTENT_KEY = "cx:openConfxIntent";

function validateEnvironment(): boolean {
  if (!chrome.runtime?.id) {
    console.error("[cx] missing chrome.runtime.id");
    return false;
  }

  if (!chrome.storage?.session) {
    console.error("[cx] missing chrome.storage.session");
    return false;
  }

  if (!chrome.tabs) {
    console.error("[cx] missing chrome.tabs");
    return false;
  }

  return true;
}

if (validateEnvironment()) {
  if (hasSidePanel()) {
    BrowserApi.onInstalled(() => {
      BrowserApi.setPanelBehavior({ openPanelOnActionClick: true }).catch((e) =>
        console.error("sidePanel init error:", e),
      );
    });

    BrowserApi.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }

  // Allow popup/sidepanel to read chrome.storage.session
  chrome.storage.session
    .setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })
    .catch(() => {});

  BrowserApi.onActionClicked(() => {
    openFallbackWindow();
  });

  async function openFallbackWindow(): Promise<void> {
    const url = BrowserApi.getURL(SIDEPANEL_URL);
    const stored = await storage.session.get(FALLBACK_WINDOW_ID_KEY);
    const existingId = stored[FALLBACK_WINDOW_ID_KEY] as number | undefined;

    if (typeof existingId === "number") {
      try {
        const win = await BrowserApi.getWindow(existingId);
        if (win) {
          await BrowserApi.updateWindow(existingId, { focused: true });
          return;
        }
      } catch {
        // окно закрыто — создадим новое
      }
    }

    const created = await BrowserApi.createWindow({
      url,
      type: "popup",
      width: 600,
      height: 600,
    });

    if (typeof created.id === "number") {
      await storage.session.set({ [FALLBACK_WINDOW_ID_KEY]: created.id });
    }
  }

  async function openSidePanelOrFallback(sender: chrome.runtime.MessageSender): Promise<void> {
    if (!hasSidePanel()) {
      await openFallbackWindow();
      return;
    }

    const windowId = sender.tab?.windowId ?? (await BrowserApi.getCurrentWindow()).id;
    if (typeof windowId !== "number") {
      throw new Error("Cannot determine current window");
    }

    await BrowserApi.openSidePanel({ windowId });
  }

  BrowserApi.onWindowRemoved(async (removedId) => {
    const stored = await storage.session.get(FALLBACK_WINDOW_ID_KEY);
    if (stored[FALLBACK_WINDOW_ID_KEY] === removedId) {
      await storage.session.remove(FALLBACK_WINDOW_ID_KEY);
    }
  });

  MessageBus.on("open-jira-export", async (_msg, sender) => {
    await openSidePanelOrFallback(sender);
    return { ok: true };
  });

  async function openNativePopupOrFallback(sender: chrome.runtime.MessageSender): Promise<void> {
    try {
      await BrowserApi.openActionPopup();
      return;
    } catch (error) {
      console.warn(
        "[cx] native action popup is unavailable; falling back to sidePanel or detached popup window",
        error,
      );
    }

    await openSidePanelOrFallback(sender);
  }

  MessageBus.on("open-confx", async (msg, sender) => {
    await storage.session.set({ [OPEN_CONFX_INTENT_KEY]: msg });
    await openNativePopupOrFallback(sender);
    return { ok: true };
  });

  MessageBus.on<OpenMdViewerRequest["kind"]>("open-md-viewer", (msg, sender) => {
    const typed = msg as OpenMdViewerRequest;
    const params = new URLSearchParams({
      host: typed.host,
      pageId: typed.pageId,
    });
    if (typed.title) params.set("title", typed.title);

    const viewerUrl = BrowserApi.getURL(`viewer/index.html?${params.toString()}`);

    return BrowserApi.createTab({
      url: viewerUrl,
      openerTabId: sender.tab?.id,
      active: true,
    }).then((tab) => ({ ok: true, tabId: tab.id }));
  });

  MessageBus.on("picker-result", async (msg, sender) => {
    await storage.session.set({ [PICKER_RESULT_KEY]: msg });
    await openNativePopupOrFallback(sender);
    return { ok: true };
  });
}
