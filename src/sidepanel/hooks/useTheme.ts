import { useLayoutEffect } from "react";
import { applyAppearance, watchSystemTheme } from "@/lib/appearance";
import { reportToolbarSystemTheme } from "@/lib/browser/toolbar-theme";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { useSettings } from "./useSettings";

/** Applies resolved appearance preferences before the owning surface paints. */
export function useTheme(): void {
  const { data } = useSettings();
  const { theme, palette } = data ?? DEFAULT_SETTINGS;
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (theme === "system") {
      return watchSystemTheme((resolved) => {
        applyAppearance(root, resolved, palette);
        void reportToolbarSystemTheme(resolved);
      });
    }
    applyAppearance(root, theme, palette);
  }, [theme, palette]);
}
