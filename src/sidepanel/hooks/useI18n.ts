import { useMemo } from "react";
import type { Locale } from "@/i18n";
import { createTranslator, resolveLocale } from "@/i18n";
import { useSettings } from "./useSettings";

export function useI18n(): { locale: Locale; t: ReturnType<typeof createTranslator> } {
  const { data: settings } = useSettings();
  const localeOverride = settings?.locale ?? "auto";

  const locale = resolveLocale(localeOverride);
  const t = useMemo(() => createTranslator(localeOverride), [localeOverride]);

  return { locale, t };
}
