import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startToolbarIcon } from "@/background/toolbar-icon";
import type { ResolvedTheme } from "@/lib/appearance";
import { startToolbarThemeReporter } from "@/lib/browser/toolbar-theme";
import { loadSettings, saveSettings } from "@/lib/settings";
import type { AppSettings, ThemePalette } from "@/types";
import { installLauncherStorage } from "../helpers/launcher-storage";

const key = "cx.settings.v1";
const root = "chrome-extension://lorem/";
const observerUrl = `${root}offscreen/icon-theme.html`;
const query = { type: "icon-system-theme-query", target: "icon-theme-observer" };
const uiSender = { id: "lorem", url: `${root}options/index.html`, frameId: 0 };
const webSender = {
  id: "lorem",
  url: "https://wiki.example.com/page",
  frameId: 0,
  tab: { id: 7, url: "https://wiki.example.com/page" } as chrome.tabs.Tab,
};
const changed = (theme: ResolvedTheme) => ({
  type: "icon-system-theme-changed",
  target: "toolbar-icon",
  theme,
});
type Listener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  respond: (value: unknown) => void,
) => boolean | void;
const disposals: Array<() => void> = [];
const flush = () => vi.runAllTimersAsync();

function icon(theme: ResolvedTheme, palette: ThemePalette) {
  return {
    path: Object.fromEntries(
      [16, 20, 24, 32, 40, 48, 64].map((size) => [
        size,
        `${root}assets/icons/${theme}-${palette}-${size}.png`,
      ]),
    ),
  };
}

