import { DEFAULT_LOCALE_OVERRIDE, normalizeLocaleOverride } from "@/i18n";
import { isTheme, isThemePalette } from "@/lib/appearance";
import { storage } from "@/lib/browser";
import { DEFAULT_PRESET_ID, getExportTemplate, normalizePresetId } from "@/lib/rule-engine";
import type {
  AppLocaleOverride,
  AppSettings,
  ExportDefaults,
  ExportPresetId,
  Theme,
  ThemePalette,
} from "@/types";

const STORAGE_KEY = "cx.settings.v1";

/** Current schema version — bump when adding migrations below. */
export const CURRENT_SETTINGS_VERSION = 6;

export const LOCALE_OVERRIDES: AppLocaleOverride[] = ["auto", "ru", "en"];

export function createExportDefaults(presetId: ExportPresetId): ExportDefaults {
  const resources = presetId === "md-attachments";
  const companions = presetId !== "tables-only";
  return {
    presetId,
    package: {
      editable: companions,
      images: resources,
      attachments: resources,
      plantUmlAssets: resources,
      comments: companions,
      history: companions,
    },
    conversion: {
      includeFrontMatter: true,
      rewriteInternalLinks: true,
      deduplicateAssets: true,
      presetRules: structuredClone(getExportTemplate(presetId).rules),
    },
    maxDepth: null,
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  version: CURRENT_SETTINGS_VERSION,
  exportDefaults: createExportDefaults(DEFAULT_PRESET_ID),
  confluenceBaseUrl: undefined,
  concurrency: 3,
  requestTimeout: 30_000,
  maxRetries: 3,
  maxConcurrency: 5,
  maxAttachmentSize: 50 * 1024 * 1024,
  customRules: [],
  showConfluenceButton: true,
  showJiraButton: true,
  fontSize: 14,
  theme: "dark",
  palette: "violet",
  locale: DEFAULT_LOCALE_OVERRIDE,
};

export const FONT_SIZE_MIN = 11;
export const FONT_SIZE_MAX = 22;
export const FONT_SIZE_STEP = 1;

export function clampFontSize(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_SETTINGS.fontSize;
  return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, Math.round(v)));
}

// ---------------------------------------------------------------------------
// Migration engine
// ---------------------------------------------------------------------------

type Migration = (settings: Record<string, unknown>) => Record<string, unknown>;

/**
 * Ordered list of migrations. Index 0 migrates v0→v1, index 1 migrates v1→v2, etc.
 * To add a new migration:
 *   1. Bump CURRENT_SETTINGS_VERSION
 *   2. Append a migration function to this array
 *   3. The migration receives settings at version N and must return settings at version N+1
 */
const MIGRATIONS: readonly Migration[] = [
  // v0 → v1: Initial versioned schema. No structural changes — just adds `version` field.
  (settings) => settings,
  (settings) => ({ ...settings, locale: normalizeLocaleOverride(settings.locale) }),
  (settings) => ({ ...settings, activePresetId: normalizePresetId(settings.activePresetId) }),
  (settings) => ({ ...settings, showConfluenceButton: true, showJiraButton: true }),
  // v4 → v5: Explicit defaults, preserving the effective legacy conversion payload.
  (settings) => {
    const presetId = normalizePresetId(settings.activePresetId);
    const defaults = createExportDefaults(presetId);
    const attachments = settings.exportAttachments ?? true;
    return {
      ...settings,
      exportDefaults: {
        ...defaults,
        package: {
          ...defaults.package,
          editable: true,
          images: presetId === "md-attachments",
          attachments,
          plantUmlAssets: presetId === "md-attachments" && attachments,
          comments: settings.includeComments ?? true,
          history: settings.includeHistory ?? true,
        },
        conversion: {
          ...defaults.conversion,
          includeFrontMatter: settings.includeFrontMatter ?? true,
          rewriteInternalLinks: settings.rewriteInternalLinks ?? true,
          deduplicateAssets: settings.deduplicateImages ?? true,
          // Preserve the rules v4 actually applied, not the new template's package policy.
          presetRules:
            presetId === "tables-only"
              ? [
                  {
                    id: "tables-only-all-csv",
                    name: "Все таблицы → +CSV",
                    type: "selector",
                    matcher: "table.confluenceTable, div.table-wrap > table, table",
                    action: "to-csv",
                    enabled: true,
                    options: { removeAfterCsv: true },
                  },
                  {
                    id: "tables-only-content-skip",
                    name: "Нетабличный контент → пропустить",
                    type: "selector",
                    matcher: ".page-metadata, #breadcrumb-section, p, ul, ol, pre, blockquote",
                    action: "skip",
                    enabled: true,
                  },
                ]
              : defaults.conversion.presetRules,
        },
        maxDepth: null,
      },
    };
  },
  // v5 → v6: Independent appearance palette; keep the user's existing mode.
  (settings) => ({ ...settings, palette: normalizeThemePalette(settings.palette) }),
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTheme(value: unknown): Theme {
  return isTheme(value) ? value : DEFAULT_SETTINGS.theme;
}

function normalizeThemePalette(value: unknown): ThemePalette {
  return isThemePalette(value) ? value : DEFAULT_SETTINGS.palette;
}

const OBSOLETE_SETTINGS_KEYS: Readonly<Record<string, true>> = {
  host: true,
  outputFormat: true,
  skipUnchanged: true,
  maxDepth: true,
  activePresetId: true,
  includeFrontMatter: true,
  includeComments: true,
  includeHistory: true,
  rewriteInternalLinks: true,
  deduplicateImages: true,
  exportAttachments: true,
};

function stripUndefinedSettings(settings: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined));
}

