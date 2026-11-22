/// <reference types="chrome" />

import { createHash } from "node:crypto";
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

// Public SPKI of the existing release identity; unsigned builds never need its private key.
const YANDEX_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsFrThb+WKfP0gecH69sIbeZDXwZsVCoQ4WI1iPlj4Ul5y/RGr1N3oJf/UHW14zzG5mcuR2mEL4yIDsFhIwNyKkxFUtjKG6jwdZjEbQ63Tlj/x5TGgV6QBD6f3MeH71tYuOlOxi8UCiM0E3cbBzgIKILl+38iQzH9Ibh/wNY0LfFgiS458Zx3o1qE8hUO9xIztr+y7O17Pm3faii44VF1fo1diOz5XhLO0my43gm3Oj+nD2AQmIGHjvNgIREC7jSdm8hRtQYPLPyKeSc90QZib27384l2j3VJqHOBa7pimIQXVUuMYpoD2BvRezWehPcZkJpqw7JK/Drovxb4i8pE7QIDAQAB";

// ─── Shared permissions ───────────────────────────────────────────

const sharedPermissions = [
  "activeTab",
  "scripting",
  "storage",
  "downloads",
  "tabs",
  "sidePanel",
  "offscreen",
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
      20: "assets/icon-20.png",
      24: "assets/icon-24.png",
      32: "assets/icon-32.png",
      40: "assets/icon-40.png",
      48: "assets/icon-48.png",
      64: "assets/icon-64.png",
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
  if (TARGET !== "yandex") return {};
  const expectedId = process.env.YANDEX_EXTENSION_ID;
  const actualId = createHash("sha256")
    .update(Buffer.from(YANDEX_PUBLIC_KEY, "base64"))
    .digest("hex")
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));
  if (expectedId && expectedId !== actualId) {
    throw new Error("Configured Yandex extension ID does not match the public release identity");
  }
  return { key: YANDEX_PUBLIC_KEY };
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