function browser() {
  const memory = installLauncherStorage();
  const messages = new Set<Listener>();
  const documents = new Set<string>();
  const applied: chrome.action.TabIconDetails[] = [];
  const setIcon = vi.fn(async (details: chrome.action.TabIconDetails) => {
    applied.push(structuredClone(details));
  });
  const getContexts = vi.fn(async () =>
    [...documents].map((documentUrl) => ({ contextType: "OFFSCREEN_DOCUMENT", documentUrl })),
  );
  const createDocument = vi.fn(async (options: chrome.offscreen.CreateParameters) => {
    if (documents.size) throw new Error("Only one offscreen document is allowed");
    documents.add(new URL(options.url, root).href);
  });
  const closeDocument = vi.fn(async () => {
    documents.clear();
  });
  const sendMessage = vi.fn(async (message: unknown): Promise<unknown> => {
    expect(message).toEqual(query);
    expect(documents.has(observerUrl)).toBe(true);
    return { theme: "light" };
  });
  Object.assign(chrome.runtime, {
    ContextType: { OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" },
    getContexts,
    sendMessage,
    onMessage: {
      addListener: (listener: Listener) => messages.add(listener),
      removeListener: (listener: Listener) => messages.delete(listener),
    },
  });
  Object.assign(chrome, {
    action: { setIcon },
    offscreen: {
      Reason: { MATCH_MEDIA: "MATCH_MEDIA" },
      createDocument,
      closeDocument,
    },
  });
  return {
    memory,
    messages,
    documents,
    applied,
    setIcon,
    getContexts,
    createDocument,
    closeDocument,
    sendMessage,
    update(patch: Partial<AppSettings>) {
      memory.emit("sync", { [key]: { ...(memory.sync[key] as AppSettings), ...patch } });
    },
    dispatch(message: unknown, sender: chrome.runtime.MessageSender = uiSender) {
      const responses: unknown[] = [];
      for (const listener of messages) listener(message, sender, (value) => responses.push(value));
      return responses;
    },
  };
}
function start() {
  const stop = startToolbarIcon();
  disposals.push(stop);
  return stop;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  for (const stop of disposals.splice(0)) stop();
  window.dispatchEvent(new Event("pagehide"));
  await flush();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("toolbar icon preferences and real API boundaries", () => {
  it("resolves every native size from the extension root, not the nested worker directory", async () => {
    const b = browser();
    start();
    await flush();
    expect(b.applied).toEqual([icon("dark", "violet")]);
    for (const [size, path] of Object.entries(b.applied[0].path as Record<string, string>)) {
      expect(new URL(path, `${root}background/service-worker.js`).href).toBe(
        `${root}assets/icons/dark-violet-${size}.png`,
      );
    }
    expect(b.documents.size).toBe(0);
  });
  it("preserves persisted settings while all explicit modes and palettes change globally", async () => {
    const b = browser();
    b.memory.sync[key] = {
      version: 5,
      theme: "light",
      palette: "invalid",
      future: { retained: true },
    };
    start();
    await flush();
    expect(b.applied.at(-1)).toEqual(icon("light", "violet"));
    expect(b.memory.syncSet).not.toHaveBeenCalled();
    for (const theme of ["dark", "light"] as const)
      for (const palette of ["violet", "blue", "forest", "graphite", "amber"] as const) {
        await saveSettings({ theme, palette });
        await flush();
        expect(b.applied.at(-1)).toEqual(icon(theme, palette));
        expect(b.applied.at(-1)).not.toHaveProperty("tabId");
        expect((await loadSettings()) as unknown).toMatchObject({ future: { retained: true } });
      }
    expect(b.createDocument).not.toHaveBeenCalled();
  });
  it("does not reapply colors for unrelated settings writes", async () => {
    const b = browser();
    start();
    await flush();
    b.update({ fontSize: 22, locale: "ru" });
    await flush();
    expect(b.applied).toEqual([icon("dark", "violet")]);
  });
  it("samples System once and closes the invisible document before applying the icon", async () => {
    const b = browser();
    b.update({ theme: "system", palette: "blue" });
    b.setIcon.mockImplementation(async (details) => {
      expect(b.documents.size).toBe(0);
      b.applied.push(details);
    });
    start();
    await flush();
    expect(b.applied).toEqual([icon("light", "blue")]);
    expect(b.documents.size).toBe(0);
    b.dispatch(changed("dark"), webSender);
    await flush();
    expect(b.applied.at(-1)).toEqual(icon("dark", "blue"));
    expect(b.createDocument).toHaveBeenCalledTimes(1);
    expect((await loadSettings()).theme).toBe("system");
    expect(b.memory.syncSet).not.toHaveBeenCalled();
  });
  it("reuses an existing owned snapshot document but closes it afterward", async () => {
    const b = browser();
    b.update({ theme: "system" });
    b.documents.add(observerUrl);
    start();
    await flush();
    expect(b.createDocument).not.toHaveBeenCalled();
    expect(b.documents.size).toBe(0);
    expect(b.applied).toEqual([icon("light", "violet")]);
  });
  it("accepts a visible-page report arriving during the previous explicit-mode read", async () => {
    const b = browser();
    const read = Promise.withResolvers<Record<string, unknown>>();
    b.memory.syncGet.mockReturnValueOnce(read.promise);
    start();
    b.update({ theme: "system", palette: "forest" });
    b.dispatch(changed("dark"), webSender);
    read.resolve({ [key]: { theme: "light", palette: "amber" } });
    await flush();
    expect(b.applied).toEqual([icon("dark", "forest")]);
    expect(b.createDocument).not.toHaveBeenCalled();
  });
  it("ignores OS notifications when the actually saved mode is explicit", async () => {
    const b = browser();
    start();
    await flush();
    b.dispatch(changed("light"), webSender);
    await flush();
    expect(b.applied).toEqual([icon("dark", "violet")]);
    expect((await loadSettings()).theme).toBe("dark");
  });
  it.each([
    { id: "foreign", url: `${root}options/index.html` },
    { id: "lorem", url: `${root}offscreen/icon-theme.html` },
    { ...webSender, frameId: 1 },
    { ...webSender, url: "https://other.example.com/" },
    { id: "lorem", url: "https://wiki.example.com/page" },
  ])("rejects a forged, hidden-reader, iframe or unauthorised sender %#", async (sender) => {
    const b = browser();
    b.update({ theme: "system" });
    start();
    await flush();
    b.dispatch(changed("dark"), sender);
    await flush();
    expect(b.applied).toEqual([icon("light", "violet")]);
  });
  it.each([{}, { ...changed("dark"), theme: "system" }, { ...changed("dark"), target: "other" }])(
    "rejects malformed media data %#",
    async (message) => {
      const b = browser();
      b.update({ theme: "system" });
      start();
      await flush();
      b.dispatch(message);
      await flush();
      expect(b.applied).toEqual([icon("light", "violet")]);
    },
  );
  it("does not overwrite a fresh visible-page report with an older snapshot query", async () => {
    const b = browser();
    b.update({ theme: "system" });
    const response = Promise.withResolvers<unknown>();
    b.sendMessage.mockReturnValueOnce(response.promise);
    start();
    await flush();
    b.dispatch(changed("dark"), webSender);
    response.resolve({ theme: "light" });
    await flush();
    expect(b.applied).toEqual([icon("dark", "violet")]);
    expect(b.documents.size).toBe(0);
  });
  it("serializes an old browser write ahead of the latest preference", async () => {
    const b = browser();
    const write = Promise.withResolvers<void>();
    b.setIcon.mockImplementationOnce(async (details) => {
      await write.promise;
      b.applied.push(details);
    });
    start();
    await flush();
    b.update({ theme: "light", palette: "blue" });
    await flush();
    expect(b.setIcon).toHaveBeenCalledTimes(1);
    write.resolve();
    await flush();
    expect(b.applied).toEqual([icon("dark", "violet"), icon("light", "blue")]);
  });
  it("closes a pending snapshot when the preference becomes explicit", async () => {
    const b = browser();
    b.update({ theme: "system" });
    const create = Promise.withResolvers<void>();
    b.createDocument.mockImplementationOnce(async () => {
      await create.promise;
      b.documents.add(observerUrl);
    });
    start();
    await flush();
    b.update({ theme: "light", palette: "amber" });
    create.resolve();
    await flush();
    expect(b.applied).toEqual([icon("light", "amber")]);
    expect(b.documents.size).toBe(0);
  });
  it("closes the sampler after a failed query and retries on a later signal without writing settings", async () => {
    const b = browser();
    b.update({ theme: "system" });
    b.sendMessage.mockRejectedValueOnce(new Error("Private details"));
    start();
    await flush();
    expect(b.documents.size).toBe(0);
    expect(b.applied).toEqual([]);
    b.dispatch(changed("dark"), webSender);
    await flush();
    expect(b.applied).toEqual([icon("dark", "violet")]);
    expect(console.error).toHaveBeenCalledWith("[cx] Cannot synchronize the toolbar icon");
    expect(b.memory.syncSet).not.toHaveBeenCalled();
  });
  it("retries a failed real browser write on a later notification", async () => {
    const b = browser();
    b.setIcon.mockRejectedValueOnce(new Error("Failed image fetch"));
    start();
    await flush();
    expect(b.applied).toEqual([]);
    b.update({ palette: "blue" });
    await flush();
    expect(b.applied).toEqual([icon("dark", "blue")]);
  });
  it("disposes subscriptions and prevents a delayed settings read from applying", async () => {
    const b = browser();
    const read = Promise.withResolvers<Record<string, unknown>>();
    b.memory.syncGet.mockReturnValueOnce(read.promise);
    const stop = start();
    stop();
    stop();
    read.resolve({});
    await flush();
    b.dispatch(changed("dark"), webSender);
    b.update({ palette: "blue" });
    await flush();
    expect(b.applied).toEqual([]);
    expect(b.messages.size).toBe(0);
    expect(b.memory.listeners.size).toBe(0);
  });
  it("never closes an unrelated offscreen document", async () => {
    const b = browser();
    b.update({ theme: "system" });
    b.documents.add(`${root}unrelated.html`);
    start();
    await flush();
    expect(b.closeDocument).not.toHaveBeenCalled();
    expect(b.documents.has(`${root}unrelated.html`)).toBe(true);
    expect(b.applied).toEqual([]);
  });
});

function media() {
  let dark = false;
  const callbacks = new Set<(event: MediaQueryListEvent) => void>();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return dark;
      },
      addEventListener: (_: string, callback: (event: MediaQueryListEvent) => void) =>
        callbacks.add(callback),
      removeEventListener: (_: string, callback: (event: MediaQueryListEvent) => void) =>
        callbacks.delete(callback),
    })),
  );
  return {
    callbacks,
    change(value: boolean) {
      dark = value;
      for (const callback of callbacks) callback({ matches: value } as MediaQueryListEvent);
    },
    set(value: boolean) {
      dark = value;
    },
  };
}

