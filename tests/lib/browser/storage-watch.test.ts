import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { watchStorageKey } from "@/lib/browser/storage-watch";

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
  listenerCount: () => number;
}

function installOnChangedMock(): OnChangedMock {
  const listeners: StorageChangeListener[] = [];

  const onChanged = {
    addListener: (listener: StorageChangeListener): void => {
      listeners.push(listener);
    },
    removeListener: (listener: StorageChangeListener): void => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    hasListener: (listener: StorageChangeListener): boolean => listeners.includes(listener),
  };

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: { storage: { onChanged } },
  });

  return {
    fire: (changes, areaName) => {
      // Iterate over a snapshot: listeners may unsubscribe during dispatch.
      for (const listener of [...listeners]) listener(changes, areaName);
    },
    listenerCount: () => listeners.length,
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

describe("watchStorageKey", () => {
  let mock: OnChangedMock;

  beforeEach(() => {
    mock = installOnChangedMock();
  });

  afterEach(() => {
    restoreChrome();
  });

  it("fires callback when matching area and matching key change", () => {
    const onChange = vi.fn();
    watchStorageKey("sync", "cx.settings.v1", onChange);

    mock.fire({ "cx.settings.v1": { newValue: { theme: "dark" } } }, "sync");

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("does not fire when area matches but key does not", () => {
    const onChange = vi.fn();
    watchStorageKey("sync", "cx.settings.v1", onChange);

    mock.fire({ "other.key": { newValue: 1 } }, "sync");

    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not fire when key matches but area does not", () => {
    const onChange = vi.fn();
    watchStorageKey("sync", "cx.settings.v1", onChange);

    mock.fire({ "cx.settings.v1": { newValue: 1 } }, "local");

    expect(onChange).not.toHaveBeenCalled();
  });

  it("unsubscribe removes the listener", () => {
    const onChange = vi.fn();
    const unsub = watchStorageKey("sync", "cx.settings.v1", onChange);

    unsub();
    mock.fire({ "cx.settings.v1": { newValue: 1 } }, "sync");

    expect(onChange).not.toHaveBeenCalled();
  });

  it("two independent subscriptions do not interfere", () => {
    const onChange1 = vi.fn();
    const onChange2 = vi.fn();
    const unsub1 = watchStorageKey("sync", "key1", onChange1);
    watchStorageKey("local", "key2", onChange2);

    expect(mock.listenerCount()).toBe(2);

    mock.fire({ key1: { newValue: 1 } }, "sync");
    expect(onChange1).toHaveBeenCalledTimes(1);
    expect(onChange2).not.toHaveBeenCalled();

    unsub1();
    expect(mock.listenerCount()).toBe(1);

    mock.fire({ key1: { newValue: 2 } }, "sync");
    expect(onChange1).toHaveBeenCalledTimes(1);
  });
});
