import {
  defaultScheduler,
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { DEFAULT_SETTINGS, loadSettings } from "@/lib/settings";
import { AppearanceSettings } from "@/options/components/AppearanceSettings";
import { useFontSize } from "@/sidepanel/hooks/useFontSize";
import { useTheme } from "@/sidepanel/hooks/useTheme";
import type { AppSettings } from "@/types";
import { installLauncherStorage, type LauncherTestStorage } from "../helpers/launcher-storage";

const SETTINGS_KEY = "cx.settings.v1";
const modes = ["light", "dark", "system"] as const;
const palettes = ["violet", "blue", "forest", "graphite", "amber"] as const;
const labels = {
  en: {
    theme: "Theme",
    palette: "Color palette",
    modes: ["Light", "Dark", "System"],
    palettes: ["Violet", "Blue", "Forest", "Graphite", "Amber"],
    language: "Language",
    saveError: "Could not save your appearance choice. Please try again.",
  },
  ru: {
    theme: "Тема",
    palette: "Цветовая схема",
    modes: ["Светлая", "Тёмная", "Системная"],
    palettes: ["Фиолетовая", "Синяя", "Лесная", "Графитовая", "Янтарная"],
    language: "Язык",
    saveError: "Не удалось сохранить выбор оформления. Повторите попытку.",
  },
} as const;

type ChoiceGroup = "cx-theme" | "cx-palette";

interface SystemThemeQuery extends EventTarget {
  readonly media: string;
  matches: boolean;
}

interface SystemTheme {
  matchMedia: Mock<() => SystemThemeQuery>;
  readonly listenerCount: number;
  change: (matches: boolean) => void;
}

function installSystemTheme(initialDark = false): SystemTheme {
  const listeners = new Set<EventListenerOrEventListenerObject>();
  class TestSystemThemeQuery extends EventTarget implements SystemThemeQuery {
    readonly media = "(prefers-color-scheme: dark)";
    matches = initialDark;

    override addEventListener(
      type: string,
      callback: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type === "change" && callback) listeners.add(callback);
      super.addEventListener(type, callback, options);
    }

    override removeEventListener(
      type: string,
      callback: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) {
      if (type === "change" && callback) listeners.delete(callback);
      super.removeEventListener(type, callback, options);
    }
  }
  const query = new TestSystemThemeQuery();
  const matchMedia = vi.fn(() => query);
  vi.stubGlobal("matchMedia", matchMedia);
  return {
    matchMedia,
    get listenerCount() {
      return listeners.size;
    },
    change(matches: boolean) {
      query.matches = matches;
      query.dispatchEvent(Object.assign(new Event("change"), { matches, media: query.media }));
    },
  };
}

function AppearanceSurface() {
  useTheme();
  useFontSize();
  return (
    <div className="cx-options">
      <AppearanceSettings />
    </div>
  );
}

