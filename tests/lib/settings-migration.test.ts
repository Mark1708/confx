import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createExportDefaults,
  CURRENT_SETTINGS_VERSION,
  loadSettings,
  migrateSettings,
  saveSettings,
} from "@/lib/settings";
import { applyRules } from "@/lib/rule-engine";
import type { AppSettings, ExtractionRule } from "@/types";

const customRule: ExtractionRule = {
  id: "lorem-custom-table",
  name: "Lorem supplemental CSV",
  type: "table",
  matcher: "table.supplemental",
  action: "to-csv",
  enabled: true,
  options: { delimiter: ";", includeHeader: false, columnLimit: 4 },
};

const palettes = ["violet", "blue", "forest", "graphite", "amber"] as const;

const obsoleteKeys = [
  "host",
  "outputFormat",
  "skipUnchanged",
  "maxDepth",
  "activePresetId",
  "includeFrontMatter",
  "includeComments",
  "includeHistory",
  "rewriteInternalLinks",
  "deduplicateImages",
  "exportAttachments",
];

function legacySettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 4,
    host: "https://confluence.example.com",
    confluenceBaseUrl: "https://confluence.example.com/wiki",
    outputFormat: "md-csv-images",
    activePresetId: "md-attachments",
    includeFrontMatter: false,
    includeComments: false,
    includeHistory: true,
    rewriteInternalLinks: false,
    deduplicateImages: false,
    exportAttachments: false,
    maxDepth: 1,
    skipUnchanged: true,
    concurrency: 7,
    requestTimeout: 12_345,
    maxRetries: 2,
    maxConcurrency: 4,
    maxAttachmentSize: 2048,
    customRules: [customRule],
    showConfluenceButton: false,
    showJiraButton: false,
    fontSize: 18,
    theme: "light",
    locale: "en",
    ...overrides,
  };
}

