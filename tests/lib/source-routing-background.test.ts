import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenConfxRequest, PickerResult } from "@/types";

type RuntimeListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  respond: (response: unknown) => void,
) => boolean | void;

const extensionRoot = "chrome-extension://lorem/";
const sourceUrl = "https://wiki.example.com/wiki/spaces/DOC/pages/1700/Lorem";
const openPayload: OpenConfxRequest = {
  kind: "open-confx",
  source: "confluence",
  host: "https://wiki.example.com/wiki",
  pageId: "1700",
};
const pickerPayload: PickerResult = {
  kind: "picker-result",
  html: "<p>Lorem ipsum</p>",
  meta: {
    id: "1700",
    title: "Lorem",
    spaceKey: "DOC",
    baseUrl: "https://wiki.example.com",
    url: sourceUrl,
  },
};

function senderFor(tabId: number): chrome.runtime.MessageSender {
  return {
    id: "lorem",
    frameId: 0,
    url: sourceUrl,
    tab: { id: tabId, windowId: 11, url: sourceUrl } as chrome.tabs.Tab,
  };
}

async function installBackground(accessReady: Promise<void> = Promise.resolve()) {
  const memory: Record<string, unknown> = {};
  const localMemory: Record<string, unknown> = {};
  const localGet = vi.fn(async () => structuredClone(localMemory));
  const localSet = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(localMemory, structuredClone(items));
  });
  const runtimeListeners = new Set<RuntimeListener>();
  const windowsById = new Map<
    number,
    { id: number; type: string; tabs: { id: number; url: string }[] }
  >();
  const accessLevels: unknown[] = [];
  const createWindow = vi.fn(async ({ url }: { url: string }) => {
    const id = 30 + windowsById.size;
    const window = { id, type: "popup", tabs: [{ id: 90 + id, url }] };
    windowsById.set(id, window);
    return window;
  });
  const updateWindow = vi.fn(async (id: number) => windowsById.get(id));
  const updateTab = vi.fn().mockResolvedValue({});
  const createTab = vi.fn(async (properties: { url: string }) => ({
    id: 200,
    windowId: 11,
    ...properties,
  }));
  const openPopup = vi.fn().mockRejectedValue(new Error("Native popup unavailable"));
  vi.stubGlobal("chrome", {
    runtime: {
      id: "lorem",
      getURL: (path: string) => `${extensionRoot}${path}`,
      getManifest: () => ({
        manifest_version: 3,
        action: { default_popup: "sidepanel/index.html" },
      }),
      onInstalled: { addListener: vi.fn() },
      onMessage: {
        addListener: (listener: RuntimeListener) => runtimeListeners.add(listener),
        removeListener: (listener: RuntimeListener) => runtimeListeners.delete(listener),
      },
      getContexts: vi.fn().mockResolvedValue([]),
      ContextType: { OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" },
      sendMessage: (message: unknown) => send(message, {
        id: "lorem",
        url: `${extensionRoot}options/index.html`,
      }),
    },
    storage: {
      sync: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      local: { get: localGet, set: localSet },
      session: {
        setAccessLevel: async (options: unknown) => {
          accessLevels.push(options);
          await accessReady;
        },
        get: async (keys: string | string[] | null) => {
          const requested =
            keys === null ? Object.keys(memory) : Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(requested.map((key) => [key, structuredClone(memory[key])]));
        },
        set: async (items: Record<string, unknown>) =>
          Object.assign(memory, structuredClone(items)),
        remove: async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete memory[key];
        },
      },
    },
    tabs: {
      get: vi.fn(async (id: number) => {
        if (id === 7 || id === 8) return { id, windowId: 11, url: sourceUrl };
        throw new Error("Tab missing");
      }),
      query: vi.fn(
        async ({ windowId }: { windowId: number }) =>
          windowsById.get(windowId)?.tabs ?? [{ id: 7, windowId: 11, url: sourceUrl }],
      ),
      create: createTab,
      update: updateTab,
    },
    windows: {
      create: createWindow,
      get: vi.fn(async (id: number) => {
        const window = windowsById.get(id);
        if (!window) throw new Error("Window missing");
        return window;
      }),
      update: updateWindow,
      onRemoved: { addListener: vi.fn() },
    },
    action: {
      setIcon: vi.fn().mockResolvedValue(undefined),
      openPopup,
      onClicked: { addListener: vi.fn() },
    },
  });
  // Exercise service-worker startup against each fresh browser context; a static import runs too early.
  await import("@/background/service-worker");
  const send = (message: unknown, sender = senderFor(7)) => {
    const { promise, resolve } = Promise.withResolvers<{ ok: boolean }>();
    let pending = false;
    for (const listener of runtimeListeners) {
      pending =
        listener(message, sender, (response) => resolve(response as { ok: boolean })) === true ||
        pending;
    }
    if (!pending) resolve({ ok: false });
    return promise;
  };
  return {
    memory,
    localMemory,
    localGet,
    localSet,
    accessLevels,
    createWindow,
    updateWindow,
    updateTab,
    createTab,
    openPopup,
    send,
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("background source-specific handoffs", () => {
  it("creates separate pinned fallback windows and only focuses an existing same-source UI", async () => {
    const background = await installBackground();

    expect(await background.send(openPayload, senderFor(7))).toMatchObject({ ok: true });
    expect(await background.send(openPayload, senderFor(8))).toMatchObject({ ok: true });
    expect(background.createWindow).toHaveBeenCalledTimes(2);
    const urls = background.createWindow.mock.calls.map(([options]) => new URL(options.url));
    expect(urls.map((url) => url.searchParams.get("sourceTabId"))).toEqual(["7", "8"]);

    await background.send(pickerPayload, senderFor(7));
    expect(background.createWindow).toHaveBeenCalledTimes(2);
    expect(background.updateWindow).toHaveBeenLastCalledWith(30, { focused: true });
    expect(background.updateTab).not.toHaveBeenCalled();
  });

  it("uses a native popup only for the active source in its owning window, pinning an inactive source separately", async () => {
    const background = await installBackground();
    background.openPopup.mockResolvedValue(undefined);

    await background.send(openPayload, senderFor(7));
    expect(background.openPopup).toHaveBeenCalledWith({ windowId: 11 });
    expect(background.createWindow).not.toHaveBeenCalled();

    await background.send(openPayload, senderFor(8));
    expect(background.openPopup).toHaveBeenCalledTimes(1);
    expect(
      new URL(background.createWindow.mock.calls[0][0].url).searchParams.get("sourceTabId"),
    ).toBe("8");
  });

  it("rejects cross-origin content authority before opening a UI or storing its body", async () => {
    const background = await installBackground();

    const response = await background.send({
      ...pickerPayload,
      meta: {
        ...pickerPayload.meta,
        baseUrl: "https://other.example.com",
        url: "https://other.example.com/wiki/pages/1700",
      },
    });

    expect(response).toMatchObject({ ok: false });
    expect(background.createWindow).not.toHaveBeenCalled();
    expect(background.memory).toEqual({});
  });

  it("restores trusted-only session access before storing a picked document", async () => {
    const { promise: accessReady, resolve: releaseAccess } = Promise.withResolvers<void>();
    const background = await installBackground(accessReady);
    const response = background.send(pickerPayload);
    await Promise.resolve();
    await Promise.resolve();
    expect(background.accessLevels).toEqual([{ accessLevel: "TRUSTED_CONTEXTS" }]);
    expect(background.memory).toEqual({});
    releaseAccess();
    await expect(response).resolves.toMatchObject({ ok: true });
  });

  it("fails closed without retrying or opening a UI when trusted-only session access is denied", async () => {
    const { promise: accessReady, reject } = Promise.withResolvers<void>();
    const background = await installBackground(accessReady);
    const response = background.send(pickerPayload);
    reject(new Error("Access denied"));

    await expect(response).resolves.toMatchObject({ ok: false });
    await expect(background.send(openPayload)).resolves.toMatchObject({ ok: false });
    expect(background.accessLevels).toEqual([{ accessLevel: "TRUSTED_CONTEXTS" }]);
    expect(background.memory).toEqual({});
    expect(background.createWindow).not.toHaveBeenCalled();
  });

  it("opens a fresh normal workspace only for an explicit valid HTTP source and never reloads another owner", async () => {
    const background = await installBackground();
    const extensionSender: chrome.runtime.MessageSender = {
      id: "lorem",
      url: `${extensionRoot}sidepanel/index.html`,
    };

    expect(
      await background.send(
        { kind: "open-workspace", sourceTabId: 7, tool: "edit" },
        extensionSender,
      ),
    ).toMatchObject({ ok: true });
    const properties = background.createTab.mock.calls[0][0];
    const url = new URL(properties.url);
    expect(url.searchParams.get("surface")).toBe("workspace");
    expect(url.searchParams.get("sourceTabId")).toBe("7");
    expect(url.searchParams.get("tool")).toBe("edit");
    expect(url.searchParams.has("host")).toBe(false);
    expect(background.updateTab).not.toHaveBeenCalled();

    expect(
      await background.send(
        { kind: "open-workspace", sourceTabId: 200, tool: "export" },
        extensionSender,
      ),
    ).toMatchObject({ ok: false });
    expect(background.createTab).toHaveBeenCalledTimes(1);
  });

  it("owns launcher updates across content and Options while preserving other sites and local-only storage", async () => {
    const background = await installBackground();
    const contentUpdate = {
      kind: "update-launcher-state",
      origin: "https://wiki.example.com",
      product: "confluence",
      patch: { hidden: true, edge: "left", yRatio: 0.3 },
    };
    expect(await background.send(contentUpdate)).toMatchObject({ ok: true });
    const optionsSender: chrome.runtime.MessageSender = {
      id: "lorem",
      url: `${extensionRoot}options/index.html`,
    };
    expect(await background.send({
      ...contentUpdate,
      origin: "https://jira.example.com",
      product: "jira",
      patch: { yRatio: 0.8 },
    }, optionsSender)).toMatchObject({ ok: true });
    expect(await background.send({
      ...contentUpdate,
      patch: { hidden: false },
    }, optionsSender)).toMatchObject({ ok: true });
    expect(background.localMemory["cx.launcher.v1"]).toMatchObject({
      "https://wiki.example.com|confluence": { hidden: false, edge: "left", yRatio: 0.3 },
      "https://jira.example.com|jira": { yRatio: 0.8 },
    });
    expect(await background.send({ ...contentUpdate, patch: null }, optionsSender)).toMatchObject({ ok: true });
    expect(Object.keys(background.localMemory["cx.launcher.v1"] as Record<string, unknown>))
      .not.toContain("https://wiki.example.com|confluence");
    expect(background.memory).toEqual({});
  });

  it("rejects invalid launcher patches and content authority over another origin", async () => {
    const background = await installBackground();
    const update = {
      kind: "update-launcher-state",
      origin: "https://wiki.example.com",
      product: "confluence",
      patch: { hidden: true },
    };
    const invalidMessages = [
      { ...update, origin: "https://other.example.com" },
      { ...update, origin: "https://wiki.example.com/wiki" },
      { ...update, origin: "file:///tmp/lorem" },
      { ...update, product: "other" },
      { ...update, patch: { hidden: "true" } },
      { ...update, patch: { edge: "top" } },
      { ...update, patch: { yRatio: 2 } },
      { ...update, patch: { yRatio: Number.NaN } },
      { ...update, patch: { hidden: true, pageBody: "Lorem" } },
      { ...update, patch: [] },
    ];
    for (const message of invalidMessages) {
      expect(await background.send(message)).toMatchObject({ ok: false });
    }
    for (const sender of [
      { ...senderFor(7), id: "another-extension" },
      { ...senderFor(7), frameId: 1 },
      { ...senderFor(7), origin: "https://other.example.com" },
      { ...senderFor(7), url: "https://other.example.com/wiki/pages/1700" },
      { id: "lorem", url: `${extensionRoot}sidepanel/index.html` },
    ]) {
      expect(await background.send(update, sender)).toMatchObject({ ok: false });
    }
    expect(background.localMemory).toEqual({});
  });

  it("preserves concurrent mutations from independent clients through the shared worker owner", async () => {
    const background = await installBackground();
    // Static imports cannot model separate client modules attached to the same live worker.
    const clientA = await import("@/lib/launcher-state");
    vi.resetModules();
    const clientB = await import("@/lib/launcher-state");
    const firstWrite = Promise.withResolvers<void>();
    const releaseWrite = Promise.withResolvers<void>();
    background.localSet.mockImplementationOnce(async (items) => {
      firstWrite.resolve();
      await releaseWrite.promise;
      Object.assign(background.localMemory, structuredClone(items));
    });
    const first = clientA.updateLauncherSite("https://wiki.example.com", "confluence", { hidden: true });
    await firstWrite.promise;
    const second = clientB.updateLauncherSite("https://jira.example.com", "jira", {
      edge: "left",
      yRatio: 0.4,
    });
    await Promise.resolve();
    await Promise.resolve();
    releaseWrite.resolve();
    await Promise.all([first, second]);
    expect(await clientA.loadLauncherState()).toMatchObject({
      "https://wiki.example.com|confluence": { hidden: true },
      "https://jira.example.com|jira": { edge: "left", yRatio: 0.4 },
    });
  });
});
