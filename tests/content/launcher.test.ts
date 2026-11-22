import { type Mock, type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFloatingButton, type FloatingButton } from "@/content/floating-button";
import { BrowserApi } from "@/lib/browser/browser-api";
import { LAUNCHER_STORAGE_KEY, launcherSiteKey, loadLauncherState } from "@/lib/launcher-state";
import type { UpdateLauncherStateResponse } from "@/types";
import { installLauncherStorage, type LauncherTestStorage } from "../helpers/launcher-storage";

vi.mock("@/lib/browser/browser-api", () => ({
  BrowserApi: {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getURL: (path: string) => chrome.runtime.getURL(path),
  },
}));

const origin = "https://wiki.example.com";
const siteKey = launcherSiteKey(origin, "confluence");

function pointer(target: Element, type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    isPrimary: { value: true },
  });
  target.dispatchEvent(event);
}

function launcherButton(): HTMLButtonElement | null {
  return document.querySelector("#lorem-launcher");
}

function menuItem(index: number): HTMLButtonElement {
  return document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[index];
}

function openMenu() {
  launcherButton()!.dispatchEvent(new KeyboardEvent("keydown", {
    key: "F10", shiftKey: true, bubbles: true, cancelable: true,
  }));
}

async function settle() {
  await vi.advanceTimersByTimeAsync(200);
}

interface SystemThemeQuery extends EventTarget {
  matches: boolean;
  media: string;
}

interface SystemThemeControl {
  addListener: MockInstance<EventTarget["addEventListener"]>;
  removeListener: MockInstance<EventTarget["removeEventListener"]>;
  matchMedia: Mock<() => SystemThemeQuery>;
  change: (matches: boolean) => void;
}

function installSystemTheme(dark = false): SystemThemeControl {
  const query = Object.assign(new EventTarget(), {
    matches: dark,
    media: "(prefers-color-scheme: dark)",
  });
  const addListener = vi.spyOn(query, "addEventListener");
  const removeListener = vi.spyOn(query, "removeEventListener");
  const matchMedia = vi.fn(() => query);
  vi.stubGlobal("matchMedia", matchMedia);
  return {
    addListener,
    removeListener,
    matchMedia,
    change(matches: boolean) {
      query.matches = matches;
      query.dispatchEvent(Object.assign(new Event("change"), { matches, media: query.media }));
    },
  };
}

