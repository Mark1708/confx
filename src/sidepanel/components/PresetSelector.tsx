import { useId } from "react";
import type { I18nKey, Translator } from "@/i18n";
import { getExportTemplate, normalizePresetId, PRESETS } from "@/lib/rule-engine";
import { createExportDefaults } from "@/lib/settings";
import type { ExportDefaults, RulePreset } from "@/types";
import { useI18n } from "../hooks/useI18n";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";

interface Props {
  value: ExportDefaults;
  onChange: (defaults: ExportDefaults) => void;
  onSaveDefaults: () => Promise<void>;
  savingDefaults: boolean;
  defaultsError: string | null;
  disabled?: boolean;
  allowEditable?: boolean;
  unavailablePackage?: readonly (keyof ExportDefaults["package"])[];
  unavailableConversion?: readonly (keyof Omit<ExportDefaults["conversion"], "presetRules">)[];
  showDepth?: boolean;
  packageNote?: string;
}

const PRESET_NAME_KEYS: Readonly<Record<string, I18nKey>> = {
  "md-attachments": "presets.names.mdAttachments",
  "md-only": "presets.names.mdOnly",
  "tables-only": "presets.names.tablesOnly",
};

const PRESET_DESCRIPTION_KEYS: Readonly<Record<string, I18nKey>> = {
  "md-attachments": "presets.descriptions.mdAttachments",
  "md-only": "presets.descriptions.mdOnly",
  "tables-only": "presets.descriptions.tablesOnly",
};

const PRESET_RULE_NAME_KEYS: Readonly<Record<string, I18nKey>> = {
  "all-tables-csv": "presets.ruleNames.allTablesCsv",
  "navigation-chrome-skip": "presets.ruleNames.navigationChromeSkip",
  "tables-only-all-csv": "presets.ruleNames.tablesOnlyAllCsv",
  "tables-only-content-skip": "presets.ruleNames.tablesOnlyContentSkip",
  "api-endpoint-tables-csv": "presets.ruleNames.apiEndpointTablesCsv",
  "api-code-blocks-keep-html": "presets.ruleNames.apiCodeBlocksKeepHtml",
};

export function getPresetName(t: Translator<I18nKey>, preset: RulePreset): string {
  const key = PRESET_NAME_KEYS[preset.id];
  return key ? t(key) : preset.name;
}

export function getPresetDescription(t: Translator<I18nKey>, preset: RulePreset): string {
  const key = PRESET_DESCRIPTION_KEYS[preset.id];
  return key ? t(key) : preset.description;
}

export function getPresetRuleName(
  t: Translator<I18nKey>,
  ruleId: string,
  fallback: string,
): string {
  const key = PRESET_RULE_NAME_KEYS[ruleId];
  return key ? t(key) : fallback;
}

