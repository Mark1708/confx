import {
  DEFAULT_LOCALE,
  DEFAULT_LOCALE_OVERRIDE,
  type Locale,
  type LocaleOverride,
  SUPPORTED_LOCALES,
} from "@/i18n/types";

export interface BrowserLocaleSource {
  readonly chromeLanguage?: string | null | undefined;
  readonly navigatorLanguage?: string | null | undefined;
  readonly navigatorLanguages?: readonly string[] | null | undefined;
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && SUPPORTED_LOCALES.includes(value as Locale);
}

export function isLocaleOverride(value: unknown): value is LocaleOverride {
  return value === DEFAULT_LOCALE_OVERRIDE || isLocale(value);
}

export function normalizeLocaleOverride(value: unknown): LocaleOverride {
  return isLocaleOverride(value) ? value : DEFAULT_LOCALE_OVERRIDE;
}

export function localeFromLanguageTag(languageTag: string | null | undefined): Locale | undefined {
  if (!languageTag) return undefined;

  const normalized = languageTag.trim().toLowerCase();
  const primaryLanguage = normalized.split("-")[0];

  return isLocale(primaryLanguage) ? primaryLanguage : undefined;
}

export function resolveBrowserLocale(
  source: BrowserLocaleSource = getRuntimeLocaleSource(),
): Locale {
  const candidates = [
    source.chromeLanguage,
    ...(source.navigatorLanguages ?? []),
    source.navigatorLanguage,
  ];

  return (
    candidates.reduce<Locale | undefined>(
      (resolved, candidate) => resolved ?? localeFromLanguageTag(candidate),
      undefined,
    ) ?? DEFAULT_LOCALE
  );
}

export function resolveLocale(
  override: LocaleOverride = DEFAULT_LOCALE_OVERRIDE,
  source?: BrowserLocaleSource,
): Locale {
  return isLocale(override) ? override : resolveBrowserLocale(source);
}

function getRuntimeLocaleSource(): BrowserLocaleSource {
  const chromeLanguage = globalThis.chrome?.i18n?.getUILanguage?.();
  const navigatorLanguage = globalThis.navigator?.language;
  const navigatorLanguages = globalThis.navigator?.languages;

  return { chromeLanguage, navigatorLanguage, navigatorLanguages };
}