describe("page launcher lifecycle", () => {
  let memory: LauncherTestStorage;
  let launcher: FloatingButton;
  let systemTheme: SystemThemeControl;
  let documentAttributes: [string, string][];

  beforeEach(() => {
    vi.useFakeTimers();
    documentAttributes = [...document.documentElement.attributes].map(({ name, value }) => [
      name,
      value,
    ]);
    systemTheme = installSystemTheme();
    vi.stubGlobal("location", new URL(`${origin}/pages/viewpage.action?pageId=1000`));
    document.head.innerHTML = '<meta name="ajs-page-id" content="1000">';
    document.body.innerHTML = "<main><p>Lorem page</p></main>";
    memory = installLauncherStorage();
    vi.mocked(BrowserApi.sendMessage).mockClear();
    launcher = createFloatingButton({
      btnId: "lorem-launcher",
      pageKind: "confluence",
      settingsKey: "showConfluenceButton",
      buildPayload: (context) => ({
        kind: "open-confx", source: "confluence", host: context.host, pageId: context.pageId,
      }),
      logPrefix: "[cx] launcher settings unavailable",
    });
  });

  afterEach(async () => {
    launcher.destroy();
    await vi.advanceTimersByTimeAsync(200);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    for (const attribute of [...document.documentElement.attributes]) {
      document.documentElement.removeAttribute(attribute.name);
    }
    for (const [name, value] of documentAttributes) {
      document.documentElement.setAttribute(name, value);
    }
  });

  it("applies live system and palette preferences only to the launcher", async () => {
    const host = document.documentElement;
    host.className = "wiki-host dark";
    host.dataset.theme = "wiki-theme";
    host.dataset.palette = "wiki-palette";
    host.style.setProperty("--primary", "10 20% 30%");
    const content = document.querySelector<HTMLElement>("main")!;
    content.style.color = "rgb(12, 34, 56)";
    content.style.backgroundColor = "rgb(240, 241, 242)";
    const hostAttributes = [...host.attributes].map(({ name, value }) => [name, value]);
    const contentMarkup = content.outerHTML;
    const contentColors = {
      foreground: getComputedStyle(content).color,
      background: getComputedStyle(content).backgroundColor,
    };
    memory.emit("sync", {
      "cx.settings.v1": { ...(memory.sync["cx.settings.v1"] as object), theme: "system", palette: "blue" },
    });
    launcher.init();
    await settle();
    const root = document.querySelector<HTMLElement>(".cx-launcher")!;
    expect(root.dataset.confxAppearance).toBe("");
    expect(root.dataset.theme).toBe("light");
    expect(root.dataset.palette).toBe("blue");
    expect(systemTheme.matchMedia).toHaveBeenCalledWith("(prefers-color-scheme: dark)");
    expect(systemTheme.addListener).toHaveBeenCalledTimes(1);

    systemTheme.change(true);
    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.palette).toBe("blue");
    memory.emit("sync", {
      "cx.settings.v1": { ...(memory.sync["cx.settings.v1"] as object), palette: "forest" },
    });
    await settle();
    expect(document.querySelector(".cx-launcher")).toBe(root);
    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.palette).toBe("forest");
    systemTheme.change(false);
    expect(root.dataset.theme).toBe("light");
    expect(memory.sync["cx.settings.v1"]).toMatchObject({ theme: "system", palette: "forest" });
    expect(memory.syncSet).not.toHaveBeenCalled();
    expect([...host.attributes].map(({ name, value }) => [name, value])).toEqual(hostAttributes);
    expect(content.outerHTML).toBe(contentMarkup);
    expect(getComputedStyle(content).color).toBe(contentColors.foreground);
    expect(getComputedStyle(content).backgroundColor).toBe(contentColors.background);
  });

  it("replaces the system watcher only when appearance preferences actually change", async () => {
    memory.emit("sync", {
      "cx.settings.v1": { ...(memory.sync["cx.settings.v1"] as object), theme: "system", palette: "blue" },
    });
    launcher.init();
    await settle();
    const root = document.querySelector<HTMLElement>(".cx-launcher")!;
    const initialLabel = launcherButton()!.getAttribute("aria-label");
    document.querySelector("main")!.append(document.createElement("p"));
    openMenu();
    menuItem(2).click();
    memory.emit("sync", {
      "cx.settings.v1": { ...(memory.sync["cx.settings.v1"] as object), locale: "ru" },
    });
    await settle();
    expect(launcherButton()!.getAttribute("aria-label")).not.toBe(initialLabel);
    expect(document.querySelector(".cx-launcher")).toBe(root);
    expect(systemTheme.matchMedia).toHaveBeenCalledTimes(1);
    expect(systemTheme.addListener).toHaveBeenCalledTimes(1);
    expect(systemTheme.removeListener).not.toHaveBeenCalled();

    memory.emit("sync", {
      "cx.settings.v1": { ...(memory.sync["cx.settings.v1"] as object), palette: "amber" },
    });
    await settle();
    expect(root.dataset.palette).toBe("amber");
    expect(systemTheme.matchMedia).toHaveBeenCalledTimes(2);
    expect(systemTheme.addListener).toHaveBeenCalledTimes(2);
    expect(systemTheme.removeListener).toHaveBeenCalledTimes(1);
    memory.emit("sync", {
      "cx.settings.v1": { ...(memory.sync["cx.settings.v1"] as object), theme: "light" },
    });
    await settle();
    systemTheme.change(true);
    expect(root.dataset.theme).toBe("light");
    expect(systemTheme.removeListener).toHaveBeenCalledTimes(2);
    memory.emit("sync", {
      "cx.settings.v1": { ...(memory.sync["cx.settings.v1"] as object), theme: "dark", palette: "graphite" },
    });
    await settle();
    systemTheme.change(false);
    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.palette).toBe("graphite");
    expect(systemTheme.matchMedia).toHaveBeenCalledTimes(2);
  });

  it("watches the OS only while an eligible system launcher is mounted", async () => {
    memory.emit("sync", {
      "cx.settings.v1": { ...(memory.sync["cx.settings.v1"] as object), theme: "system", palette: "forest" },
    });
    const overrides = Promise.withResolvers<Record<string, unknown>>();
    memory.localGet.mockReturnValueOnce(overrides.promise);
    launcher.init();
    await settle();
    expect(systemTheme.matchMedia).not.toHaveBeenCalled();
    overrides.resolve({
      [LAUNCHER_STORAGE_KEY]: { [siteKey]: { hidden: true, edge: "right", yRatio: 0.3 } },
    });
    await settle();
    expect(launcherButton()).toBeNull();
    expect(systemTheme.matchMedia).not.toHaveBeenCalled();
    memory.emit("local", { [LAUNCHER_STORAGE_KEY]: {} });
    await settle();
    const firstRoot = document.querySelector<HTMLElement>(".cx-launcher")!;
    expect(firstRoot.dataset.palette).toBe("forest");
    expect(systemTheme.addListener).toHaveBeenCalledTimes(1);
    memory.emit("sync", {
      "cx.settings.v1": { ...(memory.sync["cx.settings.v1"] as object), showConfluenceButton: false },
    });
    await settle();
    expect(launcherButton()).toBeNull();
    expect(systemTheme.removeListener).toHaveBeenCalledTimes(1);
    systemTheme.change(true);
    expect(firstRoot.dataset.theme).toBe("light");
    memory.emit("sync", {
      "cx.settings.v1": { ...(memory.sync["cx.settings.v1"] as object), showConfluenceButton: true },
    });
    await settle();
    const restoredRoot = document.querySelector<HTMLElement>(".cx-launcher")!;
    expect(restoredRoot.dataset.theme).toBe("dark");
    expect(systemTheme.addListener).toHaveBeenCalledTimes(2);
    launcher.destroy();
    expect(systemTheme.removeListener).toHaveBeenCalledTimes(2);
    systemTheme.change(false);
    expect(restoredRoot.dataset.theme).toBe("dark");
    expect(launcherButton()).toBeNull();
  });

  it("cleans up system listeners across SPA replacement and tab-only hiding", async () => {
    memory.emit("sync", {
      "cx.settings.v1": { ...(memory.sync["cx.settings.v1"] as object), theme: "system", palette: "violet" },
    });
    launcher.init();
    await settle();
    const removedRoot = document.querySelector<HTMLElement>(".cx-launcher")!;
    removedRoot.remove();
    await settle();
    const replacement = document.querySelector<HTMLElement>(".cx-launcher")!;
    expect(replacement).not.toBe(removedRoot);
    expect(document.querySelectorAll(".cx-launcher")).toHaveLength(1);
    expect(systemTheme.addListener).toHaveBeenCalledTimes(2);
    expect(systemTheme.removeListener).toHaveBeenCalledTimes(1);
    systemTheme.change(true);
    expect(removedRoot.dataset.theme).toBe("light");
    expect(replacement.dataset.theme).toBe("dark");
    openMenu();
    menuItem(0).click();
    await settle();
    expect(systemTheme.removeListener).toHaveBeenCalledTimes(2);
    systemTheme.change(false);
    memory.emit("sync", {
      "cx.settings.v1": { ...(memory.sync["cx.settings.v1"] as object), palette: "blue" },
    });
    document.querySelector('meta[name="ajs-page-id"]')!.setAttribute("content", "1001");
    document.querySelector("main")!.append(document.createElement("p"));
    await settle();
    expect(launcherButton()).toBeNull();
    expect(replacement.dataset.theme).toBe("dark");
    expect(systemTheme.matchMedia).toHaveBeenCalledTimes(2);
  });

  it("ignores stale appearance reads after newer preferences have mounted", async () => {
    const settings = Promise.withResolvers<Record<string, unknown>>();
    memory.syncGet.mockReturnValueOnce(settings.promise);
    launcher.init();
    memory.emit("sync", {
      "cx.settings.v1": { ...(memory.sync["cx.settings.v1"] as object), theme: "dark", palette: "graphite" },
    });
    await settle();
    const root = document.querySelector<HTMLElement>(".cx-launcher")!;
    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.palette).toBe("graphite");
    settings.resolve({
      "cx.settings.v1": { ...(memory.sync["cx.settings.v1"] as object), theme: "system", palette: "blue" },
    });
    await settle();
    expect(document.querySelector(".cx-launcher")).toBe(root);
    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.palette).toBe("graphite");
    expect(systemTheme.matchMedia).not.toHaveBeenCalled();
  });

  it("never flashes while either settings or site overrides are still loading", async () => {
    const settings = Promise.withResolvers<Record<string, unknown>>();
    const overrides = Promise.withResolvers<Record<string, unknown>>();
    memory.syncGet.mockReturnValueOnce(settings.promise);
    memory.localGet.mockReturnValueOnce(overrides.promise);
    launcher.init();
    expect(launcherButton()).toBeNull();
    settings.resolve(structuredClone(memory.sync));
    await settle();
    expect(launcherButton()).toBeNull();
    overrides.resolve({ [LAUNCHER_STORAGE_KEY]: { [siteKey]: { hidden: true, edge: "left", yRatio: 0.4 } } });
    await settle();
    expect(launcherButton()).toBeNull();
  });

  it("reacts to global and site settings without duplicate nodes after SPA replacement", async () => {
    launcher.init();
    launcher.init();
    await settle();
    expect(document.querySelectorAll("#lorem-launcher")).toHaveLength(1);
    memory.emit("sync", { "cx.settings.v1": { ...(memory.sync["cx.settings.v1"] as object), showConfluenceButton: false } });
    await settle();
    expect(launcherButton()).toBeNull();
    memory.emit("sync", { "cx.settings.v1": { ...(memory.sync["cx.settings.v1"] as object), showConfluenceButton: true } });
    await settle();
    expect(launcherButton()).not.toBeNull();
    document.querySelector(".cx-launcher")!.remove();
    await settle();
    expect(document.querySelectorAll("#lorem-launcher")).toHaveLength(1);
    document.querySelector("#cx-confx-button-style")!.remove();
    await settle();
    expect(document.querySelector("#cx-confx-button-style")).not.toBeNull();
    memory.emit("local", { [LAUNCHER_STORAGE_KEY]: { [siteKey]: { hidden: true, edge: "right", yRatio: 0.3 } } });
    await settle();
    document.querySelector("main")!.append(document.createElement("p"));
    await settle();
    expect(launcherButton()).toBeNull();
    memory.emit("local", { [LAUNCHER_STORAGE_KEY]: {} });
    await settle();
    expect(launcherButton()).not.toBeNull();
  });

  it("keeps tab-only hiding through SPA and settings reconciliation", async () => {
    launcher.init();
    await settle();
    openMenu();
    menuItem(0).click();
    await settle();
    document.querySelector('meta[name="ajs-page-id"]')!.setAttribute("content", "1001");
    document.querySelector("main")!.append(document.createElement("p"));
    memory.emit("local", { [LAUNCHER_STORAGE_KEY]: {} });
    memory.emit("sync", { "cx.settings.v1": memory.sync["cx.settings.v1"] });
    await settle();
    expect(launcherButton()).toBeNull();
    expect(memory.localSet).not.toHaveBeenCalled();
    expect(memory.syncSet).not.toHaveBeenCalled();
  });

  it("supports local keyboard/menu focus without intercepting page shortcuts", async () => {
    launcher.init();
    await settle();
    const unrelated = new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true });
    document.querySelector("main")!.dispatchEvent(unrelated);
    expect(unrelated.defaultPrevented).toBe(false);
    launcherButton()!.focus();
    openMenu();
    expect(document.activeElement).toBe(menuItem(0));
    menuItem(0).dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(menuItem(2));
    menuItem(2).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(document.querySelector<HTMLElement>('[role="menu"]')!.hidden).toBe(true);
    expect(document.activeElement).toBe(launcherButton());
    launcherButton()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(BrowserApi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ pageId: "1000" }));
  });

  it("starts dragging only at six pixels, captures the pointer, snaps, and suppresses the resulting click", async () => {
    launcher.init();
    await settle();
    const button = launcherButton()!;
    const capture = vi.fn();
    const release = vi.fn();
    Object.assign(button, { setPointerCapture: capture, releasePointerCapture: release, hasPointerCapture: () => true });
    const root = document.querySelector<HTMLElement>(".cx-launcher")!;
    const initialLeft = root.style.left;
    const initialTop = root.style.top;
    const startX = parseFloat(initialLeft) + 20;
    const startY = parseFloat(root.style.top) + 20;
    pointer(button, "pointerdown", startX, startY);
    pointer(button, "pointermove", startX - 5, startY);
    expect(root.style.left).toBe(initialLeft);
    pointer(button, "pointermove", 20, 250);
    pointer(button, "pointerup", 20, 250);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, cancelable: true }));
    await settle();
    expect(capture).toHaveBeenCalledWith(1);
    expect(release).toHaveBeenCalledWith(1);
    expect(root.style.left).toBe("12px");
    expect((await loadLauncherState())[siteKey].edge).toBe("left");
    expect(BrowserApi.sendMessage).not.toHaveBeenCalled();
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(BrowserApi.sendMessage).toHaveBeenCalledTimes(1);
    openMenu();
    menuItem(2).click();
    await settle();
    expect(root.style.left).toBe(initialLeft);
    expect(root.style.top).toBe(initialTop);
  });

  it("repositions within visual viewport after zoom and removes listeners on teardown", async () => {
    const viewport = Object.assign(new EventTarget(), { width: 500, height: 400, offsetLeft: 0, offsetTop: 0 });
    vi.stubGlobal("visualViewport", viewport);
    launcher.init();
    await settle();
    Object.assign(viewport, { width: 180, height: 150, offsetLeft: 80, offsetTop: 100 });
    viewport.dispatchEvent(new Event("resize"));
    const root = document.querySelector<HTMLElement>(".cx-launcher")!;
    expect(parseFloat(root.style.left) + 40).toBeLessThanOrEqual(248);
    expect(parseFloat(root.style.top) + 40).toBeLessThanOrEqual(238);
    launcher.destroy();
    expect(memory.listeners.size).toBe(0);
    memory.emit("local", { [LAUNCHER_STORAGE_KEY]: {} });
    document.querySelector("main")!.append(document.createElement("p"));
    viewport.dispatchEvent(new Event("resize"));
    await settle();
    expect(launcherButton()).toBeNull();
  });

  it("persists site hiding and does not resurface on host mutations", async () => {
    launcher.init();
    await settle();
    openMenu();
    menuItem(1).click();
    await settle();
    expect((await loadLauncherState())[siteKey].hidden).toBe(true);
    document.querySelector("main")!.replaceChildren(document.createElement("p"));
    await settle();
    expect(launcherButton()).toBeNull();
  });

  it("keeps a failed initial storage read hidden until a successful live refresh", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    memory.localGet.mockRejectedValueOnce(new Error("storage unavailable"));
    launcher.init();
    await settle();
    expect(launcherButton()).toBeNull();
    memory.emit("local", { [LAUNCHER_STORAGE_KEY]: {} });
    await settle();
    expect(launcherButton()).not.toBeNull();
  });

  it("does not mount late-loaded controls after the document is closed", async () => {
    const loading = Promise.withResolvers<Record<string, unknown>>();
    memory.localGet.mockReturnValueOnce(loading.promise);
    launcher.init();
    window.dispatchEvent(new Event("pagehide"));
    loading.resolve({});
    await settle();
    expect(memory.listeners.size).toBe(0);
    expect(launcherButton()).toBeNull();
  });

  it("reconciles one launcher when an SPA changes products", async () => {
    const jira = createFloatingButton({
      btnId: "lorem-jira-launcher",
      pageKind: "jira",
      settingsKey: "showJiraButton",
      buildPayload: (context) => ({
        kind: "open-confx", source: "jira", host: context.host, issueKey: context.issueKey,
      }),
      logPrefix: "[cx] Jira launcher settings unavailable",
    });
    try {
      launcher.init();
      jira.init();
      await settle();
      vi.stubGlobal("location", new URL(`${origin}/browse/LOREM-1`));
      document.querySelector('meta[name="ajs-page-id"]')!.remove();
      const issueMeta = document.createElement("meta");
      issueMeta.name = "ajs-issue-key";
      issueMeta.content = "LOREM-1";
      document.head.append(issueMeta);
      await settle();
      expect(launcherButton()).toBeNull();
      expect(document.querySelectorAll(".cx-confx-button")).toHaveLength(1);
      (document.querySelector("#lorem-jira-launcher") as HTMLButtonElement).click();
      expect(BrowserApi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ issueKey: "LOREM-1" }));
    } finally {
      jira.destroy();
    }
  });

  it.each(["reject", "resolve"] as const)(
    "keeps a newer external hide when an older save later %ss",
    async (outcome) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const response = Promise.withResolvers<UpdateLauncherStateResponse>();
      memory.runtimeSend.mockReturnValueOnce(response.promise);
      launcher.init();
      await settle();
      const previous = await loadLauncherState();
      openMenu();
      menuItem(2).click();
      memory.emit("local", {
        [LAUNCHER_STORAGE_KEY]: { [siteKey]: { hidden: true, edge: "left", yRatio: 0.3 } },
      });
      await settle();
      expect(launcherButton()).toBeNull();
      if (outcome === "reject") response.reject(new Error("Save rejected"));
      else response.resolve({ ok: true, state: previous });
      await settle();
      expect(launcherButton()).toBeNull();
      expect((await loadLauncherState())[siteKey].hidden).toBe(true);
    },
  );

  it("releases pointer capture when a live site hide unmounts an active drag", async () => {
    launcher.init();
    await settle();
    const button = launcherButton()!;
    const release = vi.fn();
    Object.assign(button, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
      releasePointerCapture: release,
    });
    pointer(button, "pointerdown", 900, 400);
    pointer(button, "pointermove", 880, 400);
    memory.emit("local", {
      [LAUNCHER_STORAGE_KEY]: { [siteKey]: { hidden: true, edge: "right", yRatio: 0.4 } },
    });
    await settle();
    expect(release).toHaveBeenCalledWith(1);
    expect(launcherButton()).toBeNull();
    expect(memory.runtimeSend).not.toHaveBeenCalled();
  });

  it("ignores a previous lifecycle's save after the same controller is initialized again", async () => {
    const response = Promise.withResolvers<UpdateLauncherStateResponse>();
    memory.runtimeSend.mockReturnValueOnce(response.promise);
    launcher.init();
    await settle();
    openMenu();
    menuItem(2).click();
    launcher.destroy();
    memory.emit("local", {
      [LAUNCHER_STORAGE_KEY]: { [siteKey]: { hidden: true, edge: "left", yRatio: 0.3 } },
    });
    launcher.init();
    await settle();
    response.resolve({ ok: true, state: {} });
    await settle();
    expect(launcherButton()).toBeNull();
  });

  it("keeps actionable error feedback when a current save fails without a newer override", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    memory.runtimeSend.mockResolvedValueOnce({ ok: false, error: "Storage unavailable" });
    launcher.init();
    await settle();
    openMenu();
    menuItem(2).click();
    await settle();
    expect(launcherButton()).not.toBeNull();
    expect(document.querySelector<HTMLElement>('[role="menu"]')!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('[role="alert"]')!.hidden).toBe(false);
    expect(await loadLauncherState()).toEqual({});
  });
});
