import { BrowserApi } from "@/lib/browser";

const extensionId = new URL(BrowserApi.getURL("")).hostname;
const stopMessages = BrowserApi.onMessage((message, sender, sendResponse) => {
  if (
    typeof message === "object" &&
    message !== null &&
    !Array.isArray(message) &&
    "type" in message &&
    message.type === "icon-system-theme-query" &&
    "target" in message &&
    message.target === "icon-theme-observer" &&
    sender.id === extensionId
  ) {
    sendResponse({
      theme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    });
  }
  return false;
});
window.addEventListener("pagehide", stopMessages, { once: true });
