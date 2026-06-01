import { describe, expect, it } from "vitest";
import {
  CURRENT_SETTINGS_VERSION,
  DEFAULT_SETTINGS,
  migrateSettings,
} from "@/lib/settings";

describe("migrateSettings", () => {
  it("returns defaults for undefined", () => {
    const result = migrateSettings(undefined);
    expect(result).toEqual(DEFAULT_SETTINGS);
    expect(result.version).toBe(CURRENT_SETTINGS_VERSION);
  });

  it("returns defaults for null", () => {
    const result = migrateSettings(null);
    expect(result).toEqual(DEFAULT_SETTINGS);
  });

  it("returns defaults for non-object primitives", () => {
    expect(migrateSettings("string")).toEqual(DEFAULT_SETTINGS);
    expect(migrateSettings(42)).toEqual(DEFAULT_SETTINGS);
    expect(migrateSettings(true)).toEqual(DEFAULT_SETTINGS);
  });

  it("returns defaults for arrays", () => {
    expect(migrateSettings([1, 2, 3])).toEqual(DEFAULT_SETTINGS);
  });

  it("migrates legacy object without version field", () => {
    const legacy = { host: "https://confluence.example.com", theme: "light" } as Record<
      string,
      unknown
    >;
    const result = migrateSettings(legacy);

    expect(result.version).toBe(CURRENT_SETTINGS_VERSION);
    expect(result.host).toBe("https://confluence.example.com");
    expect(result.theme).toBe("light");
    // defaults fill the rest
    expect(result.concurrency).toBe(DEFAULT_SETTINGS.concurrency);
    expect(result.fontSize).toBe(DEFAULT_SETTINGS.fontSize);
    expect(result.locale).toBe("auto");
  });

  it("migrates v1 settings with missing locale to auto", () => {
    const v1Settings = {
      ...DEFAULT_SETTINGS,
      version: 1,
      locale: undefined,
      host: "https://v1.example.com",
    };

    const result = migrateSettings(v1Settings);

    expect(result.version).toBe(CURRENT_SETTINGS_VERSION);
    expect(result.host).toBe("https://v1.example.com");
    expect(result.locale).toBe("auto");
  });

  it("migrates legacy generic preset to MD-only while preserving locale", () => {
    const legacy = {
      ...DEFAULT_SETTINGS,
      version: 2,
      activePresetId: "generic",
      locale: "en",
    };

    const result = migrateSettings(legacy);

    expect(result.version).toBe(CURRENT_SETTINGS_VERSION);
    expect(result.activePresetId).toBe("md-only");
    expect(result.locale).toBe("en");
  });

  it("defaults unknown preset ids to MD with attachments", () => {
    const legacy = {
      ...DEFAULT_SETTINGS,
      version: 2,
      activePresetId: "unknown-preset",
    };

    const result = migrateSettings(legacy);

    expect(result.activePresetId).toBe("md-attachments");
  });

  it("preserves current-version object as-is", () => {
    const current = {
      ...DEFAULT_SETTINGS,
      host: "https://wiki.local",
      fontSize: 18,
      locale: "en",
    };
    const result = migrateSettings(current);

    expect(result.version).toBe(CURRENT_SETTINGS_VERSION);
    expect(result.host).toBe("https://wiki.local");
    expect(result.fontSize).toBe(18);
    expect(result.locale).toBe("en");
  });

  it("forward-compatible: preserves newer version without running migrations", () => {
    const future = {
      version: 99,
      host: "https://future.example.com",
      unknownNewField: "some-value",
    };
    const result = migrateSettings(future);

    // version preserved from future data
    expect(result.version).toBe(99);
    expect(result.host).toBe("https://future.example.com");
  });

  it("fills missing fields with defaults", () => {
    const partial = { host: "https://confluence.local" } as Record<string, unknown>;
    const result = migrateSettings(partial);

    expect(result.host).toBe("https://confluence.local");
    expect(result.outputFormat).toBe(DEFAULT_SETTINGS.outputFormat);
    expect(result.concurrency).toBe(DEFAULT_SETTINGS.concurrency);
    expect(result.includeFrontMatter).toBe(DEFAULT_SETTINGS.includeFrontMatter);
    expect(result.customRules).toEqual(DEFAULT_SETTINGS.customRules);
    expect(result.locale).toBe(DEFAULT_SETTINGS.locale);
    expect(result.showConfluenceButton).toBe(DEFAULT_SETTINGS.showConfluenceButton);
    expect(result.showJiraButton).toBe(DEFAULT_SETTINGS.showJiraButton);
    expect(result.version).toBe(CURRENT_SETTINGS_VERSION);
  });

  it("migrates v3 settings by backfilling floating button defaults without losing fields", () => {
    const v3Settings = {
      ...DEFAULT_SETTINGS,
      version: 3,
      host: "https://v3.example.com",
      locale: "en",
      activePresetId: "md-only",
      showConfluenceButton: undefined,
      showJiraButton: undefined,
    };

    const result = migrateSettings(v3Settings);

    expect(result.version).toBe(CURRENT_SETTINGS_VERSION);
    expect(result.host).toBe("https://v3.example.com");
    expect(result.locale).toBe("en");
    expect(result.activePresetId).toBe("md-only");
    expect(result.showConfluenceButton).toBe(true);
    expect(result.showJiraButton).toBe(true);
  });

  it("normalizes invalid locale override to auto", () => {
    const legacy = { locale: "de" } as Record<string, unknown>;
    const result = migrateSettings(legacy);

    expect(result.locale).toBe(DEFAULT_SETTINGS.locale);
  });

  it("normalizes removed win95 theme to the default theme", () => {
    const legacy = { theme: "win95" } as Record<string, unknown>;
    const result = migrateSettings(legacy);

    expect(result.theme).toBe(DEFAULT_SETTINGS.theme);
  });

  it("does not mutate the input object", () => {
    const input = { host: "https://original.local" } as Record<string, unknown>;
    const result = migrateSettings(input);

    expect(result.host).toBe("https://original.local");
    // original is untouched — no version field added
    expect(input).toEqual({ host: "https://original.local" });
    expect(result.version).toBe(CURRENT_SETTINGS_VERSION);
  });
});

describe("DEFAULT_SETTINGS", () => {
  it("has version set to CURRENT_SETTINGS_VERSION", () => {
    expect(DEFAULT_SETTINGS.version).toBe(CURRENT_SETTINGS_VERSION);
  });

  it("has all required fields", () => {
    expect(typeof DEFAULT_SETTINGS.host).toBe("string");
    expect(typeof DEFAULT_SETTINGS.outputFormat).toBe("string");
    expect(typeof DEFAULT_SETTINGS.concurrency).toBe("number");
    expect(typeof DEFAULT_SETTINGS.fontSize).toBe("number");
    expect(typeof DEFAULT_SETTINGS.theme).toBe("string");
    expect(typeof DEFAULT_SETTINGS.showConfluenceButton).toBe("boolean");
    expect(typeof DEFAULT_SETTINGS.showJiraButton).toBe("boolean");
    expect(DEFAULT_SETTINGS.locale).toBe("auto");
    expect(DEFAULT_SETTINGS.activePresetId).toBe("md-attachments");
    expect(Array.isArray(DEFAULT_SETTINGS.customRules)).toBe(true);
  });
});
