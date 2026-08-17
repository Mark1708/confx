import type { QueryClient } from "@tanstack/react-query";

import { watchStorageKey } from "@/lib/browser";

/**
 * Bridge chrome.storage.onChanged events for `cx.settings.v1` (sync) and
 * `cx.subscriptions.v1` (local) to TanStack Query cache invalidation.
 *
 * MUST be called at module scope (not inside a React component or useEffect):
 * both surfaces render under <React.StrictMode>, which double-mounts effects
 * and would double-register listeners.
 *
 * Returns an aggregate unsubscribe. Chrome MV3 fires storage.onChanged in every
 * extension context INCLUDING the source; the originating surface will perform
 * one redundant refetch after its own mutation. This is accepted.
 */
export function setupStorageSync(qc: QueryClient): () => void {
  const unsubs = [
    watchStorageKey("sync", "cx.settings.v1", () =>
      qc.invalidateQueries({ queryKey: ["settings"] }),
    ),
    watchStorageKey("local", "cx.subscriptions.v1", () =>
      qc.invalidateQueries({ queryKey: ["subscriptions"] }),
    ),
  ];

  return () => {
    for (const unsub of unsubs) unsub();
  };
}
