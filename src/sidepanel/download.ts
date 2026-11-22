import { BrowserApi } from "@/lib/browser/browser-api";

interface DownloadTerminal {
  state: "complete" | "interrupted";
  error?: string;
}

export type ExportDownloader = (
  blob: Blob,
  fileName: string,
  signal: AbortSignal,
) => Promise<number>;

export async function downloadBlob(
  blob: Blob,
  fileName: string,
  signal?: AbortSignal,
): Promise<number> {
  signal?.throwIfAborted();
  const url = URL.createObjectURL(blob);
  let unsubscribe: (() => void) | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<number>((resolve, reject) => {
      let id: number | undefined;
      let settled = false;
      let aborted = false;
      let cancelling = false;
      let cancelAttempted = false;
      let cancelled = false;
      let cancelError: unknown;
      let terminal: DownloadTerminal | undefined;
      const earlyTerminals = new Map<number, DownloadTerminal>();

      const settle = (): void => {
        if (settled || cancelling || id === undefined) return;
        if (aborted && cancelled) {
          settled = true;
          reject(new DOMException("Download cancelled", "AbortError"));
        } else if (terminal) {
          settled = true;
          if (cancelError) reject(cancelError);
          else if (aborted) reject(new DOMException("Download cancelled", "AbortError"));
          else if (terminal.error === "USER_CANCELED")
            reject(new DOMException("Download cancelled", "AbortError"));
          else if (terminal.state === "complete") resolve(id);
          else
            reject(new Error(`Download interrupted${terminal.error ? `: ${terminal.error}` : ""}`));
        }
      };

      const readTerminal = (item: chrome.downloads.DownloadItem | undefined): void => {
        if (settled || !item || item.id !== id) return;
        if (!terminal && (item.state === "complete" || item.state === "interrupted")) {
          terminal = { state: item.state, ...(item.error ? { error: item.error } : {}) };
        }
        settle();
      };

      const checkTerminalState = async (): Promise<void> => {
        if (id === undefined) return;
        try {
          const items = await BrowserApi.searchDownloads({ id });
          readTerminal(items[0]);
        } catch {
          // Search is race closure, not proof of completion. The subscribed
          // terminal event remains authoritative if the search is unavailable.
          settle();
        }
      };

      const cancel = async (): Promise<void> => {
        if (id === undefined || cancelAttempted || settled) return;
        cancelAttempted = true;
        cancelling = true;
        try {
          await BrowserApi.cancelDownload(id);
          cancelled = true;
        } catch (error: unknown) {
          cancelError = error;
          // A failed cancel is not proof of termination. Keep observing until
          // search or an event establishes the browser's actual terminal state.
          void checkTerminalState();
        } finally {
          cancelling = false;
          settle();
        }
      };

      unsubscribe = BrowserApi.onDownloadChanged((delta) => {
        const state = delta.state?.current;
        if (state !== "complete" && state !== "interrupted") return;
        const update: DownloadTerminal = {
          state,
          ...(delta.error?.current ? { error: delta.error.current } : {}),
        };
        if (id === undefined) earlyTerminals.set(delta.id, update);
        else if (delta.id === id) {
          terminal = update;
          settle();
        }
      });
      onAbort = () => {
        aborted = true;
        void cancel();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        settled = true;
        reject(new DOMException("Download cancelled", "AbortError"));
        return;
      }

      void BrowserApi.download({ url, filename: fileName, saveAs: true }).then(
        (downloadId) => {
          id = downloadId;
          terminal = earlyTerminals.get(downloadId);
          earlyTerminals.clear();
          if (aborted) void cancel();
          settle();
          // Subscribe-before-handoff plus this search closes both possible
          // event races without polling or retaining the URL on a timer.
          void checkTerminalState();
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          reject(aborted ? new DOMException("Download cancelled", "AbortError") : error);
        },
      );
    });
  } finally {
    try {
      unsubscribe?.();
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      URL.revokeObjectURL(url);
    }
  }
}