function normalizeExportDefaults(value: unknown): ExportDefaults {
  const stored = isRecord(value) ? stripUndefinedSettings(value) : {};
  const presetId = normalizePresetId(stored.presetId);
  const defaults = createExportDefaults(presetId);
  return {
    ...defaults,
    ...stored,
    presetId,
    package: {
      ...defaults.package,
      ...(isRecord(stored.package) ? stripUndefinedSettings(stored.package) : {}),
    },
    conversion: {
      ...defaults.conversion,
      ...(isRecord(stored.conversion) ? stripUndefinedSettings(stored.conversion) : {}),
    },
  };
}

function normalizeSettings(settings: Record<string, unknown>): AppSettings {
  const definedSettings = stripUndefinedSettings(settings);
  const forwardVersion =
    typeof definedSettings.version === "number" &&
    definedSettings.version > CURRENT_SETTINGS_VERSION;
  const canonicalSettings = forwardVersion
    ? definedSettings
    : Object.fromEntries(
        Object.entries(definedSettings).filter(
          ([key]) => !Object.hasOwn(OBSOLETE_SETTINGS_KEYS, key),
        ),
      );

  return structuredClone({
    ...DEFAULT_SETTINGS,
    ...canonicalSettings,
    exportDefaults: normalizeExportDefaults(canonicalSettings.exportDefaults),
    theme: normalizeTheme(canonicalSettings.theme),
    palette: normalizeThemePalette(canonicalSettings.palette),
    locale: normalizeLocaleOverride(canonicalSettings.locale),
  });
}

/**
 * Migrates raw stored data to the current `AppSettings` schema.
 *
 * - If `raw` is `undefined` / `null` / not an object → returns defaults.
 * - If `raw` is a valid object but has no `version` → treated as v0, all migrations run.
 * - Current schemas normalize known fields and fill defaults while preserving unknown fields.
 * - Newer schemas also retain their version and unknown fields (forward-compatible).
 */
export function migrateSettings(raw: unknown): AppSettings {
  if (!isRecord(raw)) {
    return normalizeSettings({});
  }

  let settings = { ...raw };
  let version = typeof settings.version === "number" ? settings.version : 0;

  if (version > CURRENT_SETTINGS_VERSION) {
    // Preserve the newer version and unknown fields while normalizing known settings.
    return normalizeSettings(settings);
  }

  for (let i = version; i < MIGRATIONS.length; i++) {
    settings = MIGRATIONS[i](settings);
    version = i + 1;
  }

  settings = { ...settings, version: CURRENT_SETTINGS_VERSION };
  return normalizeSettings(settings);
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

export async function loadSettings(): Promise<AppSettings> {
  const { [STORAGE_KEY]: stored } = await storage.sync.get(STORAGE_KEY);
  return migrateSettings(stored);
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await loadSettings();
  const definedPatch = stripUndefinedSettings({ ...patch });
  const next = normalizeSettings({
    ...current,
    ...definedPatch,
    version: Math.max(
      current.version,
      CURRENT_SETTINGS_VERSION,
      typeof definedPatch.version === "number" ? definedPatch.version : 0,
    ),
    exportDefaults: {
      ...current.exportDefaults,
      ...patch.exportDefaults,
      package: {
        ...current.exportDefaults.package,
        ...patch.exportDefaults?.package,
      },
      conversion: {
        ...current.exportDefaults.conversion,
        ...patch.exportDefaults?.conversion,
      },
    },
  });
  await storage.sync.set({ [STORAGE_KEY]: next });
  return next;
}
