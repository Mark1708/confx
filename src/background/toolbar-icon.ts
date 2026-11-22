import type { ResolvedTheme } from "@/lib/appearance";
import { BrowserApi, watchStorageKey } from "@/lib/browser";
import { loadSettings } from "@/lib/settings";
import type { ThemePalette } from "@/types";

const SETTINGS_KEY = "cx.settings.v1";
const OBSERVER_PATH = "offscreen/icon-theme.html";
const ICON_SIZES = [16, 20, 24, 32, 40, 48, 64] as const;
const UI_PATHS = new Set([
  "/sidepanel/index.html",
  "/options/index.html",
  "/viewer/index.html",
  "/src/sidepanel/index.html",
  "/src/options/index.html",
  "/src/viewer/index.html",
]);

function isSystemThemeResponse(value: unknown): value is { theme: ResolvedTheme } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "theme" in value &&
    (value.theme === "light" || value.theme === "dark")
  );
}

function isThemeReporter(sender: chrome.runtime.MessageSender, extensionId: string): boolean {
  if (sender.id !== extensionId || (sender.frameId !== undefined && sender.frameId !== 0))
    return false;
  try {
    const url = new URL(sender.url ?? "");
    if (url.protocol === "chrome-extension:" && url.hostname === extensionId) {
      return UI_PATHS.has(url.pathname);
    }
    return Boolean(
      sender.tab &&
      Number.isSafeInteger(sender.tab.id) &&
      sender.tab.id! > 0 &&
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      new URL(sender.tab.url ?? sender.url!).origin === url.origin,
    );
  } catch {
    return false;
  }
}

/** Serialize preferences and live visible-page signals; offscreen is only a cold-start sample. */
export function startToolbarIcon(): () => void {
  const observerUrl = BrowserApi.getURL(OBSERVER_PATH);
  const extensionId = new URL(observerUrl).hostname;
  let disposed = false;
  let busy = false;
  let pending = false;
  let revision = 0;
  let systemTheme: ResolvedTheme | undefined;
  let applied: { theme: ResolvedTheme; palette: ThemePalette } | undefined;

  const isCurrent = (candidate: number): boolean => !disposed && candidate === revision;

  async function reconcile(candidate: number): Promise<void> {
    const settings = await loadSettings();
    if (!isCurrent(candidate)) return;

    const contexts = await BrowserApi.getOffscreenContexts(observerUrl);
    if (!isCurrent(candidate)) return;
    const hasObserver = contexts.some(
      (context) =>
        context.contextType === "OFFSCREEN_DOCUMENT" && context.documentUrl === observerUrl,
    );

    let theme: ResolvedTheme;
    if (settings.theme === "system") {
      if (systemTheme === undefined) {
        let ownsDocument = hasObserver;
        try {
          if (!ownsDocument) {
            await BrowserApi.createMatchMediaDocument(
              OBSERVER_PATH,
              "Read the current system color scheme once for the Confx toolbar icon.",
            );
            ownsDocument = true;
          }
          if (!isCurrent(candidate)) return;
          const response = await BrowserApi.sendMessage({
            type: "icon-system-theme-query",
            target: "icon-theme-observer",
          });
          if (!isCurrent(candidate)) return;
          if (!isSystemThemeResponse(response)) throw new Error("Invalid system theme response");
          systemTheme = response.theme;
        } finally {
          if (ownsDocument) await BrowserApi.closeOffscreenDocument();
        }
        if (!isCurrent(candidate)) return;
      } else if (hasObserver) {
        await BrowserApi.closeOffscreenDocument();
        if (!isCurrent(candidate)) return;
      }
      theme = systemTheme;
    } else {
      systemTheme = undefined;
      if (hasObserver) {
        await BrowserApi.closeOffscreenDocument();
        if (!isCurrent(candidate)) return;
      }
      theme = settings.theme;
    }

    if (applied?.theme === theme && applied.palette === settings.palette) return;
    const path: Record<number, string> = {};
    for (const size of ICON_SIZES) {
      path[size] = BrowserApi.getURL(`assets/icons/${theme}-${settings.palette}-${size}.png`);
    }
    // Never overlap browser writes: a pending old write must finish before the newest can start.
    await BrowserApi.setActionIcon({ path });
    if (!disposed) applied = { theme, palette: settings.palette };
  }

  async function drain(): Promise<void> {
    while (!disposed && pending) {
      pending = false;
      try {
        await reconcile(revision);
      } catch {
        if (!disposed) console.error("[cx] Cannot synchronize the toolbar icon");
      }
    }
    busy = false;
  }

  function schedule(): void {
    if (disposed) return;
    revision += 1;
    pending = true;
    if (!busy) {
      busy = true;
      void drain();
    }
  }

  const stopSettings = watchStorageKey("sync", SETTINGS_KEY, schedule);
  const stopMessages = BrowserApi.onMessage((message, sender) => {
    if (
      typeof message === "object" &&
      message !== null &&
      !Array.isArray(message) &&
      "type" in message &&
      message.type === "icon-system-theme-changed" &&
      "target" in message &&
      message.target === "toolbar-icon" &&
      isSystemThemeResponse(message) &&
      isThemeReporter(sender, extensionId)
    ) {
      systemTheme = message.theme;
      schedule();
    }
    // Never keep a content script's response channel open while reconciling preferences.
    return false;
  });
  schedule();

  return () => {
    if (disposed) return;
    disposed = true;
    pending = false;
    revision += 1;
    stopSettings();
    stopMessages();
  };
}
