var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
var _a, _b;
import { createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "../package.json";
var TARGET = ((_a = process.env.TARGET) !== null && _a !== void 0 ? _a : "chrome");
// ─── Yandex signing key ───────────────────────────────────────────
var YANDEX_KEY_PATH = path.resolve(process.cwd(), (_b = process.env.YANDEX_KEY_PATH) !== null && _b !== void 0 ? _b : "keys/yandex.pem");
function readYandexPublicKey() {
    if (!existsSync(YANDEX_KEY_PATH)) {
        throw new Error("Yandex signing key not found at ".concat(YANDEX_KEY_PATH, ". ") +
            "Run: openssl genrsa -out keys/yandex.pem 2048");
    }
    var pem = readFileSync(YANDEX_KEY_PATH, "utf-8");
    var publicKey = createPublicKey(createPrivateKey(pem));
    var der = publicKey.export({ format: "der", type: "spki" });
    return Buffer.from(der).toString("base64");
}
// ─── Shared permissions ───────────────────────────────────────────
var sharedPermissions = [
    "activeTab",
    "scripting",
    "storage",
    "downloads",
    "tabs",
    "sidePanel",
];
// ─── Base manifest (shared across all targets) ────────────────────
var baseManifest = {
    manifest_version: 3,
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
    permissions: __spreadArray([], sharedPermissions, true),
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
function targetName() {
    return TARGET === "yandex"
        ? "ConfX (Yandex)"
        : "ConfX";
}
function targetKey() {
    return TARGET === "yandex" ? { key: readYandexPublicKey() } : {};
}
/**
 * Yandex Browser lacks chrome.sidePanel API.
 * Chrome must not define default_popup because that disables action.onClicked
 * and conflicts with openPanelOnActionClick side panel behavior.
 */
function targetPopup() {
    return TARGET === "yandex" ? { default_popup: "src/sidepanel/index.html" } : {};
}
export default defineManifest(__assign(__assign(__assign({}, baseManifest), { name: targetName(), action: __assign(__assign({}, baseManifest.action), targetPopup()) }), targetKey()));
