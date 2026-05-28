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

  it("migrates legacy object without version field (v0 → v1)", () => {
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
  });

  it("preserves current-version object as-is", () => {
    const current = {
      ...DEFAULT_SETTINGS,
      host: "https://wiki.local",
      fontSize: 18,
    };
    const result = migrateSettings(current);

    expect(result.version).toBe(CURRENT_SETTINGS_VERSION);
    expect(result.host).toBe("https://wiki.local");
    expect(result.fontSize).toBe(18);
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
    expect(result.version).toBe(CURRENT_SETTINGS_VERSION);
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
    expect(Array.isArray(DEFAULT_SETTINGS.customRules)).toBe(true);
  });
});
