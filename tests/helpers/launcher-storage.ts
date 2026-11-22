import { type Mock, vi } from "vitest";
import { handleLauncherStateUpdate } from "@/background/launcher-state";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import type { UpdateLauncherStateRequest, UpdateLauncherStateResponse } from "@/types";

type StorageListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void;

export interface LauncherTestStorage {
  sync: Record<string, unknown>;
  local: Record<string, unknown>;
  listeners: Set<StorageListener>;
  emit: (area: "local" | "sync", items: Record<string, unknown>) => void;
  localGet: Mock<() => Promise<Record<string, unknown>>>;
  localSet: Mock<(items: Record<string, unknown>) => Promise<void>>;
  syncGet: Mock<() => Promise<Record<string, unknown>>>;
  syncSet: Mock<(items: Record<string, unknown>) => Promise<void>>;
  runtimeSend: Mock<(message: UpdateLauncherStateRequest) => Promise<UpdateLauncherStateResponse>>;
}

export function installLauncherStorage(): LauncherTestStorage {
  const sync: Record<string, unknown> = {
    "cx.settings.v1": { ...structuredClone(DEFAULT_SETTINGS), locale: "en" },
  };
  const local: Record<string, unknown> = {};
  const listeners = new Set<StorageListener>();
  const emit = (area: "local" | "sync", items: Record<string, unknown>) => {
    const target = area === "local" ? local : sync;
    const changes = Object.fromEntries(
      Object.entries(items).map(([key, value]) => [
        key,
        { oldValue: target[key], newValue: structuredClone(value) },
      ]),
    );
    Object.assign(target, structuredClone(items));
    for (const listener of [...listeners]) listener(changes, area);
  };
  const localGet = vi.fn(async () => structuredClone(local));
  const localSet = vi.fn(async (items: Record<string, unknown>) => emit("local", items));
  const syncGet = vi.fn(async () => structuredClone(sync));
  const syncSet = vi.fn(async (items: Record<string, unknown>) => emit("sync", items));
  const runtimeSend = vi.fn(async (
    message: UpdateLauncherStateRequest,
  ): Promise<UpdateLauncherStateResponse> => {
    try {
      const state = await handleLauncherStateUpdate(message, {
        id: "lorem",
        url: "chrome-extension://lorem/options/index.html",
      });
      return { ok: true, state };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  });
  vi.stubGlobal("chrome", {
    runtime: {
      id: "lorem",
      getURL: (path: string) => `chrome-extension://lorem/${path}`,
      sendMessage: runtimeSend,
    },
    storage: {
      local: { get: localGet, set: localSet },
      sync: { get: syncGet, set: syncSet },
      onChanged: {
        addListener: (listener: StorageListener) => listeners.add(listener),
        removeListener: (listener: StorageListener) => listeners.delete(listener),
      },
    },
  });
  return { local, sync, listeners, emit, localGet, localSet, syncGet, syncSet, runtimeSend };
}
