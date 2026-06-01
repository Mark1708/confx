import { Minus, Plus, RotateCcw, Settings2 } from "lucide-react";
import { isLocaleOverride } from "@/i18n";
import { BrowserApi } from "@/lib/browser/browser-api";
import {
  clampFontSize,
  DEFAULT_SETTINGS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  FONT_SIZE_STEP,
} from "@/lib/settings";
import { useCurrentTab } from "../hooks/useCurrentTab";
import { useI18n } from "../hooks/useI18n";
import { useSettings } from "../hooks/useSettings";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Separator } from "../ui/separator";
import { Switch } from "../ui/switch";

const LOCALE_OPTIONS = ["auto", "ru", "en"] as const;
const DETECTED_KIND_LABELS = {
  confluence: "settings.diagnostics.kinds.confluence",
  jira: "settings.diagnostics.kinds.jira",
  unknown: "settings.diagnostics.kinds.unknown",
} as const;

const DETECTION_SOURCE_LABELS = {
  meta: "settings.diagnostics.sources.meta",
  url: "settings.diagnostics.sources.url",
  none: "settings.diagnostics.sources.none",
} as const;

export function SettingsPanel() {
  const { data: settings, update } = useSettings();
  const tab = useCurrentTab();
  const { t } = useI18n();
  if (!settings) return null;

  const fontSize = clampFontSize(settings.fontSize);
  const setFontSize = (next: number) => update({ fontSize: clampFontSize(next) });
  const setLocale = (value: string) => {
    if (isLocaleOverride(value)) update({ locale: value });
  };

  return (
    <div className="min-w-0 space-y-3">
      <h2 className="text-sm font-semibold">{t("settings.title")}</h2>

      <div className="space-y-1 rounded-md border p-2">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-0.5">
            <Label className="block">{t("settings.fontSize.label")}</Label>
            <p className="text-[11px] leading-tight text-muted-foreground">
              {t("settings.fontSize.description", { min: FONT_SIZE_MIN, max: FONT_SIZE_MAX })}
            </p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-0.5 panel:gap-1">
            <Button
              variant="outline"
              size="icon"
              onClick={() => setFontSize(fontSize - FONT_SIZE_STEP)}
              disabled={fontSize <= FONT_SIZE_MIN}
              aria-label={t("settings.fontSize.decrease")}
            >
              <Minus className="h-3 w-3" />
            </Button>
            <span className="w-9 text-center text-xs font-mono tabular-nums panel:w-10 panel:text-sm">
              {fontSize}px
            </span>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setFontSize(fontSize + FONT_SIZE_STEP)}
              disabled={fontSize >= FONT_SIZE_MAX}
              aria-label={t("settings.fontSize.increase")}
            >
              <Plus className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setFontSize(DEFAULT_SETTINGS.fontSize)}
              aria-label={t("settings.fontSize.reset")}
              title={t("settings.fontSize.resetTitle")}
            >
              <RotateCcw className="h-3 w-3" />
            </Button>
          </div>
        </div>
        <input
          type="range"
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={FONT_SIZE_STEP}
          value={fontSize}
          onChange={(e) => setFontSize(Number(e.target.value))}
          className="mt-2 h-2 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
        />
      </div>

      <Separator />

      <div className="space-y-1">
        <Label>{t("settings.language.label")}</Label>
        <Select value={settings.locale} onValueChange={setLocale}>
          <SelectTrigger aria-label={t("settings.language.label")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LOCALE_OPTIONS.map((locale) => (
              <SelectItem key={locale} value={locale}>
                {t(`settings.language.${locale}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Separator />

      <Toggle
        label={t("settings.toggles.frontMatter.label")}
        description={t("settings.toggles.frontMatter.description")}
        checked={settings.includeFrontMatter}
        onChange={(v) => update({ includeFrontMatter: v })}
      />
      <Toggle
        label={t("settings.toggles.rewriteInternalLinks.label")}
        description={t("settings.toggles.rewriteInternalLinks.description")}
        checked={settings.rewriteInternalLinks}
        onChange={(v) => update({ rewriteInternalLinks: v })}
      />
      <Toggle
        label={t("settings.toggles.deduplicateImages.label")}
        description={t("settings.toggles.deduplicateImages.description")}
        checked={settings.deduplicateImages}
        onChange={(v) => update({ deduplicateImages: v })}
      />
      <Toggle
        label={t("settings.toggles.showConfluenceButton.label")}
        description={t("settings.toggles.showConfluenceButton.description")}
        checked={settings.showConfluenceButton}
        onChange={(v) => update({ showConfluenceButton: v })}
      />
      <Toggle
        label={t("settings.toggles.showJiraButton.label")}
        description={t("settings.toggles.showJiraButton.description")}
        checked={settings.showJiraButton}
        onChange={(v) => update({ showJiraButton: v })}
      />

      <Separator />

      <Card>
        <CardHeader>
          <CardTitle>{t("settings.diagnostics.title")}</CardTitle>
          <CardDescription>{t("settings.diagnostics.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          {!tab.diagnostics ? (
            <div className="text-muted-foreground">{t("settings.diagnostics.empty")}</div>
          ) : (
            <>
              <DiagnosticRow
                label={t("settings.diagnostics.kind")}
                value={t(DETECTED_KIND_LABELS[tab.diagnostics.detectedKind])}
              />
              <DiagnosticRow
                label={t("settings.diagnostics.host")}
                value={tab.diagnostics.host ?? t("settings.diagnostics.none")}
              />
              <DiagnosticRow
                label={t("settings.diagnostics.pageId")}
                value={tab.diagnostics.pageId ?? t("settings.diagnostics.none")}
              />
              <DiagnosticRow
                label={t("settings.diagnostics.issueKey")}
                value={tab.diagnostics.issueKey ?? t("settings.diagnostics.none")}
              />
              <DiagnosticRow
                label={t("settings.diagnostics.source")}
                value={t(DETECTION_SOURCE_LABELS[tab.diagnostics.detectionSource])}
              />
              <DiagnosticRow
                label={t("settings.diagnostics.reason")}
                value={tab.diagnostics.detectionReason}
              />
              <DiagnosticRow
                label={t("settings.diagnostics.confluenceButton")}
                value={formatVisibilityState(
                  t,
                  tab.diagnostics.buttonVisibility.confluence.enabled,
                  tab.diagnostics.buttonVisibility.confluence.visible,
                )}
              />
              <DiagnosticRow
                label={t("settings.diagnostics.jiraButton")}
                value={formatVisibilityState(
                  t,
                  tab.diagnostics.buttonVisibility.jira.enabled,
                  tab.diagnostics.buttonVisibility.jira.visible,
                )}
              />
            </>
          )}
        </CardContent>
      </Card>

      <Separator />

      <div className="space-y-1">
        <Label>{t("settings.concurrency")}</Label>
        <Input
          type="number"
          min={1}
          max={10}
          value={settings.concurrency}
          onChange={(e) => update({ concurrency: Number(e.target.value) || 1 })}
        />
      </div>

      <Separator />

      <Button
        variant="outline"
        className="w-full"
        onClick={() => void BrowserApi.openOptionsPage()}
      >
        <Settings2 className="h-4 w-4" />
        {t("settings.ruleEditor")}
      </Button>
    </div>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-2 rounded-md border p-2">
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label className="block">{label}</Label>
        {description && (
          <p className="text-[11px] leading-tight text-muted-foreground">{description}</p>
        )}
      </div>
      <Switch className="ml-auto shrink-0" checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function DiagnosticRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-3 rounded-md border p-2">
      <div className="min-w-0 text-muted-foreground">{label}</div>
      <div className="min-w-0 text-right font-medium text-foreground">{value}</div>
    </div>
  );
}

function formatVisibilityState(
  t: ReturnType<typeof useI18n>["t"],
  enabled: boolean,
  visible: boolean,
): string {
  const enabledLabel = enabled
    ? t("settings.diagnostics.enabled")
    : t("settings.diagnostics.disabled");
  const visibleLabel = visible
    ? t("settings.diagnostics.visible")
    : t("settings.diagnostics.hidden");
  return `${enabledLabel} · ${visibleLabel}`;
}
