/// <reference types="chrome" />

import { createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import pkg from "../package.json";

// ─── Target detection ─────────────────────────────────────────────

type Target = "chrome" | "yandex";
const TARGET = (process.env.TARGET ?? "chrome") as Target;

type ExtensionManifest = chrome.runtime.ManifestV3 & {
  side_panel?: {
    default_path: string;
  };
  key?: string;
};
type ExtensionManifestBase = Omit<ExtensionManifest, "name">;

// ─── Yandex signing key ───────────────────────────────────────────

const YANDEX_KEY_PATH = path.resolve(
  process.cwd(),
  process.env.YANDEX_KEY_PATH ?? "keys/yandex.pem",
);

function readYandexPublicKey(): string {
  if (!existsSync(YANDEX_KEY_PATH)) {
    throw new Error(
      `Yandex signing key not found at ${YANDEX_KEY_PATH}. ` +
        `Run: openssl genrsa -out keys/yandex.pem 2048`,
    );
  }
  const pem = readFileSync(YANDEX_KEY_PATH, "utf-8");
  const publicKey = createPublicKey(createPrivateKey(pem));
  const der = publicKey.export({ format: "der", type: "spki" });
  return Buffer.from(der).toString("base64");
}

// ─── Shared permissions ───────────────────────────────────────────

const sharedPermissions = [
  "activeTab",
  "scripting",
  "storage",
  "downloads",
  "tabs",
  "sidePanel",
] as const;

// ─── Base manifest (shared across all targets) ────────────────────

const baseManifest = {
  manifest_version: 3 as const,
  default_locale: "en",
  description: "__MSG_extensionDescription__",
  version: pkg.version,
  icons: {
    16: "assets/icon-16.png",
    32: "assets/icon-32.png",
    48: "assets/icon-48.png",
    128: "assets/icon-128.png",
  },
  action: {
    default_title: "__MSG_actionDefaultTitle__",
    default_icon: {
      16: "assets/icon-16.png",
      32: "assets/icon-32.png",
      48: "assets/icon-48.png",
    },
  },
  side_panel: {
    default_path: "sidepanel/index.html",
  },
  options_page: "options/index.html",
  background: {
    service_worker: "background/service-worker.js",
    type: "module" as const,
  },
  permissions: Array.from(sharedPermissions),
  host_permissions: ["https://*/*", "http://*/*"],
  content_scripts: [
    {
      matches: ["https://*/*", "http://*/*"],
      js: ["content-scripts/picker-entry.js"],
      run_at: "document_idle",
    },
  ],
  web_accessible_resources: [
    {
      resources: ["viewer/index.html", "sidepanel/index.html"],
      matches: ["<all_urls>"],
    },
  ],
} satisfies ExtensionManifestBase;

// ─── Merge + export ───────────────────────────────────────────────

function targetName(): string {
  return TARGET === "yandex" ? "__MSG_extensionNameYandex__" : "__MSG_extensionName__";
}

function targetKey(): Record<string, string> {
  return TARGET === "yandex" ? { key: readYandexPublicKey() } : {};
}

/**
 * Yandex Browser lacks chrome.sidePanel API.
 * Chrome must not define default_popup because that disables action.onClicked
 * and conflicts with openPanelOnActionClick side panel behavior.
 */
function targetPopup(): Record<string, string> {
  return TARGET === "yandex" ? { default_popup: "sidepanel/index.html" } : {};
}

export function generateManifest(): ExtensionManifest {
  return {
    ...baseManifest,
    ...targetKey(),
    name: targetName(),
    action: {
      ...baseManifest.action,
      ...targetPopup(),
    },
  };
}

export default generateManifest;