describe("visible page system reporting", () => {
  it("reports real media changes only when visible, refreshes on visibility and cleans up", async () => {
    const b = browser();
    b.sendMessage.mockResolvedValue(undefined);
    const mq = media();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const stop = startToolbarThemeReporter();
    disposals.push(stop);
    await flush();
    expect(b.sendMessage).toHaveBeenLastCalledWith(changed("light"));
    expect(mq.callbacks.size).toBe(1);
    visibility.mockReturnValue("hidden");
    mq.set(true);
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(b.sendMessage).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(b.sendMessage).toHaveBeenLastCalledWith(changed("dark"));
    stop();
    const calls = b.sendMessage.mock.calls.length;
    mq.change(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(b.sendMessage).toHaveBeenCalledTimes(calls);
    expect(mq.callbacks.size).toBe(0);
  });
  it("pauses on pagehide, resumes once after bfcache pageshow and disposes permanently", async () => {
    const b = browser();
    b.sendMessage.mockResolvedValue(undefined);
    const mq = media();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const stop = startToolbarThemeReporter();
    disposals.push(stop);
    await flush();
    window.dispatchEvent(new Event("pagehide"));
    expect(mq.callbacks.size).toBe(0);
    mq.set(true);
    window.dispatchEvent(new Event("pageshow"));
    window.dispatchEvent(new Event("pageshow"));
    await flush();
    expect(mq.callbacks.size).toBe(1);
    expect(b.sendMessage).toHaveBeenLastCalledWith(changed("dark"));
    stop();
    window.dispatchEvent(new Event("pageshow"));
    expect(mq.callbacks.size).toBe(0);
  });
  it("handles a disconnected extension without leaking a raw error or rejecting the media callback", async () => {
    const b = browser();
    b.sendMessage.mockRejectedValue(new Error("Private details"));
    media();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    disposals.push(startToolbarThemeReporter());
    await flush();
    expect(console.error).toHaveBeenCalledWith(
      "[cx] Cannot report system appearance to the toolbar",
    );
  });
});
