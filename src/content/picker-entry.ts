import { startToolbarThemeReporter } from "@/lib/browser/toolbar-theme";
import { initJiraButton } from "./jira-button";
import { initMdButton } from "./md-button";
import { startPicker, stopPicker } from "./picker";

// The manifest and an on-demand grant may both load this entry in the same document.
if (Reflect.get(globalThis, "__cx_picker_ready") !== true) {
  startToolbarThemeReporter();
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data as { __cx_cmd?: string } | undefined;
    if (!data || typeof data !== "object" || !data.__cx_cmd) return;
    if (data.__cx_cmd === "start-picker") startPicker();
    if (data.__cx_cmd === "stop-picker") stopPicker();
  });
  initMdButton();
  initJiraButton();
  Reflect.set(globalThis, "__cx_picker_ready", true);
}
