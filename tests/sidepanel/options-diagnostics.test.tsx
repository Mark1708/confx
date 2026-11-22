import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { BrowserApi } from "@/lib/browser/browser-api";
import { exportJobStorageKey, serializeJobState } from "@/lib/export-state";
import {
  collectSafeDiagnostics,
  DiagnosticsSettings,
} from "@/options/components/DiagnosticsSettings";
import type { ExportJobState } from "@/types";

vi.mock("@/sidepanel/hooks/useI18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const state: ExportJobState = {
  version: 2,
  id: "lorem-job",
  sourceKey: "7:confluence:https://wiki.example.test/wiki",
  owner: { instanceId: "lorem-owner", surface: "workspace", tabId: 31, windowId: 1 },
  request: { kind: "extract-page", destination: "directory", pageId: "100" },
  status: "failed",
  phase: "writing",
  message: "Lorem page title and detailed path",
  error: "Private diagnostic detail must not be copied",
  terminalReason: "writer-failure",
  result: { fileName: "lorem-page.zip", directoryName: "lorem-page-folder" },
  counts: {
    processed: 1,
    total: 2,
    successfulPages: 1,
    failedPages: 1,
    successfulResources: 0,
    failedResources: 0,
    entriesWritten: 1,
    bytesWritten: 8,
  },
  cancelRequested: false,
};

describe("explicit safe options diagnostics", () => {
  let container: HTMLDivElement;
  let root: Root;
  let get: Mock<(key: string) => Promise<Record<string, unknown>>>;
  let values: Record<string, unknown>;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    values = {
      "cx.export.active.v2": state.id,
      [exportJobStorageKey(state.id)]: serializeJobState(state),
    };
    get = vi.fn(async (key: string) => ({ [key]: values[key] }));
    vi.stubGlobal("chrome", {
      storage: { session: { get } },
      downloads: { download: vi.fn() },
      sidePanel: { open: vi.fn() },
    });
    vi.spyOn(BrowserApi, "getManifest").mockReturnValue({
      version: "0.3.0",
      manifest_version: 3,
      name: "Lorem extension",
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("projects only versions, API capabilities and safe terminal metadata from a real parsed snapshot", async () => {
    const report = await collectSafeDiagnostics();
    expect(report).toEqual({
      schema: 1,
      extension: { version: "0.3.0", manifestVersion: 3 },
      surface: "options",
      secureContext: globalThis.isSecureContext === true,
      capabilities: {
        directoryPicker: typeof Reflect.get(globalThis, "showDirectoryPicker") === "function",
        webLocks: typeof navigator.locks?.request === "function",
        downloads: true,
        sidePanel: true,
      },
      lastExport: { status: "failed", phase: "writing", reasonCode: "writer-failure" },
    });
    values[exportJobStorageKey(state.id)] = serializeJobState({
      ...state,
      terminalReason: "https://wiki.example.test/a-sensitive-path",
    });
    expect((await collectSafeDiagnostics()).lastExport).toEqual({
      status: "failed",
      phase: "writing",
      reasonCode: null,
    });
  });

  it("does not inspect export metadata or create a download until the user requests the report", async () => {
    const createUrl = vi.fn((_blob: Blob) => "blob:lorem-diagnostics");
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = createUrl;
        static revokeObjectURL = vi.fn();
      },
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await act(async () => root.render(<DiagnosticsSettings />));
    expect(get).not.toHaveBeenCalled();
    expect(createUrl).not.toHaveBeenCalled();
    const button = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === "options.diagnostics.export",
    )!;
    await act(async () => button.click());
    expect(click).toHaveBeenCalledTimes(1);
    const blob = createUrl.mock.calls[0][0];
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
    const json = await promise;
    const report = JSON.parse(json);
    expect(Object.keys(report)).toEqual([
      "schema",
      "extension",
      "surface",
      "secureContext",
      "capabilities",
      "lastExport",
    ]);
    expect(report.lastExport).toEqual({
      status: "failed",
      phase: "writing",
      reasonCode: "writer-failure",
    });
    expect(container.querySelector("pre")?.textContent).toBe(json);
  });
});
