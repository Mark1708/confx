import type { Theme, ThemePalette } from "@/types";

export type ResolvedTheme = Exclude<Theme, "system">;

export const THEME_MODES = ["light", "dark", "system"] as const;
export const THEME_PALETTES = ["violet", "blue", "forest", "graphite", "amber"] as const;

export function isTheme(value: unknown): value is Theme {
  return (THEME_MODES as readonly unknown[]).includes(value);
}

export function isThemePalette(value: unknown): value is ThemePalette {
  return (THEME_PALETTES as readonly unknown[]).includes(value);
}

export function resolveTheme(theme: Theme, systemDark: boolean): ResolvedTheme {
  if (theme !== "system") return theme;
  return systemDark ? "dark" : "light";
}

/** Reports the current OS preference immediately; callers own the returned cleanup. */
export function watchSystemTheme(onChange: (theme: ResolvedTheme) => void): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const listener = (event: MediaQueryListEvent): void => {
    onChange(resolveTheme("system", event.matches));
  };
  const onVisible = (): void => {
    if (document.visibilityState === "visible") {
      onChange(resolveTheme("system", media.matches));
    }
  };
  onChange(resolveTheme("system", media.matches));
  media.addEventListener("change", listener);
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    media.removeEventListener("change", listener);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

/** Scopes tokens to owned roots, reserving Tailwind theme classes for document roots. */
export function applyAppearance(
  root: HTMLElement,
  theme: ResolvedTheme,
  palette: ThemePalette,
): void {
  root.dataset.confxAppearance = "";
  root.dataset.theme = theme;
  root.dataset.palette = palette;
  if (root === root.ownerDocument.documentElement) {
    root.classList.toggle("light", theme === "light");
    root.classList.toggle("dark", theme === "dark");
  }
}
