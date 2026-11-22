import { setTimeout as pause } from "node:timers/promises";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyRules } from "@/lib/rule-engine";
import { loadSettings, migrateSettings } from "@/lib/settings";
import { OptionsApp } from "@/options/OptionsApp";
import type { ExtractionRule } from "@/types";

const memory = {
  sync: {} as Record<string, unknown>,
  onSave: undefined as (() => void) | undefined,
};

type StorageChangeListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void;

const baseRule: ExtractionRule = {
  id: "lorem-base",
  name: "Lorem selected table",
  type: "table",
  matcher: "table.lorem-export",
  action: "to-csv",
  enabled: true,
};
const customRule: ExtractionRule = {
  id: "lorem-custom",
  name: "Exclude private section",
  type: "selector",
  matcher: ".lorem-private",
  action: "skip",
  enabled: true,
};

interface RulesFile {
  version: number;
  preset: { id: string; rules: ExtractionRule[] };
  customRules: ExtractionRule[];
}

function blobText(blob: Blob): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error);
  reader.readAsText(blob);
  return promise;
}

const html = `<section class="lorem-private"><p>Private Lorem</p></section>
  <p>Public Lorem</p>
  <table class="lorem-export"><tr><th>Name</th><th>Value</th></tr><tr><td>Ipsum</td><td>42</td></tr></table>
  <table><tr><th>Other</th></tr><tr><td>Retained table</td></tr></table>`;

function expectExecutableRules(rules: ExtractionRule[]) {
  const result = applyRules(html, rules);
  const doc = new DOMParser().parseFromString(result.mainHtml, "text/html");
  expect(doc.querySelector(".lorem-private")).toBeNull();
  expect(doc.body.textContent).toContain("Public Lorem");
  expect(doc.querySelectorAll("table")).toHaveLength(2);
  expect(result.tables).toHaveLength(1);
  expect(result.tables[0].csv).toContain("Ipsum,42");
}

describe("Options rules file roundtrip", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.stubGlobal("matchMedia", (media: string) =>
      Object.assign(new EventTarget(), { matches: false, media }),
    );
    memory.sync = {
      "cx.settings.v1": migrateSettings({ version: 4, locale: "en", customRules: [] }),
    };
    memory.onSave = undefined;
    const listeners = new Set<StorageChangeListener>();
    vi.stubGlobal("chrome", {
      storage: {
        sync: {
          get: async () => structuredClone(memory.sync),
          set: async (items: Record<string, unknown>) => {
            const changes: Record<string, chrome.storage.StorageChange> = {};
            for (const [key, value] of Object.entries(items)) {
              changes[key] = {
                oldValue: memory.sync[key],
                newValue: structuredClone(value),
              };
            }
            Object.assign(memory.sync, structuredClone(items));
            for (const listener of listeners) listener(changes, "sync");
            memory.onSave?.();
          },
        },
        onChanged: {
          addListener: (listener: StorageChangeListener) => listeners.add(listener),
          removeListener: (listener: StorageChangeListener) => listeners.delete(listener),
        },
      },
    });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("persists and re-exports imported executable rules without substituting or adding template rules", async () => {
    let exported: Blob | undefined;
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL(blob: Blob) {
          exported = blob;
          return "blob:lorem-rules";
        }
        static revokeObjectURL() {}
      },
    );
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.spyOn(window, "alert").mockImplementation(() => {});
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <OptionsApp />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(async () => {
      await act(async () => {
        await pause(0);
      });
      expect(container.querySelector('input[type="file"]')).not.toBeNull();
    });

    const saved = Promise.withResolvers<void>();
    memory.onSave = saved.resolve;
    const file = new File(
      [
        JSON.stringify({
          version: 1,
          preset: { id: "md-attachments", name: "Lorem", description: "Lorem", rules: [baseRule] },
          customRules: [customRule],
        }),
      ],
      "rules.json",
      { type: "application/json" },
    );
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await saved.promise;
      await pause(0);
    });

    const settings = await loadSettings();
    expectExecutableRules([
      ...settings.exportDefaults.conversion.presetRules,
      ...settings.customRules,
    ]);
    const button = [...container.querySelectorAll("button")].find(
      (element) => element.textContent === "Export rules",
    )!;
    await act(async () => button.click());
    expect(exported).toBeDefined();
    const payload = JSON.parse(await blobText(exported!)) as RulesFile;
    expect(payload.version).toBe(1);
    expect(payload.preset.id).toBe("md-attachments");
    expectExecutableRules([...payload.preset.rules, ...payload.customRules]);
  });
});
