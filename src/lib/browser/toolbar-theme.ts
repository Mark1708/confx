import type { ResolvedTheme } from "@/lib/appearance";
import { watchSystemTheme } from "@/lib/appearance";
import { BrowserApi } from "./browser-api";

/** Chromium does not deliver live media changes to invisible/offscreen documents. */
export async function reportToolbarSystemTheme(theme: ResolvedTheme): Promise<void> {
  if (document.visibilityState !== "visible") return;
  try {
    await BrowserApi.sendMessage({
      type: "icon-system-theme-changed",
      target: "toolbar-icon",
      theme,
    });
  } catch {
    console.error("[cx] Cannot report system appearance to the toolbar");
  }
}

/** Own one page-lifetime observer, including back/forward-cache restoration. */
export function startToolbarThemeReporter(): () => void {
  let stop: (() => void) | undefined;
  const resume = () => {
    stop ??= watchSystemTheme((theme) => void reportToolbarSystemTheme(theme));
  };
  const pause = () => {
    stop?.();
    stop = undefined;
  };
  window.addEventListener("pagehide", pause);
  window.addEventListener("pageshow", resume);
  resume();
  return () => {
    pause();
    window.removeEventListener("pagehide", pause);
    window.removeEventListener("pageshow", resume);
  };
}
