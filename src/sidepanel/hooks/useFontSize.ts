import { useEffect } from "react";
import { clampFontSize } from "@/lib/settings";
import { useSettings } from "./useSettings";

/** Applies the user's preferred UI font size via a CSS variable on <html>. */
export function useFontSize(): void {
  const { data } = useSettings();
  useEffect(() => {
    const px = clampFontSize(data?.fontSize ?? 14);
    document.documentElement.style.setProperty("--base-font-size", `${px}px`);
  }, [data?.fontSize]);
}
