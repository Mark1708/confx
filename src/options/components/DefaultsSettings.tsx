import { getExportTemplate, normalizePresetId, PRESETS } from "@/lib/rule-engine";
import { createExportDefaults } from "@/lib/settings";
import {
  ExportDefaultsFields,
  getPresetDescription,
  getPresetName,
  getPresetRuleName,
} from "../../sidepanel/components/PresetSelector";
import { useI18n } from "../../sidepanel/hooks/useI18n";
import { useSettings } from "../../sidepanel/hooks/useSettings";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../sidepanel/ui/card";
import { Label } from "../../sidepanel/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../sidepanel/ui/select";

export function DefaultsSettings() {
  const { data: settings, update } = useSettings();
  const { t } = useI18n();
  if (!settings) return null;
  const template = getExportTemplate(settings.exportDefaults.presetId);
  const rules = settings.exportDefaults.conversion.presetRules;
  return (
    <section id="defaults" className="cx-options-section">
      <Card className="cx-options-card">
        <CardHeader className="cx-options-card-header">
          <CardTitle>{t("options.sections.defaults")}</CardTitle>
          <CardDescription>{t("options.preset.description")}</CardDescription>
        </CardHeader>
        <CardContent className="cx-options-card-content cx-options-settings-stack">
          <Label>{t("presets.label")}</Label>
          <Select
            value={settings.exportDefaults.presetId}
            onValueChange={(id) =>
              update({ exportDefaults: createExportDefaults(normalizePresetId(id)) })
            }
          >
            <SelectTrigger aria-label={t("options.preset.title")}>
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
          <p className="cx-options-panel-copy">{getPresetDescription(t, template)}</p>
          <ExportDefaultsFields
            value={settings.exportDefaults}
            onChange={(exportDefaults) => update({ exportDefaults })}
          />
          <details className="rounded-md border p-2">
            <summary className="cursor-pointer text-xs font-medium">
              {t("composer.rulesSummary", {
                base: rules.length,
                custom: settings.customRules.length,
              })}
            </summary>
            {rules.length > 0 ? (
              <ul className="cx-options-rule-list mt-2">
                {rules.map((rule) => (
                  <li key={rule.id}>
                    <span>{getPresetRuleName(t, rule.id, rule.name)}</span>
                    <code>
                      {rule.type} → {rule.action}
                    </code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="cx-options-panel-copy mt-2">{t("options.preset.noRules")}</p>
            )}
          </details>
        </CardContent>
      </Card>
    </section>
  );
}
