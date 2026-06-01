import { en } from "@/i18n/en";
import { type BrowserLocaleSource, resolveLocale } from "@/i18n/locale";
import { type RuDictionary, ru } from "@/i18n/ru";
import { DEFAULT_LOCALE } from "@/i18n/types";
import type {
  DictionaryKey,
  DictionaryShape,
  DictionaryTree,
  InterpolationValues,
  Locale,
  LocaleOverride,
  Translator,
} from "@/i18n/types";

export { en } from "@/i18n/en";
export {
  type BrowserLocaleSource,
  isLocale,
  isLocaleOverride,
  localeFromLanguageTag,
  normalizeLocaleOverride,
  resolveBrowserLocale,
  resolveLocale,
} from "@/i18n/locale";
export { ru } from "@/i18n/ru";
export {
  DEFAULT_LOCALE,
  DEFAULT_LOCALE_OVERRIDE,
  type InterpolationValues,
  type Locale,
  type LocaleOverride,
  SUPPORTED_LOCALES,
  type Translator,
} from "@/i18n/types";

export type I18nKey = DictionaryKey<RuDictionary>;

const DICTIONARIES: Readonly<Record<Locale, DictionaryShape<RuDictionary>>> = {
  ru,
  en,
};

export function createTranslator(
  localeOverride: LocaleOverride = "auto",
  source?: BrowserLocaleSource,
): Translator<I18nKey> {
  const locale = resolveLocale(localeOverride, source);

  return (key, values) => translate(locale, key, values);
}

export function translate(locale: Locale, key: I18nKey, values: InterpolationValues = {}): string {
  const fallbackText = readDictionaryValue(DICTIONARIES[DEFAULT_LOCALE], key);
  const localizedText = readDictionaryValue(DICTIONARIES[locale], key) ?? fallbackText;
  const template = localizedText ?? key;

  return interpolate(template, values);
}

export const t = createTranslator();

export function interpolate(template: string, values: InterpolationValues): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (token, name: string) => {
    const value = values[name];
    return value === undefined ? token : String(value);
  });
}

function readDictionaryValue(dictionary: DictionaryTree, key: string): string | undefined {
  const value = key.split(".").reduce<DictionaryTree | string | undefined>((current, segment) => {
    if (typeof current !== "object" || current === null) return undefined;
    return current[segment];
  }, dictionary);

  return typeof value === "string" ? value : undefined;
}