describe("migrateSettings", () => {
  it.each(["light", "dark"] as const)("migrates v4 %s without losing export, network, locale, custom, or unknown settings", (theme) => {
    const legacy = legacySettings({ theme, retainedLegacyField: { enabled: true } });
    const before = structuredClone(legacy);

    const result = migrateSettings(legacy);

    expect(result.version).toBe(6);
    expect(result.exportDefaults).toEqual({
      presetId: "md-attachments",
      package: {
        editable: true,
        images: true,
        attachments: false,
        plantUmlAssets: false,
        comments: false,
        history: true,
      },
      conversion: {
        includeFrontMatter: false,
        rewriteInternalLinks: false,
        deduplicateAssets: false,
        presetRules: [],
      },
      maxDepth: null,
    });
    expect(result).toMatchObject({
      confluenceBaseUrl: "https://confluence.example.com/wiki",
      concurrency: 7,
      requestTimeout: 12_345,
      maxRetries: 2,
      maxConcurrency: 4,
      maxAttachmentSize: 2048,
      customRules: [customRule],
      showConfluenceButton: false,
      showJiraButton: false,
      fontSize: 18,
      theme,
      palette: "violet",
      retainedLegacyField: { enabled: true },
      locale: "en",
    });
    for (const key of obsoleteKeys) expect(result).not.toHaveProperty(key);
    expect(legacy).toEqual(before);
  });

  it.each([
    ["generic", "md-only", false, false],
    ["all-csv", "md-attachments", true, true],
    ["full-page", "md-attachments", true, true],
    ["api-doc", "md-attachments", true, true],
    ["md-only", "md-only", false, false],
    ["md-attachments", "md-attachments", true, true],
    ["tables-only", "tables-only", false, false],
    ["unknown-preset", "md-attachments", true, true],
  ])(
    "normalizes legacy preset %s only at the input boundary while preserving additional rules",
    (legacyId, expectedId, images, plantUmlAssets) => {
      const result = migrateSettings(
        legacySettings({ activePresetId: legacyId, exportAttachments: true }),
      );

      expect(result.exportDefaults.presetId).toBe(expectedId);
      expect(result.exportDefaults.package).toMatchObject({
        images,
        attachments: true,
        plantUmlAssets,
      });
      expect(result.customRules).toEqual([customRule]);
      expect(result.exportDefaults.maxDepth).toBeNull();
    },
  );

  it("preserves actually applied v4 tables-only filtering without duplicating overlapping custom CSV", () => {
    const result = migrateSettings(
      legacySettings({ activePresetId: "tables-only", exportAttachments: true }),
    );
    const converted = applyRules(
      '<p>Lorem body</p><table class="supplemental"><tr><td>Ipsum</td></tr></table>',
      [...result.exportDefaults.conversion.presetRules, ...result.customRules],
    );

    expect(result.exportDefaults.conversion.presetRules).toHaveLength(2);
    expect(result.exportDefaults.conversion.presetRules[0]).toMatchObject({
      action: "to-csv",
      options: { removeAfterCsv: true },
    });
    expect(result.exportDefaults.conversion.presetRules[1].action).toBe("skip");
    expect(converted.tables.map((table) => table.csv)).toEqual(["Ipsum"]);
    const doc = new DOMParser().parseFromString(converted.mainHtml, "text/html");
    expect(doc.querySelector("p")).toBeNull();
    expect(doc.querySelector("table")).toBeNull();
  });

  it.each([undefined, 1, 2, 3])(
    "keeps the earlier migration chain for version %s and retains locale and custom rule options",
    (version) => {
      const result = migrateSettings(
        legacySettings({
          version,
          activePresetId: "generic",
          locale: version === undefined || version === 1 ? undefined : "ru",
          showConfluenceButton: undefined,
          showJiraButton: undefined,
        }),
      );

      expect(result.version).toBe(CURRENT_SETTINGS_VERSION);
      expect(result.exportDefaults.presetId).toBe("md-only");
      expect(result.locale).toBe(version === undefined || version === 1 ? "auto" : "ru");
      expect(result.customRules).toEqual([customRule]);
      expect(result.showConfluenceButton).toBe(true);
      expect(result.showJiraButton).toBe(true);
    },
  );

  it("preserves current base-rule payload and unknown nested fields rather than rebuilding its preset", () => {
    const current = {
      version: CURRENT_SETTINGS_VERSION,
      exportDefaults: {
        ...createExportDefaults("md-only"),
        futureDefault: { enabled: true },
        package: { ...createExportDefaults("md-only").package, futurePackage: "lorem" },
        conversion: {
          ...createExportDefaults("md-only").conversion,
          presetRules: [customRule],
          futureConversion: { mode: "ipsum" },
        },
        maxDepth: 6,
      },
      customRules: [],
      unknownCurrentField: { retained: true },
    };

    const result = migrateSettings(current);

    expect(result).toMatchObject(current);
    expect(result.exportDefaults.conversion.presetRules).toEqual([customRule]);
  });

  it.each(["light", "dark"] as const)("adds violet to v5 %s without rebuilding persisted export defaults", (theme) => {
    const defaults = createExportDefaults("tables-only");
    const previous = {
      version: 5,
      theme,
      locale: "ru",
      exportDefaults: {
        ...defaults,
        futureDefault: { retained: true },
        package: { ...defaults.package, editable: false, futurePackage: { enabled: true } },
        conversion: {
          ...defaults.conversion,
          includeFrontMatter: false,
          presetRules: [customRule],
          futureConversion: { mode: "lorem" },
        },
        maxDepth: 4,
      },
      customRules: [customRule],
      concurrency: 7,
      requestTimeout: 12_345,
      maxRetries: 2,
      maxConcurrency: 4,
      maxAttachmentSize: 2048,
      showConfluenceButton: false,
      showJiraButton: false,
      fontSize: 18,
      futureSetting: { retained: ["lorem", "ipsum"] },
    };
    const before = structuredClone(previous);

    const result = migrateSettings(previous);

    expect(result).toMatchObject({ ...previous, version: 6, palette: "violet" });
    expect(result.exportDefaults).toEqual(previous.exportDefaults);
    expect(previous).toEqual(before);
  });

  it.each(palettes)("preserves an existing valid %s palette and system mode through v5 migration", (palette) => {
    expect(migrateSettings({ version: 5, theme: "system", palette })).toMatchObject({
      version: 6,
      theme: "system",
      palette,
    });
  });

  it.each([5, CURRENT_SETTINGS_VERSION, 99])("normalizes invalid palettes at the version %i boundary without losing unknown data", (version) => {
    for (const palette of [undefined, null, "", "purple", "VIOLET", 0, {}, ["blue"]]) {
      expect(
        migrateSettings({
          version,
          theme: "system",
          palette,
          futureSetting: { retained: true },
        }),
      ).toMatchObject({
        version: Math.max(version, 6),
        theme: "system",
        palette: "violet",
        futureSetting: { retained: true },
      });
    }
  });

  it("keeps newer schema data including unknown nested leaves and fields that this version removed", () => {
    const future = {
      version: 99,
      host: "https://future.example.com",
      futureSetting: { enabled: true },
      exportDefaults: {
        ...createExportDefaults("md-only"),
        futureDefault: "lorem",
        package: { futureResourcePolicy: { strategy: "ipsum" } },
        conversion: { presetRules: [customRule], futureConverter: [1, 2] },
      },
    };

    expect(migrateSettings(future)).toMatchObject(future);
  });

  it("fills missing nested leaves without sharing templates or overwriting explicit false values", () => {
    const result = migrateSettings({
      version: CURRENT_SETTINGS_VERSION,
      exportDefaults: {
        presetId: "md-attachments",
        package: { images: false, comments: false },
        conversion: { includeFrontMatter: false, presetRules: [] },
      },
    });
    const other = migrateSettings(null);

    expect(result.exportDefaults.package).toMatchObject({
      images: false,
      comments: false,
      attachments: true,
      editable: true,
    });
    expect(result.exportDefaults.conversion.includeFrontMatter).toBe(false);
    expect(result.exportDefaults.maxDepth).toBeNull();
    result.exportDefaults.package.attachments = false;
    expect(other.exportDefaults.package.attachments).toBe(true);
  });

  it("provides independent nested defaults for non-settings input", () => {
    const first = migrateSettings(["not-settings"]);
    const second = migrateSettings(null);

    first.exportDefaults.package.images = false;
    first.exportDefaults.conversion.presetRules.push(customRule);
    first.customRules.push(customRule);

    expect(second.exportDefaults.package.images).toBe(true);
    expect(second.exportDefaults.conversion.presetRules).toEqual([]);
    expect(second.customRules).toEqual([]);
  });
});

