import { Minus, Plus, RotateCcw } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { isLocaleOverride } from "@/i18n";
import {
  type ResolvedTheme,
  resolveTheme,
  THEME_MODES,
  THEME_PALETTES,
  watchSystemTheme,
} from "@/lib/appearance";
import {
  clampFontSize,
  DEFAULT_SETTINGS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  FONT_SIZE_STEP,
} from "@/lib/settings";
import type { AppSettings, ThemePalette } from "@/types";
import { useI18n } from "../../sidepanel/hooks/useI18n";
import { useSettings } from "../../sidepanel/hooks/useSettings";
import { Button } from "../../sidepanel/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../sidepanel/ui/card";
import { Label } from "../../sidepanel/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../sidepanel/ui/select";

type AppearancePatch = Partial<Pick<AppSettings, "theme" | "palette">>;

interface AppearanceChoicesProps {
  settings: AppSettings;
  saving: boolean;
  updateAsync: (patch: Partial<AppSettings>) => Promise<AppSettings>;
}

function AppearanceMiniature({ theme, palette }: { theme: ResolvedTheme; palette: ThemePalette }) {
  return (
    <span
      className="cx-appearance-preview"
      aria-hidden="true"
      data-confx-appearance=""
      data-theme={theme}
      data-palette={palette}
    >
      <span className="cx-appearance-preview-sidebar">
        <span className="cx-appearance-preview-brand" />
        <span className="cx-appearance-preview-nav" />
        <span className="cx-appearance-preview-nav" />
      </span>
      <span className="cx-appearance-preview-main">
        <span className="cx-appearance-preview-header">
          <span className="cx-appearance-preview-line" />
        </span>
        <span className="cx-appearance-preview-content">
          <span className="cx-appearance-preview-line" />
          <span className="cx-appearance-preview-line" />
          <span className="cx-appearance-preview-action" />
        </span>
      </span>
    </span>
  );
}

function AppearanceChoices({ settings, saving, updateAsync }: AppearanceChoicesProps) {
  const { t } = useI18n();
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>("light");
  const [pendingChoice, setPendingChoice] = useState<AppearancePatch | null>(null);
  const [saveError, setSaveError] = useState(false);
  const focusAfterSave = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(() => watchSystemTheme(setSystemTheme), []);

  const theme = pendingChoice?.theme ?? settings.theme;
  const palette = pendingChoice?.palette ?? settings.palette;
  const resolvedTheme = resolveTheme(theme, systemTheme === "dark");
  const pending = saving || pendingChoice !== null;

  useLayoutEffect(() => {
    if (pending) return;
    const input = focusAfterSave.current;
    focusAfterSave.current = null;
    if (input?.isConnected && document.activeElement === document.body) {
      input.focus({ preventScroll: true });
    }
  }, [pending]);

  const changeAppearance = (patch: AppearancePatch, input: HTMLInputElement) => {
    if (pending) return;
    focusAfterSave.current = document.activeElement === input ? input : null;
    setSaveError(false);
    // Give the controlled radios a real checked-state transition to roll back on rejection.
    setPendingChoice(patch);
    void updateAsync(patch)
      .catch(() => setSaveError(true))
      .finally(() => setPendingChoice(null));
  };

  return (
    <>
      <fieldset className="cx-appearance-fieldset" disabled={pending}>
        <legend>{t("settings.theme.label")}</legend>
        <div className="cx-appearance-mode-grid">
          {THEME_MODES.map((mode) => (
            <label key={mode} className="cx-appearance-choice">
              <input
                type="radio"
                name="cx-theme"
                value={mode}
                checked={theme === mode}
                onChange={(event) => changeAppearance({ theme: mode }, event.currentTarget)}
                className="sr-only"
              />
              <span className="cx-appearance-choice-card">
                <AppearanceMiniature
                  theme={resolveTheme(mode, systemTheme === "dark")}
                  palette={palette}
                />
                <span className="cx-appearance-choice-caption">
                  <span className="cx-appearance-choice-marker" aria-hidden="true" />
                  <span>{t(`settings.theme.${mode}`)}</span>
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="cx-appearance-fieldset" disabled={pending}>
        <legend>{t("settings.palette.label")}</legend>
        <div className="cx-appearance-palette-grid">
          {THEME_PALETTES.map((choice) => (
            <label key={choice} className="cx-appearance-choice">
              <input
                type="radio"
                name="cx-palette"
                value={choice}
                checked={palette === choice}
                onChange={(event) => changeAppearance({ palette: choice }, event.currentTarget)}
                className="sr-only"
              />
              <span className="cx-appearance-choice-card">
                <AppearanceMiniature theme={resolvedTheme} palette={choice} />
                <span className="cx-appearance-choice-caption">
                  <span className="cx-appearance-choice-marker" aria-hidden="true" />
                  <span>{t(`settings.palette.${choice}`)}</span>
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {saveError ? (
        <p role="alert" className="cx-options-feedback cx-options-feedback-error">
          {t("settings.appearance.saveError")}
        </p>
      ) : null}
    </>
  );
}

export function AppearanceSettings() {
  const { data: settings, update, updateAsync, saving } = useSettings();
  const { t } = useI18n();
  if (!settings) return null;
  const fontSize = clampFontSize(settings.fontSize);
  const setFontSize = (value: number) => update({ fontSize: clampFontSize(value) });
  return (
    <section id="appearance" className="cx-options-section">
      <Card className="cx-options-card">
        <CardHeader className="cx-options-card-header">
          <CardTitle>{t("options.sections.appearance")}</CardTitle>
          <CardDescription>{t("options.sections.appearanceDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="cx-options-card-content cx-options-settings-stack">
          <div className="space-y-1">
            <Label>{t("settings.language.label")}</Label>
            <Select
              value={settings.locale}
              onValueChange={(value) => {
                if (isLocaleOverride(value)) update({ locale: value });
              }}
            >
              <SelectTrigger aria-label={t("settings.language.label")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["auto", "ru", "en"] as const).map((locale) => (
                  <SelectItem key={locale} value={locale}>
                    {t(`settings.language.${locale}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <AppearanceChoices settings={settings} saving={saving} updateAsync={updateAsync} />
          <div className="space-y-2">
            <Label htmlFor="options-font-size">{t("settings.fontSize.label")}</Label>
            <p className="cx-options-panel-copy">
              {t("settings.fontSize.description", { min: FONT_SIZE_MIN, max: FONT_SIZE_MAX })}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => setFontSize(fontSize - FONT_SIZE_STEP)}
                disabled={fontSize <= FONT_SIZE_MIN}
                aria-label={t("settings.fontSize.decrease")}
              >
                <Minus className="h-3 w-3" />
              </Button>
              <output htmlFor="options-font-size" className="text-xs tabular-nums">
                {fontSize}px
              </output>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => setFontSize(fontSize + FONT_SIZE_STEP)}
                disabled={fontSize >= FONT_SIZE_MAX}
                aria-label={t("settings.fontSize.increase")}
              >
                <Plus className="h-3 w-3" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setFontSize(DEFAULT_SETTINGS.fontSize)}
                aria-label={t("settings.fontSize.resetTitle")}
              >
                <RotateCcw className="h-3 w-3" />
                {t("settings.fontSize.reset")}
              </Button>
            </div>
            <input
              id="options-font-size"
              type="range"
              min={FONT_SIZE_MIN}
              max={FONT_SIZE_MAX}
              step={FONT_SIZE_STEP}
              value={fontSize}
              onChange={(event) => setFontSize(Number(event.target.value))}
              className="w-full accent-primary"
            />
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