describe("appearance choices with real settings and translations", () => {
  let root: Root | null;
  let container: HTMLDivElement;
  let client: QueryClient;
  let memory: LauncherTestStorage;
  let media: SystemTheme;
  let attributes: Map<string, string | null>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    notifyManager.setScheduler(queueMicrotask);
    memory = installLauncherStorage();
    media = installSystemTheme();
    client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    attributes = new Map(
      ["class", "style", "data-confx-appearance", "data-theme", "data-palette"].map((name) => [
        name,
        document.documentElement.getAttribute(name),
      ]),
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
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

  function seed(patch: Partial<AppSettings>) {
    memory.sync[SETTINGS_KEY] = { ...(memory.sync[SETTINGS_KEY] as object), ...patch };
  }

  async function settled(assertion: () => void) {
    await vi.waitFor(async () => {
      await act(async () => {});
      assertion();
    });
  }

  async function renderChoices() {
    await act(async () => {
      root!.render(
        <QueryClientProvider client={client}>
          <AppearanceSurface />
        </QueryClientProvider>,
      );
    });
    await settled(() => {
      expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(8);
    });
  }

  function radios(group: ChoiceGroup) {
    return [
      ...container.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${group}"]`),
    ];
  }

  function radio(group: ChoiceGroup, value: string) {
    const input = radios(group).find((candidate) => candidate.value === value);
    expect(input, `Missing native ${group} radio for ${value}`).toBeDefined();
    return input!;
  }

  function checked(group: ChoiceGroup) {
    return radios(group)
      .filter((input) => input.checked)
      .map((input) => input.value);
  }

  function preview(group: ChoiceGroup, value: string) {
    const miniature = radio(group, value)
      .closest("label")
      ?.querySelector<HTMLElement>("[data-confx-appearance]");
    expect(miniature, `Missing scoped miniature for ${group} ${value}`).not.toBeNull();
    expect(miniature).toBeDefined();
    return miniature!;
  }

  function expectSaved(theme: AppSettings["theme"], palette: AppSettings["palette"]) {
    expect(checked("cx-theme")).toEqual([theme]);
    expect(checked("cx-palette")).toEqual([palette]);
    expect(document.documentElement.dataset.theme).toBe(theme === "system" ? "light" : theme);
    expect(document.documentElement.dataset.palette).toBe(palette);
  }

  async function choose(group: ChoiceGroup, value: string) {
    await act(async () => radio(group, value).closest("label")!.click());
  }

  function button(label: string) {
    const target = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(target).not.toBeNull();
    return target!;
  }

  it.each(["en", "ru"] as const)(
    "renders localized independent native groups in %s and keeps language/font controls",
    async (locale) => {
      seed({ locale });
      await renderChoices();
      const groups = [...container.querySelectorAll("fieldset")];
      expect(groups).toHaveLength(2);
      expect(groups.map((group) => group.querySelector("legend")?.textContent)).toEqual([
        labels[locale].theme,
        labels[locale].palette,
      ]);
      expect(radios("cx-theme").map((input) => input.value)).toEqual(modes);
      expect(radios("cx-palette").map((input) => input.value)).toEqual(palettes);
      for (const [group, expectedLabels] of [
        ["cx-theme", labels[locale].modes],
        ["cx-palette", labels[locale].palettes],
      ] as const) {
        expect(radios(group).map((input) => input.labels?.[0].textContent?.trim())).toEqual(
          expectedLabels,
        );
        for (const input of radios(group)) {
          expect(input.tabIndex).toBe(0);
          await act(async () => input.focus());
          expect(document.activeElement).toBe(input);
          expect(preview(group, input.value).getAttribute("aria-hidden")).toBe("true");
        }
      }
      expect(
        container.querySelector(`[role="combobox"][aria-label="${labels[locale].language}"]`),
      ).not.toBeNull();
      expect(container.querySelector<HTMLInputElement>("#options-font-size")?.value).toBe(
        String(DEFAULT_SETTINGS.fontSize),
      );
      expectSaved("dark", "violet");
      expect(memory.syncSet).not.toHaveBeenCalled();
    },
  );

  it.each(["light", "dark"] as const)(
    "keeps existing %s users on violet without writing their loaded settings",
    async (theme) => {
      memory.sync[SETTINGS_KEY] = { version: 5, locale: "en", theme, fontSize: 14 };
      await renderChoices();
      expectSaved(theme, "violet");
      expect(memory.syncSet).not.toHaveBeenCalled();
    },
  );

  it("saves every palette independently of mode and updates each mode miniature without reloading", async () => {
    await renderChoices();
    const before = await loadSettings();
    await choose("cx-theme", "light");
    await settled(() => expectSaved("light", "violet"));
    for (const palette of [...palettes.slice(1), "violet"] as const) {
      await choose("cx-palette", palette);
      await settled(() => expectSaved("light", palette));
      expect(await loadSettings()).toEqual({ ...before, theme: "light", palette });
      for (const mode of modes) expect(preview("cx-theme", mode).dataset.palette).toBe(palette);
    }
    await choose("cx-theme", "dark");
    await settled(() => expectSaved("dark", "violet"));
    for (const palette of palettes)
      expect(preview("cx-palette", palette).dataset.theme).toBe("dark");
    expect(media.listenerCount).toBe(1);
    expect(memory.localSet).not.toHaveBeenCalled();
    expect(memory.runtimeSend).not.toHaveBeenCalled();
  });

  it("keeps the system miniature live in explicit mode while palette previews and saved mode ignore OS changes", async () => {
    seed({ theme: "light", palette: "forest" });
    media.change(true);
    await renderChoices();
    expectSaved("light", "forest");
    expect(preview("cx-theme", "system").dataset.theme).toBe("dark");
    expect(preview("cx-theme", "light").dataset.theme).toBe("light");
    expect(preview("cx-theme", "dark").dataset.theme).toBe("dark");
    for (const palette of palettes)
      expect(preview("cx-palette", palette).dataset.theme).toBe("light");
    await act(async () => media.change(false));
    expect(preview("cx-theme", "system").dataset.theme).toBe("light");
    await act(async () => media.change(true));
    expect(preview("cx-theme", "system").dataset.theme).toBe("dark");
    expectSaved("light", "forest");
    expect(await loadSettings()).toMatchObject({ theme: "light", palette: "forest" });
    expect(memory.syncSet).not.toHaveBeenCalled();
    expect(media.listenerCount).toBe(1);
  });

  it("resolves system mode live without replacing the saved preference and cleans up both watches on unmount", async () => {
    await renderChoices();
    await choose("cx-theme", "system");
    await settled(() => expectSaved("system", "violet"));
    expect(media.listenerCount).toBe(2);
    memory.syncSet.mockClear();
    await act(async () => media.change(true));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(checked("cx-theme")).toEqual(["system"]);
    for (const palette of palettes)
      expect(preview("cx-palette", palette).dataset.theme).toBe("dark");
    expect(preview("cx-theme", "system").dataset.theme).toBe("dark");
    expect(await loadSettings()).toMatchObject({ theme: "system", palette: "violet" });
    expect(memory.syncSet).not.toHaveBeenCalled();
    await act(async () => root!.unmount());
    root = null;
    expect(media.listenerCount).toBe(0);
    await act(async () => media.change(false));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(memory.syncSet).not.toHaveBeenCalled();
  });

  it("reflects external locale/mode/palette changes and releases only the resolved-theme watcher on leaving system mode", async () => {
    await renderChoices();
    media.change(true);
    await act(async () =>
      memory.emit("sync", {
        [SETTINGS_KEY]: {
          ...(memory.sync[SETTINGS_KEY] as object),
          locale: "ru",
          theme: "system",
          palette: "amber",
        },
      }),
    );
    await settled(() => {
      expect(checked("cx-theme")).toEqual(["system"]);
      expect(checked("cx-palette")).toEqual(["amber"]);
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(document.documentElement.dataset.palette).toBe("amber");
      expect(container.querySelectorAll("legend")[1]?.textContent).toBe("Цветовая схема");
    });
    expect(media.listenerCount).toBe(2);
    await act(async () =>
      memory.emit("sync", {
        [SETTINGS_KEY]: {
          ...(memory.sync[SETTINGS_KEY] as object),
          theme: "light",
          palette: "graphite",
        },
      }),
    );
    await settled(() => expectSaved("light", "graphite"));
    expect(media.listenerCount).toBe(1);
    expect(preview("cx-theme", "system").dataset.theme).toBe("dark");
    await act(async () => media.change(false));
    expectSaved("light", "graphite");
    expect(preview("cx-theme", "system").dataset.theme).toBe("light");
    expect(memory.syncSet).not.toHaveBeenCalled();
  });

  it("mounts its one preview watcher only after settings load and never adds another while choices rerender", async () => {
    const loading = Promise.withResolvers<Record<string, unknown>>();
    memory.syncGet.mockReturnValueOnce(loading.promise);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={client}>
          <AppearanceSurface />
        </QueryClientProvider>,
      );
    });
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(media.listenerCount).toBe(0);
    media.change(true);
    await act(async () => loading.resolve(structuredClone(memory.sync)));
    await settled(() => expect(radios("cx-theme")).toHaveLength(3));
    expect(media.listenerCount).toBe(1);
    expect(preview("cx-theme", "system").dataset.theme).toBe("dark");
    await choose("cx-palette", "blue");
    await settled(() => expectSaved("dark", "blue"));
    await act(async () => media.change(false));
    expect(preview("cx-theme", "system").dataset.theme).toBe("light");
    expect(media.listenerCount).toBe(1);
    expect(media.matchMedia).toHaveBeenCalledTimes(1);
  });

  it.each(["mode", "palette", "font"] as const)(
    "disables both native groups during a pending %s save without applying unsaved colors",
    async (control) => {
      await renderChoices();
      const saving = Promise.withResolvers<void>();
      memory.syncSet.mockImplementationOnce(async (items) => {
        await saving.promise;
        memory.emit("sync", items);
      });
      if (control === "font") await act(async () => button("Increase font size").click());
      else
        await choose(
          control === "mode" ? "cx-theme" : "cx-palette",
          control === "mode" ? "light" : "blue",
        );
      await settled(() => {
        expect(memory.syncSet).toHaveBeenCalledTimes(1);
        for (const group of container.querySelectorAll("fieldset"))
          expect(group.disabled).toBe(true);
        for (const input of [...radios("cx-theme"), ...radios("cx-palette")])
          expect(input.matches(":disabled")).toBe(true);
      });
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(document.documentElement.dataset.palette).toBe("violet");
      await choose("cx-palette", "amber");
      expect(memory.syncSet).toHaveBeenCalledTimes(1);
      await act(async () => saving.resolve());
      await settled(() => {
        expectSaved(
          control === "mode" ? "light" : "dark",
          control === "palette" ? "blue" : "violet",
        );
        for (const group of container.querySelectorAll("fieldset"))
          expect(group.disabled).toBe(false);
      });
    },
  );

  it.each(["resolves", "rejects"] as const)(
    "restores keyboard focus after disabling a radio during a save that %s",
    async (outcome) => {
      await renderChoices();
      const saving = Promise.withResolvers<void>();
      memory.syncSet.mockImplementationOnce(async (items) => {
        await saving.promise;
        memory.emit("sync", items);
      });
      const input = radio("cx-palette", "blue");
      await act(async () => input.focus());
      await choose("cx-palette", "blue");
      await settled(() => expect(input.matches(":disabled")).toBe(true));
      // Move focus as Chromium does when disabling the focused fieldset;
      // jsdom ignores blur() on an already disabled input.
      await act(async () => {
        document.body.tabIndex = -1;
        document.body.focus();
        document.body.removeAttribute("tabindex");
      });
      await act(async () => {
        if (outcome === "resolves") saving.resolve();
        else saving.reject(new Error("Private storage failure details"));
      });
      await settled(() => {
        expectSaved("dark", outcome === "resolves" ? "blue" : "violet");
        expect(input.matches(":disabled")).toBe(false);
        expect(document.activeElement).toBe(input);
      });
    },
  );

  it("does not steal focus if the user leaves the disabled group before a save completes", async () => {
    await renderChoices();
    const saving = Promise.withResolvers<void>();
    memory.syncSet.mockImplementationOnce(async (items) => {
      await saving.promise;
      memory.emit("sync", items);
    });
    await act(async () => radio("cx-theme", "light").focus());
    await choose("cx-theme", "light");
    await settled(() => expect(radio("cx-theme", "light").matches(":disabled")).toBe(true));
    const nextControl = button("Increase font size");
    await act(async () => nextControl.focus());
    await act(async () => saving.resolve());
    await settled(() => expectSaved("light", "violet"));
    expect(document.activeElement).toBe(nextControl);
  });

  it.each(["en", "ru"] as const)(
    "rolls back both native checked groups on repeated rejected saves, reports a safe %s alert and permits retry",
    async (locale) => {
      seed({ locale });
      await renderChoices();
      const before = await loadSettings();
      for (const [group, value] of [
        ["cx-theme", "light"],
        ["cx-palette", "blue"],
        ["cx-palette", "blue"],
      ] as const) {
        memory.syncSet.mockRejectedValueOnce(new Error("Private storage failure details"));
        await choose(group, value);
        await settled(() => {
          expect(container.querySelector('[role="alert"]')?.textContent).toBe(
            labels[locale].saveError,
          );
          expectSaved("dark", "violet");
          for (const fieldset of container.querySelectorAll("fieldset"))
            expect(fieldset.disabled).toBe(false);
        });
        expect(await loadSettings()).toEqual(before);
        expect(container.textContent).not.toContain("Private storage failure");
      }
      await choose("cx-palette", "blue");
      await settled(() => {
        expectSaved("dark", "blue");
        expect(container.querySelector('[role="alert"]')).toBeNull();
      });
      expect(await loadSettings()).toEqual({ ...before, palette: "blue" });
      expect(memory.syncSet).toHaveBeenCalledTimes(4);
    },
  );

  it("keeps font changes independent of appearance, including range bounds and reset", async () => {
    seed({ theme: "light", palette: "amber", fontSize: 11 });
    await renderChoices();
    expect(button("Decrease font size").disabled).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--base-font-size")).toBe("11px");
    await act(async () => button("Increase font size").click());
    await settled(() =>
      expect(document.documentElement.style.getPropertyValue("--base-font-size")).toBe("12px"),
    );
    const range = container.querySelector<HTMLInputElement>("#options-font-size")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(range, "22");
      range.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settled(() => {
      expect(button("Increase font size").disabled).toBe(true);
      expect(document.documentElement.style.getPropertyValue("--base-font-size")).toBe("22px");
    });
    await act(async () => button("Reset to default value").click());
    await settled(() => {
      expect(range.value).toBe(String(DEFAULT_SETTINGS.fontSize));
      expect(document.documentElement.style.getPropertyValue("--base-font-size")).toBe(
        `${DEFAULT_SETTINGS.fontSize}px`,
      );
    });
    expectSaved("light", "amber");
    expect(await loadSettings()).toMatchObject({
      theme: "light",
      palette: "amber",
      locale: "en",
      fontSize: DEFAULT_SETTINGS.fontSize,
    });
  });
});
