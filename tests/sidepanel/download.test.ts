import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const browser = vi.hoisted(() => ({
  download: vi.fn<(options: chrome.downloads.DownloadOptions) => Promise<number>>(),
  searchDownloads:
    vi.fn<(query: chrome.downloads.DownloadQuery) => Promise<chrome.downloads.DownloadItem[]>>(),
  cancelDownload: vi.fn<(id: number) => Promise<void>>(),
  onDownloadChanged:
    vi.fn<(handler: (delta: chrome.downloads.DownloadDelta) => void) => () => void>(),
}));
vi.mock("@/lib/browser/browser-api", () => ({ BrowserApi: browser }));

import { downloadBlob } from "@/sidepanel/download";

const listeners = new Set<(delta: chrome.downloads.DownloadDelta) => void>();
let createUrl: Mock<() => string>;
let revokeUrl: Mock<() => void>;

function event(state: "complete" | "interrupted", error?: string) {
  for (const listener of listeners)
    listener({
      id: 71,
      state: { current: state },
      ...(error ? { error: { current: error } } : {}),
    });
}

function observe(completion: Promise<number>) {
  return completion.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const method of Object.values(browser)) method.mockReset();
  listeners.clear();
  browser.onDownloadChanged.mockImplementation((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  browser.download.mockResolvedValue(71);
  browser.searchDownloads.mockResolvedValue([
    { id: 71, state: "in_progress" } as chrome.downloads.DownloadItem,
  ]);
  browser.cancelDownload.mockImplementation(async () => {
    event("interrupted", "USER_CANCELED");
  });
  createUrl = vi.fn(() => "blob:export-1");
  revokeUrl = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = createUrl;
      static revokeObjectURL = revokeUrl;
    },
  );
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("download completion and cancellation", () => {
  it("does not resolve or release the URL on handoff; waits for Chrome completion", async () => {
    const searched = Promise.withResolvers<void>();
    browser.searchDownloads.mockImplementation(async () => {
      searched.resolve();
      return [{ id: 71, state: "in_progress" } as chrome.downloads.DownloadItem];
    });
    let settled = false;
    const completion = observe(
      downloadBlob(new Blob(["zip"]), "lorem.zip").finally(() => {
        settled = true;
      }),
    );
    try {
      await Promise.race([searched.promise, completion]);
      expect(settled).toBe(false);
      expect(listeners.size).toBe(1);
      expect(revokeUrl).not.toHaveBeenCalled();
      expect(browser.download.mock.calls[0][0]).toMatchObject({
        filename: "lorem.zip",
        saveAs: true,
      });
    } finally {
      event("complete");
      await completion;
    }
    await expect(completion).resolves.toEqual({ ok: true, value: 71 });
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:export-1");
    expect(listeners.size).toBe(0);
  });

  it("captures completion before download returns its ID even if search is already stale", async () => {
    browser.download.mockImplementation(async () => {
      event("complete");
      return 71;
    });
    await expect(downloadBlob(new Blob(["zip"]), "lorem.zip")).resolves.toBe(71);
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:export-1");
    expect(listeners.size).toBe(0);
  });

  it("releases resources on a terminal event while the race-closing search is still pending", async () => {
    const search = Promise.withResolvers<chrome.downloads.DownloadItem[]>();
    const entered = Promise.withResolvers<void>();
    browser.searchDownloads.mockImplementation(() => {
      entered.resolve();
      return search.promise;
    });
    const completion = observe(downloadBlob(new Blob(["zip"]), "lorem.zip"));
    try {
      await Promise.race([entered.promise, completion]);
      event("complete");
      await expect(completion).resolves.toEqual({ ok: true, value: 71 });
      expect(revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:export-1");
      expect(listeners.size).toBe(0);
    } finally {
      event("complete");
      if (browser.searchDownloads.mock.calls.length > 0)
        search.reject(new Error("late search failure"));
      else search.resolve([]);
      await completion;
    }
  });

  it("cancels a late ID after abort and keeps resources alive until cancellation cleanup", async () => {
    const handoff = Promise.withResolvers<number>();
    const cancelling = Promise.withResolvers<void>();
    const cancelDone = Promise.withResolvers<void>();
    browser.download.mockReturnValue(handoff.promise);
    browser.cancelDownload.mockImplementation(async () => {
      cancelling.resolve();
      await cancelDone.promise;
      event("interrupted", "USER_CANCELED");
    });
    const abort = new AbortController();
    const completion = observe(downloadBlob(new Blob(["zip"]), "lorem.zip", abort.signal));
    try {
      abort.abort();
      expect(browser.cancelDownload).not.toHaveBeenCalled();
      expect(revokeUrl).not.toHaveBeenCalled();
      handoff.resolve(71);
      await Promise.race([cancelling.promise, completion]);
      expect(browser.cancelDownload).toHaveBeenCalledWith(71);
      expect(revokeUrl).not.toHaveBeenCalled();
    } finally {
      handoff.resolve(71);
      cancelDone.resolve();
      await completion;
    }
    await expect(completion).resolves.toMatchObject({ ok: false, error: { name: "AbortError" } });
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:export-1");
    expect(listeners.size).toBe(0);
  });

  it("reports browser interruption instead of a successful saved archive", async () => {
    const searched = Promise.withResolvers<void>();
    browser.searchDownloads.mockImplementation(async () => {
      searched.resolve();
      return [{ id: 71, state: "in_progress" } as chrome.downloads.DownloadItem];
    });
    const completion = observe(downloadBlob(new Blob(["zip"]), "lorem.zip"));
    try {
      await Promise.race([searched.promise, completion]);
    } finally {
      event("interrupted", "NETWORK_FAILED");
      await completion;
    }
    const result = await completion;
    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("NETWORK_FAILED") },
    });
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:export-1");
    expect(listeners.size).toBe(0);
  });

  it("cleans up a rejected Save dialog without timers or a leaked subscription", async () => {
    browser.download.mockRejectedValue(new Error("Save dialog cancelled"));
    await expect(downloadBlob(new Blob(["zip"]), "lorem.zip")).rejects.toThrow(
      "Save dialog cancelled",
    );
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:export-1");
    expect(listeners.size).toBe(0);
  });

  it("does not hand off a download or allocate a URL after cancellation", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(downloadBlob(new Blob(["zip"]), "lorem.zip", abort.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(browser.download).not.toHaveBeenCalled();
    expect(createUrl).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });
});
