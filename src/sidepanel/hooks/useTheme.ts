import { useEffect } from "react";
import type { Theme } from "@/types";
import { useSettings } from "./useSettings";

const THEME_CLASSES: Theme[] = ["light", "dark"];

/** Applies the user's theme by toggling a class on <html>. */
export function useTheme(): void {
  const { data } = useSettings();
  const theme: Theme = data?.theme ?? "dark";
  useEffect(() => {
    const root = document.documentElement;
    for (const t of THEME_CLASSES) root.classList.remove(t);
    root.classList.add(theme);
  }, [theme]);
}
