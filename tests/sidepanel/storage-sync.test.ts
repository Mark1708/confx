import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setupStorageSync } from "@/sidepanel/storage-sync";

const originalChrome = globalThis.chrome;

type StorageChangeListener = (
  changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
  areaName: string,
) => void;

interface OnChangedMock {
  fire: (
    changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
    areaName: string,
  ) => void;
}

function installOnChangedMock(): OnChangedMock {
  const listeners: StorageChangeListener[] = [];

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        onChanged: {
          addListener: (listener: StorageChangeListener): void => {
            listeners.push(listener);
          },
          removeListener: (listener: StorageChangeListener): void => {
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
          },
        },
      },
    },
  });

  return {
    fire: (changes, areaName) => {
      for (const listener of [...listeners]) listener(changes, areaName);
    },
  };
}

function restoreChrome(): void {
  if (originalChrome === undefined) {
    Reflect.deleteProperty(globalThis, "chrome");
    return;
  }
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: originalChrome,
  });
}

describe("setupStorageSync", () => {
  let qc: QueryClient;
  let mock: OnChangedMock;

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    mock = installOnChangedMock();
  });

  afterEach(() => {
    restoreChrome();
  });

  it("invalidates [settings] when cx.settings.v1 changes in sync area", () => {
    const spy = vi.spyOn(qc, "invalidateQueries");
    setupStorageSync(qc);

    mock.fire({ "cx.settings.v1": { newValue: { theme: "light" } } }, "sync");

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ queryKey: ["settings"] });
  });

  it("invalidates [subscriptions] when cx.subscriptions.v1 changes in local area", () => {
    const spy = vi.spyOn(qc, "invalidateQueries");
    setupStorageSync(qc);

    mock.fire({ "cx.subscriptions.v1": { newValue: {} } }, "local");

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ queryKey: ["subscriptions"] });
  });

  it("does not invalidate on unrelated storage keys", () => {
    const spy = vi.spyOn(qc, "invalidateQueries");
    setupStorageSync(qc);

    mock.fire({ "cx:pickerResult": { newValue: {} } }, "session");
    mock.fire({ "cx.tree-cache.v1:host": { newValue: {} } }, "local");
    mock.fire({ "cx.unknown.v1": { newValue: {} } }, "sync");

    expect(spy).not.toHaveBeenCalled();
  });

  it("aggregate unsubscribe removes all listeners", () => {
    const spy = vi.spyOn(qc, "invalidateQueries");
    const unsub = setupStorageSync(qc);

    unsub();

    mock.fire({ "cx.settings.v1": { newValue: {} } }, "sync");
    mock.fire({ "cx.subscriptions.v1": { newValue: {} } }, "local");

    expect(spy).not.toHaveBeenCalled();
  });

  // E1: source-context assertion. Chrome MV3 fires storage.onChanged in every
  // extension context INCLUDING the source. This documents the accepted cost
  // of one redundant invalidate in the originating surface after a mutation.
  // The bridge calls invalidate exactly once per storage event, regardless of
  // which context triggered it.
  it("E1: fires invalidate exactly once when invoked from source context", () => {
    const spy = vi.spyOn(qc, "invalidateQueries");
    setupStorageSync(qc);

    // Simulating chrome firing the event in the source context: same listener,
    // same dispatch path. Exactly one invalidate fires — accepted cost.
    mock.fire({ "cx.settings.v1": { newValue: {} } }, "sync");

    expect(spy).toHaveBeenCalledTimes(1);
  });

  // E2: invalidate forces refetch despite staleTime: Infinity. Locks in the
  // contract that the bridge's invalidateQueries actually bypasses staleTime,
  // which is what makes this approach viable for useSettings (staleTime:
  // Infinity) — the hook will refetch on invalidate, not stay frozen.
  it("E2: invalidateQueries forces refetch bypassing staleTime: Infinity", async () => {
    const queryFn = vi.fn().mockResolvedValue({ theme: "dark" });

    await qc.prefetchQuery({
      queryKey: ["settings"],
      queryFn,
      staleTime: Infinity,
    });
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(qc.getQueryState(["settings"])?.isInvalidated).toBe(false);

    // Without invalidate, a second prefetch with staleTime: Infinity is a no-op
    // because the cache is fresh.
    await qc.prefetchQuery({
      queryKey: ["settings"],
      queryFn,
      staleTime: Infinity,
    });
    expect(queryFn).toHaveBeenCalledTimes(1);

    // After the bridge-driven invalidate, the query is marked invalidated/stale.
    qc.invalidateQueries({ queryKey: ["settings"] });
    expect(qc.getQueryState(["settings"])?.isInvalidated).toBe(true);

    // Next prefetch refetches despite staleTime: Infinity because isStale is
    // now true (driven by isInvalidated).
    await qc.prefetchQuery({
      queryKey: ["settings"],
      queryFn,
      staleTime: Infinity,
    });
    expect(queryFn).toHaveBeenCalledTimes(2);
  });
});