describe("createExportDefaults", () => {
  it("returns independent executable templates, including rule objects and their options", () => {
    const first = createExportDefaults("tables-only");
    const second = createExportDefaults("tables-only");
    const html = "<p>Lorem</p><table><tr><td>Ipsum</td></tr></table>";

    first.package.images = true;
    first.conversion.presetRules[0].matcher = ".not-present";
    first.conversion.presetRules[0].options = { removeAfterCsv: true };
    first.conversion.presetRules.push(customRule);
    const converted = applyRules(html, second.conversion.presetRules);

    expect(second.package.images).toBe(false);
    expect(converted.tables.map((table) => table.csv)).toEqual(["Ipsum"]);
    const doc = new DOMParser().parseFromString(converted.mainHtml, "text/html");
    expect(doc.querySelector("p")?.textContent).toBe("Lorem");
    expect(doc.querySelector("table")?.textContent).toBe("Ipsum");
    expect(createExportDefaults("tables-only")).toEqual(second);
  });
});

describe("saveSettings", () => {
  let stored: unknown;

  beforeEach(() => {
    stored = undefined;
    vi.stubGlobal("chrome", {
      storage: {
        sync: {
          get: async () => ({ "cx.settings.v1": structuredClone(stored) }),
          set: async (items: Record<string, unknown>) => {
            stored = structuredClone(items["cx.settings.v1"]);
          },
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves migrated current data without obsolete keys and retains custom and network settings", async () => {
    stored = legacySettings({ currentUnknown: { retained: true } });

    const saved = await saveSettings({ fontSize: 20 });

    expect(saved.version).toBe(6);
    expect(saved.fontSize).toBe(20);
    expect(saved.customRules).toEqual([customRule]);
    expect(saved.maxConcurrency).toBe(4);
    expect(saved).toHaveProperty("currentUnknown.retained", true);
    for (const key of obsoleteKeys) expect(stored).not.toHaveProperty(key);
    expect(stored).toEqual(saved);
  });

  it("removes obsolete keys from current-version data too, without removing unknown fields", async () => {
    stored = {
      ...migrateSettings(legacySettings()),
      activePresetId: "generic",
      includeHistory: false,
      host: "https://obsolete.example.com",
      outputFormat: "html-archive",
      skipUnchanged: true,
      maxDepth: 2,
      retainedCurrentField: { enabled: true },
    };

    const saved = await saveSettings({ showConfluenceButton: true });

    for (const key of obsoleteKeys) expect(saved).not.toHaveProperty(key);
    expect(saved.exportDefaults.package.history).toBe(true);
    expect(saved).toHaveProperty("retainedCurrentField.enabled", true);
  });

  it.each([CURRENT_SETTINGS_VERSION, 99])(
    "preserves version %i and unknown nested fields when replacing known defaults",
    async (version) => {
      stored = {
        version,
        futureTopLevel: { enabled: true },
        ...(version > CURRENT_SETTINGS_VERSION ? { host: "https://future.example.com" } : {}),
        exportDefaults: {
          ...createExportDefaults("md-attachments"),
          futureDefault: "lorem",
          package: {
            ...createExportDefaults("md-attachments").package,
            futureResourcePolicy: { strategy: "ipsum" },
          },
          conversion: {
            ...createExportDefaults("md-attachments").conversion,
            futureConverter: { levels: [1, 2] },
          },
        },
        customRules: [customRule],
        requestTimeout: 12_345,
      };

      const saved = await saveSettings({
        version: CURRENT_SETTINGS_VERSION,
        exportDefaults: createExportDefaults("md-only"),
        theme: "light",
      });

      expect(saved.version).toBe(version);
      expect(saved.theme).toBe("light");
      expect(saved.exportDefaults.presetId).toBe("md-only");
      expect(saved.customRules).toEqual([customRule]);
      expect(saved.requestTimeout).toBe(12_345);
      expect(saved).toMatchObject({
        futureTopLevel: { enabled: true },
        exportDefaults: {
          futureDefault: "lorem",
          package: { futureResourcePolicy: { strategy: "ipsum" } },
          conversion: { futureConverter: { levels: [1, 2] } },
        },
      });
      if (version > CURRENT_SETTINGS_VERSION) {
        expect(saved).toHaveProperty("host", "https://future.example.com");
      }
      expect(await loadSettings()).toEqual(saved);
    },
  );

  it.each(palettes)("persists system mode with %s through migration, save, and reload", async (palette) => {
    stored = {
      version: 5,
      theme: "light",
      exportDefaults: {
        ...createExportDefaults("md-only"),
        package: { editable: false, futurePackage: { retained: true } },
        conversion: { presetRules: [customRule], futureConversion: ["lorem"] },
      },
      customRules: [customRule],
      locale: "ru",
      requestTimeout: 12_345,
      futureSetting: { retained: true },
    };
    const previous = await loadSettings();

    const saved = await saveSettings({ theme: "system", palette });

    expect(saved).toEqual({ ...previous, theme: "system", palette });
    expect(saved.version).toBe(6);
    expect(stored).toEqual(saved);
    expect(await loadSettings()).toEqual(saved);
  });

  it("changes mode and palette independently without resetting the other preference", async () => {
    stored = { version: 5, theme: "dark", palette: "blue" };

    const modeChange = await saveSettings({ theme: "light" });
    expect(modeChange).toMatchObject({ theme: "light", palette: "blue" });
    const paletteChange = await saveSettings({ palette: "forest" });
    expect(paletteChange).toMatchObject({ theme: "light", palette: "forest" });
    expect(await loadSettings()).toEqual(paletteChange);
  });

  it("normalizes an invalid palette patch without losing system mode or forward fields", async () => {
    stored = {
      version: 99,
      theme: "system",
      palette: "amber",
      futureSetting: { retained: true },
    };

    const saved = await saveSettings({ palette: "invalid" } as unknown as Partial<AppSettings>);

    expect(saved).toMatchObject({
      version: 99,
      theme: "system",
      palette: "violet",
      futureSetting: { retained: true },
    });
    expect(await loadSettings()).toEqual(saved);
  });

  it("saves actual imported base and custom rules without injecting a template or losing options", async () => {
    const baseRule: ExtractionRule = {
      ...customRule,
      id: "lorem-imported-base",
      matcher: "table.base",
    };
    const defaults = createExportDefaults("tables-only");
    defaults.conversion.presetRules = [baseRule];

    const saved = await saveSettings({ exportDefaults: defaults, customRules: [customRule] });
    const loaded = await loadSettings();
    const converted = applyRules(
      '<table class="base"><tr><td>Lorem</td></tr></table>' +
        '<table class="supplemental"><tr><td>Ipsum</td></tr></table>' +
        "<table><tr><td>Not selected</td></tr></table>",
      [...loaded.exportDefaults.conversion.presetRules, ...loaded.customRules],
    );

    expect(saved.exportDefaults.conversion.presetRules).toEqual([baseRule]);
    expect(loaded.customRules).toEqual([customRule]);
    expect(converted.tables.map((table) => table.csv)).toEqual(["Lorem", "Ipsum"]);
  });
});
