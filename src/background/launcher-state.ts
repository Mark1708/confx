import { BrowserApi } from "@/lib/browser/browser-api";
import { storage } from "@/lib/browser/storage";
import {
  DEFAULT_LAUNCHER_POSITION,
  launcherSiteKey,
  LAUNCHER_STORAGE_KEY,
  loadLauncherState,
  type LauncherOverride,
  type LauncherState,
} from "@/lib/launcher-state";
import type { UpdateLauncherStateRequest } from "@/types";

// Only the service worker imports this owner in production. All surfaces send mutations here.
let pendingWrite: Promise<unknown> = Promise.resolve();

function validateSender(origin: string, sender: chrome.runtime.MessageSender): void {
  const extension = new URL(BrowserApi.getURL(""));
  const documentUrl = new URL(sender.url ?? "");
  if (sender.id !== extension.host) throw new Error("Invalid launcher settings sender");

  if (
    documentUrl.protocol === extension.protocol &&
    documentUrl.host === extension.host &&
    documentUrl.pathname === "/options/index.html" &&
    (sender.frameId === undefined || sender.frameId === 0)
  )
    return;

  const tabUrl = new URL(sender.tab?.url ?? "");
  if (
    (documentUrl.protocol !== "http:" && documentUrl.protocol !== "https:") ||
    documentUrl.username ||
    documentUrl.password ||
    (tabUrl.protocol !== "http:" && tabUrl.protocol !== "https:") ||
    tabUrl.username ||
    tabUrl.password ||
    documentUrl.origin !== origin ||
    tabUrl.origin !== origin ||
    (sender.origin !== undefined && sender.origin !== origin) ||
    sender.frameId !== 0 ||
    !Number.isSafeInteger(sender.tab?.id) ||
    (sender.tab?.id ?? 0) <= 0
  ) {
    throw new Error("Content may only change launcher settings for its own HTTP(S) origin");
  }
}

function validatePatch(value: unknown): Partial<LauncherOverride> | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid launcher settings patch");
  }
  const patch: Partial<LauncherOverride> = {};
  const entries = Object.entries(value);
  if (entries.length === 0) throw new Error("Empty launcher settings patch");
  for (const [key, field] of entries) {
    if (key === "hidden" && typeof field === "boolean") patch.hidden = field;
    else if (key === "edge" && (field === "left" || field === "right")) patch.edge = field;
    else if (
      key === "yRatio" &&
      typeof field === "number" &&
      Number.isFinite(field) &&
      field >= 0 &&
      field <= 1
    ) {
      patch.yRatio = field;
    } else {
      throw new Error("Invalid launcher settings field");
    }
  }
  return patch;
}

export async function handleLauncherStateUpdate(
  message: UpdateLauncherStateRequest,
  sender: chrome.runtime.MessageSender,
): Promise<LauncherState> {
  if (
    !message ||
    typeof message !== "object" ||
    message.kind !== "update-launcher-state" ||
    typeof message.origin !== "string" ||
    (message.product !== "confluence" && message.product !== "jira")
  ) {
    throw new Error("Invalid launcher settings request");
  }
  const origin = new URL(message.origin);
  if (
    (origin.protocol !== "http:" && origin.protocol !== "https:") ||
    origin.username ||
    origin.password ||
    origin.origin !== message.origin
  ) {
    throw new Error("Launcher settings require a canonical HTTP(S) origin");
  }
  validateSender(origin.origin, sender);
  const key = launcherSiteKey(origin.origin, message.product);
  const patch = validatePatch(message.patch);

  const next = pendingWrite.then(async () => {
    const state = await loadLauncherState();
    if (patch === null) {
      delete state[key];
    } else {
      state[key] = { ...(state[key] ?? { hidden: false, ...DEFAULT_LAUNCHER_POSITION }), ...patch };
    }
    await storage.local.set({ [LAUNCHER_STORAGE_KEY]: state });
    return state;
  });
  pendingWrite = next.catch(() => {});
  return next;
}
