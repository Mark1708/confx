import { initJiraButton } from "./jira-button";
import { initMdButton } from "./md-button";
import { startPicker, stopPicker } from "./picker";

// Listen for commands sent via window.postMessage (triggered by background's executeScript bridge)
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data as { __cx_cmd?: string } | undefined;
  if (!data || typeof data !== "object" || !data.__cx_cmd) return;
  if (data.__cx_cmd === "start-picker") startPicker();
  if (data.__cx_cmd === "stop-picker") stopPicker();
});

// Inject "Open MD" button on Confluence pages.
initMdButton();
initJiraButton();
