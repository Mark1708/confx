import {
  defaultScheduler,
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  applyAppearance,
  isTheme,
  isThemePalette,
  resolveTheme,
  watchSystemTheme,
} from "@/lib/appearance";
import { loadSettings } from "@/lib/settings";
import { useTheme } from "@/sidepanel/hooks/useTheme";
import type { Theme, ThemePalette } from "@/types";
import { installLauncherStorage, type LauncherTestStorage } from "../helpers/launcher-storage";

interface SystemThemeQuery extends EventTarget {
  media: string;
  matches: boolean;
}

interface SystemTheme {
  matchMedia: Mock<() => SystemThemeQuery>;
  change: (matches: boolean) => void;
}

function installSystemTheme(initialDark: boolean): SystemTheme {
  const query = Object.assign(new EventTarget(), {
    media: "(prefers-color-scheme: dark)",
    matches: initialDark,
  });
  const matchMedia = vi.fn(() => query);
  vi.stubGlobal("matchMedia", matchMedia);
  return {
    matchMedia,
    change(matches: boolean) {
      query.matches = matches;
      query.dispatchEvent(Object.assign(new Event("change"), { matches, media: query.media }));
    },
  };
}

describe("appearance helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("can be imported without browser globals", async () => {
    vi.resetModules();
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("matchMedia", undefined);

    // Re-import after removing globals to exercise module initialization, not just its pure functions.
    const appearance = await import("@/lib/appearance");

    expect(appearance.resolveTheme("system", true)).toBe("dark");
  });

  it.each(["light", "dark", "system"])("recognizes the persisted %s mode", (theme) => {
    expect(isTheme(theme)).toBe(true);
  });

  it.each(["violet", "blue", "forest", "graphite", "amber"])(
    "recognizes the persisted %s palette",
    (palette) => {
      expect(isThemePalette(palette)).toBe(true);
    },
  );

  it("rejects non-canonical values instead of coercing storage data", () => {
    for (const value of [undefined, null, "", "DARK", "auto", 0, {}, ["dark"]]) {
      expect(isTheme(value)).toBe(false);
    }
    for (const value of [undefined, null, "", "VIOLET", "purple", 0, {}, ["blue"]]) {
      expect(isThemePalette(value)).toBe(false);
    }
  });

  it.each([
    ["light", false, "light"],
    ["light", true, "light"],
    ["dark", false, "dark"],
    ["dark", true, "dark"],
    ["system", false, "light"],
    ["system", true, "dark"],
  ] as const)("resolves %s with systemDark=%s to %s", (mode, systemDark, expected) => {
    expect(resolveTheme(mode, systemDark)).toBe(expected);
  });

  it.each([false, true])(
    "reports the OS immediately and stops reporting after cleanup (dark=%s)",
    (dark) => {
      const media = installSystemTheme(dark);
      const onChange = vi.fn();

      const stop = watchSystemTheme(onChange);

      expect(media.matchMedia).toHaveBeenCalledWith("(prefers-color-scheme: dark)");
      expect(onChange.mock.calls).toEqual([[dark ? "dark" : "light"]]);
      media.change(!dark);
      expect(onChange.mock.calls).toEqual([[dark ? "dark" : "light"], [dark ? "light" : "dark"]]);
      stop();
      media.change(dark);
      expect(onChange).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps independent watcher lifetimes and reads the OS when each watch starts", () => {
    const media = installSystemTheme(false);
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = watchSystemTheme(first);
    media.change(true);
    const stopSecond = watchSystemTheme(second);

    expect(second.mock.calls).toEqual([["dark"]]);
    stopFirst();
    media.change(false);
    expect(first.mock.calls).toEqual([["light"], ["dark"]]);
    expect(second.mock.calls).toEqual([["dark"], ["light"]]);
    stopSecond();
    media.change(true);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("scopes attributes to an embedded root without modifying host document or classes", () => {
    const hostClasses = document.documentElement.className;
    const hostTheme = document.documentElement.getAttribute("data-theme");
    const hostPalette = document.documentElement.getAttribute("data-palette");
    const root = document.createElement("section");
    root.className = "host-widget light dark";
    root.dataset.surface = "workspace-preview";
    root.dataset.unrelated = "retained";
    root.style.setProperty("--host-widget-size", "14px");

    applyAppearance(root, "dark", "blue");

    expect(root.dataset.confxAppearance).toBe("");
    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.palette).toBe("blue");
    expect(root.dataset.surface).toBe("workspace-preview");
    expect(root.dataset.unrelated).toBe("retained");
    expect(root.className).toBe("host-widget light dark");
    expect(root.style.getPropertyValue("--host-widget-size")).toBe("14px");
    expect(document.documentElement.className).toBe(hostClasses);
    expect(document.documentElement.getAttribute("data-theme")).toBe(hostTheme);
    expect(document.documentElement.getAttribute("data-palette")).toBe(hostPalette);
  });

  it("toggles only light and dark classes on the root's own document element", () => {
    const ownDocument = document.implementation.createHTMLDocument("Lorem");
    const root = ownDocument.documentElement;
    root.className = "app-shell light dark";
    root.dataset.surface = "viewer";

    applyAppearance(root, "light", "forest");

    expect(root.classList.contains("light")).toBe(true);
    expect(root.classList.contains("dark")).toBe(false);
    expect(root.classList.contains("system")).toBe(false);
    expect(root.classList.contains("app-shell")).toBe(true);
    expect(root.dataset.surface).toBe("viewer");
    expect(root.dataset.palette).toBe("forest");
    applyAppearance(root, "dark", "amber");
    expect(root.classList.contains("light")).toBe(false);
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.classList.contains("app-shell")).toBe(true);
    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.palette).toBe("amber");
    expect(root.dataset.surface).toBe("viewer");
  });
});