export function PresetSelector({
  value,
  onChange,
  onSaveDefaults,
  savingDefaults,
  defaultsError,
  disabled = false,
  allowEditable = true,
  unavailablePackage = [],
  unavailableConversion = [],
  showDepth = true,
  packageNote,
}: Props) {
  const { t } = useI18n();
  const active = getExportTemplate(value.presetId);
  return (
    <div className="space-y-2">
      <Label>{t("presets.label")}</Label>
      <Select
        value={value.presetId}
        disabled={disabled}
        onValueChange={(id) => onChange(createExportDefaults(normalizePresetId(id)))}
      >
        <SelectTrigger aria-label={t("presets.label")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PRESETS.map((preset) => (
            <SelectItem key={preset.id} value={preset.id}>
              {getPresetName(t, preset)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-[11px] leading-tight text-muted-foreground">
        {getPresetDescription(t, active)}
      </p>
      <ExportDefaultsFields
        value={value}
        onChange={onChange}
        disabled={disabled}
        allowEditable={allowEditable}
        unavailablePackage={unavailablePackage}
        unavailableConversion={unavailableConversion}
        showDepth={showDepth}
        packageNote={packageNote}
      />
      <div className="space-y-2 border-t pt-2">
        <p className="text-[11px] text-muted-foreground">{t("presets.runOptionsDescription")}</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || savingDefaults}
          onClick={() => void onSaveDefaults()}
        >
          {t(savingDefaults ? "presets.savingDefaults" : "presets.saveDefaults")}
        </Button>
        {defaultsError && (
          <p role="alert" className="break-words text-xs text-destructive">
            {defaultsError}
          </p>
        )}
      </div>
    </div>
  );
}

const PACKAGE_FIELDS = [
  { key: "editable", label: "options.package.editable" },
  { key: "images", label: "options.package.images" },
  { key: "attachments", label: "options.package.attachments" },
  { key: "plantUmlAssets", label: "options.package.plantUmlAssets" },
  { key: "comments", label: "options.package.comments" },
  { key: "history", label: "options.package.history" },
] as const;

const CONVERSION_FIELDS = [
  { key: "includeFrontMatter", label: "options.general.frontMatter" },
  { key: "rewriteInternalLinks", label: "options.general.rewriteInternalLinks" },
  { key: "deduplicateAssets", label: "options.general.deduplicateImages" },
] as const;

export function ExportDefaultsFields({
  value,
  onChange,
  disabled = false,
  allowEditable = true,
  unavailablePackage = [],
  unavailableConversion = [],
  showDepth = true,
  packageNote,
}: Pick<
  Props,
  | "value"
  | "onChange"
  | "disabled"
  | "allowEditable"
  | "unavailablePackage"
  | "unavailableConversion"
  | "showDepth"
  | "packageNote"
>) {
  const { t } = useI18n();
  const id = useId();
  const tablesOnly = value.presetId === "tables-only";
  const resourcesDisabled = value.presetId !== "md-attachments";

  return (
    <div className="space-y-2">
      {PACKAGE_FIELDS.map((field) => {
        const resource =
          field.key === "images" || field.key === "attachments" || field.key === "plantUmlAssets";
        const unavailable =
          tablesOnly ||
          (resource && resourcesDisabled) ||
          (field.key === "editable" && !allowEditable) ||
          unavailablePackage.includes(field.key);
        const fieldId = `${id}-${field.key}`;
        return (
          <div key={field.key} className="flex min-w-0 items-center justify-between gap-2">
            <Label htmlFor={fieldId}>{t(field.label)}</Label>
            <Switch
              id={fieldId}
              checked={!unavailable && value.package[field.key]}
              disabled={disabled || unavailable}
              onCheckedChange={(checked) =>
                onChange({
                  ...value,
                  package: { ...value.package, [field.key]: checked },
                })
              }
            />
          </div>
        );
      })}
      {(tablesOnly || resourcesDisabled || !allowEditable) && (
        <p className="text-[11px] text-muted-foreground">
          {tablesOnly
            ? t("options.package.tablesOnlyDisabled")
            : resourcesDisabled
              ? t("options.package.resourcesDisabled")
              : null}
          {!tablesOnly && !allowEditable && ` ${t("options.package.editableUnavailable")}`}
        </p>
      )}
      {packageNote && <p className="text-[11px] text-muted-foreground">{packageNote}</p>}
      <details className="rounded-md border p-2">
        <summary className="cursor-pointer text-xs font-medium">{t("composer.conversion")}</summary>
        <div className="mt-2 space-y-2">
          {CONVERSION_FIELDS.map((field) => {
            const fieldId = `${id}-${field.key}`;
            const unavailable = tablesOnly || unavailableConversion.includes(field.key);
            return (
              <div key={field.key} className="flex items-center justify-between gap-2">
                <Label htmlFor={fieldId}>{t(field.label)}</Label>
                <Switch
                  id={fieldId}
                  checked={!unavailable && value.conversion[field.key]}
                  disabled={disabled || unavailable}
                  onCheckedChange={(checked) =>
                    onChange({
                      ...value,
                      conversion: { ...value.conversion, [field.key]: checked },
                    })
                  }
                />
              </div>
            );
          })}
        </div>
      </details>
      {showDepth && (
        <div className="space-y-1">
          <Label htmlFor={`${id}-depth`}>{t("options.general.maxDepth")}</Label>
          <Input
            id={`${id}-depth`}
            type="number"
            min={0}
            step={1}
            value={value.maxDepth ?? ""}
            placeholder={t("options.general.unlimitedDepth")}
            disabled={disabled}
            onChange={(event) => {
              const input = event.currentTarget;
              if (input.value === "") {
                onChange({ ...value, maxDepth: null });
              } else if (Number.isFinite(input.valueAsNumber)) {
                onChange({ ...value, maxDepth: Math.max(0, Math.floor(input.valueAsNumber)) });
              }
            }}
          />
        </div>
      )}
    </div>
  );
}
