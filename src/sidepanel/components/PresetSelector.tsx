import type { I18nKey, Translator } from "@/i18n";
import { PRESETS } from "@/lib/rule-engine";
import type { RulePreset } from "@/types";
import { useI18n } from "../hooks/useI18n";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

interface Props {
  value: string;
  onChange: (id: string) => void;
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

export function PresetSelector({ value, onChange }: Props) {
  const { t } = useI18n();
  const active = PRESETS.find((p) => p.id === value) ?? PRESETS[0];
  return (
    <div className="space-y-1">
      <Label>{t("presets.label")}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PRESETS.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {getPresetName(t, p)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-[11px] leading-tight text-muted-foreground">
        {getPresetDescription(t, active)}
      </p>
    </div>
  );
}