function ThemeSurface({ onLayout }: { onLayout?: () => void }) {
  useTheme();
  useLayoutEffect(() => {
    onLayout?.();
  });
  return null;
}

describe("useTheme preferences lifecycle", () => {
  let root: Root | null;
  let container: HTMLDivElement;
  let client: QueryClient;
  let memory: LauncherTestStorage;
  let media: SystemTheme;
  let attributes: Array<[string, string | null]>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    notifyManager.setScheduler(queueMicrotask);
    memory = installLauncherStorage();
    media = installSystemTheme(false);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    attributes = [
      "class",
      "data-confx-appearance",
      "data-theme",
      "data-palette",
      "data-surface",
    ].map((name) => [name, document.documentElement.getAttribute(name)]);
    document.documentElement.className = "app-shell dark";
    document.documentElement.dataset.surface = "workspace";
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    client.clear();
    container.remove();
    for (const [name, value] of attributes) {
      if (value === null) document.documentElement.removeAttribute(name);
      else document.documentElement.setAttribute(name, value);
    }
    notifyManager.setScheduler(defaultScheduler);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function renderTheme(theme: Theme, palette: ThemePalette, onLayout?: () => void) {
    memory.sync["cx.settings.v1"] = {
      ...(memory.sync["cx.settings.v1"] as object),
      theme,
      palette,
    };
    client.setQueryData(["settings"], await loadSettings());
    await act(async () => {
      root!.render(
        createElement(QueryClientProvider, { client }, createElement(ThemeSurface, { onLayout })),
      );
    });
  }

  it("applies resolved system preferences before subsequent layout effects without persisting OS changes", async () => {
    const layouts: Array<{ theme?: string; palette?: string; dark: boolean }> = [];
    await renderTheme("system", "blue", () => {
      layouts.push({
        theme: document.documentElement.dataset.theme,
        palette: document.documentElement.dataset.palette,
        dark: document.documentElement.classList.contains("dark"),
      });
    });

    expect(layouts[0]).toEqual({ theme: "light", palette: "blue", dark: false });
    expect(document.documentElement.dataset.surface).toBe("workspace");
    await act(async () => media.change(true));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.palette).toBe("blue");
    expect(await loadSettings()).toMatchObject({ theme: "system", palette: "blue" });
    expect(memory.syncSet).not.toHaveBeenCalled();

    await act(async () => {
      memory.emit("sync", {
        "cx.settings.v1": { ...(memory.sync["cx.settings.v1"] as object), palette: "amber" },
      });
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(document.documentElement.dataset.palette).toBe("amber");
    });
    await act(async () => media.change(false));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.palette).toBe("amber");
    expect(await loadSettings()).toMatchObject({ theme: "system", palette: "amber" });

    await act(async () => root!.unmount());
    root = null;
    media.change(true);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.palette).toBe("amber");
    expect(memory.syncSet).not.toHaveBeenCalled();
  });

  it("ignores OS changes in explicit mode and releases a previous system watch when external preferences change", async () => {
    media.change(true);
    await renderTheme("light", "forest");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.palette).toBe("forest");
    expect(media.matchMedia).not.toHaveBeenCalled();

    await act(async () => {
      memory.emit("sync", {
        "cx.settings.v1": {
          ...(memory.sync["cx.settings.v1"] as object),
          theme: "system",
          palette: "graphite",
        },
      });
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(document.documentElement.dataset.palette).toBe("graphite");
    });
    await act(async () => media.change(false));
    expect(document.documentElement.dataset.theme).toBe("light");

    await act(async () => {
      memory.emit("sync", {
        "cx.settings.v1": { ...(memory.sync["cx.settings.v1"] as object), theme: "dark" },
      });
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(document.documentElement.dataset.theme).toBe("dark");
    });
    await act(async () => {
      media.change(true);
      media.change(false);
    });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.palette).toBe("graphite");
    expect(await loadSettings()).toMatchObject({ theme: "dark", palette: "graphite" });
    expect(memory.syncSet).not.toHaveBeenCalled();
  });
});
