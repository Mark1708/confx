import { describe, expect, it } from "vitest";
import {
  createTranslator,
  DEFAULT_LOCALE,
  en,
  type Locale,
  localeFromLanguageTag,
  resolveBrowserLocale,
  resolveLocale,
  ru,
  translate,
} from "@/i18n";
import type { DictionaryTree } from "@/i18n/types";

function collectLeafPaths(dictionary: DictionaryTree, prefix = ""): string[] {
  return Object.entries(dictionary).flatMap(([key, value]) => {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    return typeof value === "string" ? [nextPrefix] : collectLeafPaths(value, nextPrefix);
  });
}

describe("i18n dictionaries", () => {
  it("keeps RU and EN dictionary keys in parity", () => {
    expect(collectLeafPaths(en).sort()).toEqual(collectLeafPaths(ru).sort());
  });
});

describe("translation", () => {
  it("interpolates named tokens", () => {
    expect(translate("en", "export.progress.fetchingIssue", { issueKey: "KAFKA-15501" })).toBe(
      "Fetching issue KAFKA-15501",
    );
  });

  it("keeps unresolved tokens when interpolation value is missing", () => {
    expect(translate("ru", "export.progress.fetchingIssue")).toBe("Загрузка задачи {{issueKey}}");
  });

  it("creates translator from explicit locale override", () => {
    const t = createTranslator("en");
    expect(t("common.language")).toBe("Language");
  });

  it("translates page diagnostics labels in both locales", () => {
    expect(translate("en", "settings.diagnostics.title")).toBe("Current tab diagnostics");
    expect(translate("ru", "settings.diagnostics.title")).toBe("Диагностика текущей вкладки");
    expect(translate("en", "settings.diagnostics.sources.meta")).toBe("Metadata");
    expect(translate("ru", "settings.diagnostics.sources.meta")).toBe("Метаданные");
  });
});

describe("locale resolution", () => {
  it.each<[string, Locale | undefined]>([
    ["ru-RU", "ru"],
    ["en-US", "en"],
    ["de-DE", undefined],
    ["", undefined],
  ])("resolves language tag %s", (languageTag, expectedLocale) => {
    expect(localeFromLanguageTag(languageTag)).toBe(expectedLocale);
  });

  it("uses explicit locale override before browser locale", () => {
    expect(resolveLocale("en", { chromeLanguage: "ru-RU" })).toBe("en");
    expect(resolveLocale("ru", { chromeLanguage: "en-US" })).toBe("ru");
  });

  it("resolves auto from chrome UI language first", () => {
    expect(resolveLocale("auto", { chromeLanguage: "en-US", navigatorLanguage: "ru-RU" })).toBe("en");
  });

  it("resolves auto from navigator languages when chrome language is unsupported", () => {
    expect(
      resolveLocale("auto", {
        chromeLanguage: "de-DE",
        navigatorLanguages: ["fr-FR", "ru-RU"],
        navigatorLanguage: "en-US",
      }),
    ).toBe("ru");
  });

  it("falls back to default locale for unsupported browser languages", () => {
    expect(resolveBrowserLocale({ chromeLanguage: "de-DE", navigatorLanguage: "fr-FR" })).toBe(
      DEFAULT_LOCALE,
    );
  });

  it("uses English as the default fallback locale", () => {
    expect(DEFAULT_LOCALE).toBe("en");
    expect(createTranslator()("content.openInConfx")).toBe("Open in ConfX");
  });
});
