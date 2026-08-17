/// <reference types="chrome" />

export type StorageArea = "sync" | "local";

/**
 * Subscribe to chrome.storage.onChanged events for a specific area and key.
 * Returns an unsubscribe function. Idempotent: each call registers its own
 * listener; callers own their lifecycle.
 */
export function watchStorageKey(area: StorageArea, key: string, onChange: () => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== area) return;
    if (!(key in changes)) return;
    onChange();
  };

  chrome.storage.onChanged.addListener(listener);
  return () => {
    chrome.storage.onChanged.removeListener(listener);
  };
}
