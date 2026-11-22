import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { launcherSiteKey, LAUNCHER_STORAGE_KEY, loadLauncherState } from "@/lib/launcher-state";
import { loadSettings } from "@/lib/settings";
import { LauncherSettings } from "@/options/components/LauncherSettings";
import { installLauncherStorage, type LauncherTestStorage } from "../helpers/launcher-storage";

const origin = "https://wiki.example.com";
const siteKey = launcherSiteKey(origin, "confluence");

describe("launcher options", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  let memory: LauncherTestStorage;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    // Keep query notifications within act's microtask queue instead of racing zero-delay timers.
    notifyManager.setScheduler(queueMicrotask);
    memory = installLauncherStorage();
    memory.local[LAUNCHER_STORAGE_KEY] = {
      [siteKey]: { hidden: true, edge: "left", yRatio: 0.25 },
    };
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    notifyManager.setScheduler((callback) => { setTimeout(callback, 0); });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function renderSettings() {
    await act(async () => {
      root.render(<QueryClientProvider client={client}><LauncherSettings /></QueryClientProvider>);
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(container.querySelectorAll('[role="switch"]')).toHaveLength(2);
      expect(container.querySelector('[data-launcher-site]')).not.toBeNull();
    });
  }

  it("restores a hidden site without moving it, resets its override, and reacts to another surface", async () => {
    await renderSettings();
    const group = container.querySelector('[data-launcher-site]')!;
    const actions = group.querySelectorAll<HTMLButtonElement>("button");
    await act(async () => { actions[0].click(); });
    expect((await loadLauncherState())[siteKey]).toEqual({ hidden: false, edge: "left", yRatio: 0.25 });
    await act(async () => { actions[1].click(); });
    expect((await loadLauncherState())[siteKey]).toBeUndefined();
    expect(container.querySelector('[data-launcher-site]')).toBeNull();
    await act(async () => {
      memory.emit("local", { [LAUNCHER_STORAGE_KEY]: { [launcherSiteKey(origin, "jira")]: { hidden: true, edge: "right", yRatio: 0.7 } } });
    });
    expect(container.querySelectorAll('[data-launcher-site]')).toHaveLength(1);
    expect(memory.syncSet).not.toHaveBeenCalled();
  });

  it("updates global visibility in settings without sending site metadata to sync", async () => {
    await renderSettings();
    const switches = container.querySelectorAll<HTMLButtonElement>('[role="switch"]');
    await act(async () => { switches[0].click(); });
    expect((await loadSettings()).showConfluenceButton).toBe(false);
    expect(JSON.stringify(memory.sync)).not.toContain(origin);
    expect((await loadLauncherState())[siteKey].hidden).toBe(true);
    await act(async () => {
      memory.emit("sync", { "cx.settings.v1": { ...(memory.sync["cx.settings.v1"] as object), showJiraButton: false } });
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(switches[1].getAttribute("aria-checked")).toBe("false");
    });
  });

  it("keeps the previous override and exposes a failure when storage rejects a restore", async () => {
    await renderSettings();
    memory.localSet.mockRejectedValueOnce(new Error("storage unavailable"));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-launcher-site] button')!.click();
    });
    expect((await loadLauncherState())[siteKey].hidden).toBe(true);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it.each(["resolves", "rejects"] as const)("shows a newly hidden site when the initial outdated read %s after a notification", async (outcome) => {
    const loading = Promise.withResolvers<Record<string, unknown>>();
    memory.localGet.mockReturnValueOnce(loading.promise);
    await act(async () => {
      root.render(<QueryClientProvider client={client}><LauncherSettings /></QueryClientProvider>);
    });
    await act(async () => {
      memory.emit("local", {
        [LAUNCHER_STORAGE_KEY]: { [siteKey]: { hidden: true, edge: "left", yRatio: 0.25 } },
      });
      if (outcome === "resolves") loading.resolve({ [LAUNCHER_STORAGE_KEY]: {} });
      else loading.reject(new Error("Outdated read failed"));
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      const restore = container.querySelector<HTMLButtonElement>('[data-launcher-site] button');
      expect(restore).not.toBeNull();
      expect(restore!.disabled).toBe(false);
    });
  });
});
