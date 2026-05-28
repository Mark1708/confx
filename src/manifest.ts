import { createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "../package.json";

// ─── Target detection ─────────────────────────────────────────────

type Target = "chrome" | "yandex";
const TARGET = (process.env.TARGET ?? "chrome") as Target;

// ─── Yandex signing key ───────────────────────────────────────────

const YANDEX_KEY_PATH = path.resolve(process.cwd(), process.env.YANDEX_KEY_PATH ?? "keys/yandex.pem");

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
  description: "Exports Confluence and Jira content to Markdown, CSV, and ZIP archives",
  version: pkg.version,
  icons: {
    16: "src/assets/icon-16.png",
    32: "src/assets/icon-32.png",
    48: "src/assets/icon-48.png",
    128: "src/assets/icon-128.png",
  },
  action: {
    default_title: "ConfX",
    default_icon: {
      16: "src/assets/icon-16.png",
      32: "src/assets/icon-32.png",
      48: "src/assets/icon-48.png",
    },
  },
  side_panel: {
    default_path: "src/sidepanel/index.html",
  },
  options_page: "src/options/index.html",
  background: {
    service_worker: "src/background/service-worker.ts",
    type: "module",
  },
  permissions: [...sharedPermissions],
  host_permissions: ["https://*/*", "http://*/*"],
  content_scripts: [
    {
      matches: ["https://*/*", "http://*/*"],
      js: ["src/content/picker-entry.ts"],
      run_at: "document_idle",
    },
  ],
  web_accessible_resources: [
    {
      resources: [
        "src/content/picker.css",
        "src/content/confx-button.css",
        "src/viewer/index.html",
        "src/sidepanel/index.html",
      ],
      matches: ["<all_urls>"],
    },
  ],
};

// ─── Merge + export ───────────────────────────────────────────────

function targetName(): string {
  return TARGET === "yandex"
    ? "ConfX (Yandex)"
    : "ConfX";
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
  return TARGET === "yandex" ? { default_popup: "src/sidepanel/index.html" } : {};
}

export default defineManifest({
  ...baseManifest,
  name: targetName(),
  action: {
    ...baseManifest.action,
    ...targetPopup(),
  },
  ...targetKey(),
});
