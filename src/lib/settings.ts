import { DEFAULT_LOCALE_OVERRIDE, normalizeLocaleOverride } from "@/i18n";
import { storage } from "@/lib/browser";
import { DEFAULT_PRESET_ID } from "@/lib/rule-engine";
import type { AppLocaleOverride, AppSettings, Theme } from "@/types";

const STORAGE_KEY = "cx.settings.v1";

/** Current schema version — bump when adding migrations below. */
export const CURRENT_SETTINGS_VERSION = 4;

export const THEMES: Theme[] = ["dark", "light"];
export const LOCALE_OVERRIDES: AppLocaleOverride[] = ["auto", "ru", "en"];

export const THEME_LABELS: Record<Theme, string> = {
  dark: "Тёмная",
  light: "Светлая",
};

export const DEFAULT_SETTINGS: AppSettings = {
  version: CURRENT_SETTINGS_VERSION,
  host: "",
  confluenceBaseUrl: undefined,
  outputFormat: "md-csv-images",
  concurrency: 3,
  requestTimeout: 30_000,
  maxRetries: 3,
  maxConcurrency: 5,
  includeFrontMatter: true,
  includeComments: true,
  includeHistory: true,
  rewriteInternalLinks: true,
  deduplicateImages: true,
  exportAttachments: true,
  maxAttachmentSize: 50 * 1024 * 1024,
  skipUnchanged: false,
  maxDepth: 10,
  activePresetId: DEFAULT_PRESET_ID,
  customRules: [],
  showConfluenceButton: true,
  showJiraButton: true,
  fontSize: 14,
  theme: "dark",
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
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTheme(value: unknown): Theme {
  return value === "light" || value === "dark" ? value : DEFAULT_SETTINGS.theme;
}

function normalizePresetId(value: unknown): string {
  if (value === "generic") return "md-only";
  if (value === "md-only" || value === "md-attachments" || value === "tables-only") return value;
  return DEFAULT_SETTINGS.activePresetId;
}

function stripUndefinedSettings(settings: Partial<AppSettings>): Partial<AppSettings> {
  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) => value !== undefined),
  ) as Partial<AppSettings>;
}

function normalizeSettings(settings: Partial<AppSettings>): AppSettings {
  const definedSettings = stripUndefinedSettings(settings);

  return {
    ...DEFAULT_SETTINGS,
    ...definedSettings,
    theme: normalizeTheme(definedSettings.theme),
    locale: normalizeLocaleOverride(definedSettings.locale),
    activePresetId: normalizePresetId(definedSettings.activePresetId),
  };
}

/**
 * Migrates raw stored data to the current `AppSettings` schema.
 *
 * - If `raw` is `undefined` / `null` / not an object → returns defaults.
 * - If `raw` is a valid object but has no `version` → treated as v0, all migrations run.
 * - If `raw.version` equals `CURRENT_SETTINGS_VERSION` → returned as-is (merged with defaults).
 * - If `raw.version` is newer than current → returned as-is (forward-compatible).
 */
export function migrateSettings(raw: unknown): AppSettings {
  if (!isRecord(raw)) {
    return { ...DEFAULT_SETTINGS };
  }

  let settings = { ...raw };
  let version = typeof settings.version === "number" ? settings.version : 0;

  if (version > CURRENT_SETTINGS_VERSION) {
    // Forward-compatible: newer schema, preserve as-is
    return normalizeSettings(settings as Partial<AppSettings>);
  }

  for (let i = version; i < MIGRATIONS.length; i++) {
    settings = MIGRATIONS[i](settings);
    version = i + 1;
  }

  settings = { ...settings, version: CURRENT_SETTINGS_VERSION };
  return normalizeSettings(settings as Partial<AppSettings>);
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
  const next: AppSettings = normalizeSettings({
    ...current,
    ...patch,
    version: CURRENT_SETTINGS_VERSION,
  });
  await storage.sync.set({ [STORAGE_KEY]: next });
  return next;
}
