import { CheckCircle2, Download, FileJson, Plus, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { I18nKey, InterpolationValues } from "@/i18n";
import { exportRules, getExportTemplate, importRules, normalizePresetId } from "@/lib/rule-engine";
import type { ExtractionRule, RuleAction, RulePreset, RuleType } from "@/types";
import { getPresetName } from "../../sidepanel/components/PresetSelector";
import { useI18n } from "../../sidepanel/hooks/useI18n";
import { useSettings } from "../../sidepanel/hooks/useSettings";
import { Button } from "../../sidepanel/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../sidepanel/ui/card";
import { Input } from "../../sidepanel/ui/input";
import { Label } from "../../sidepanel/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../sidepanel/ui/select";
import { Separator } from "../../sidepanel/ui/separator";
import { Switch } from "../../sidepanel/ui/switch";

const RULE_TYPES: RuleType[] = ["selector", "table", "section", "spoiler"];
const RULE_ACTIONS: RuleAction[] = [
  "skip",
  "to-csv",
  "to-md",
  "gfm-table",
  "extract-images",
  "keep-html",
];

const MAX_RETRIES_MIN = 1;
const MAX_RETRIES_MAX = 10;
const REQUEST_TIMEOUT_SECONDS_MIN = 5;
const REQUEST_TIMEOUT_SECONDS_MAX = 120;
const MAX_CONCURRENCY_MIN = 1;
const MAX_CONCURRENCY_MAX = 20;

type FeedbackTone = "success" | "error" | "info";

interface ImportExportFeedback {
  tone: FeedbackTone;
  message?: string;
  messageKey?: I18nKey;
  messageValues?: InterpolationValues;
}

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function makeId(): string {
  return `rule_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function emptyRule(name: string): ExtractionRule {
  return {
    id: makeId(),
    name,
    type: "selector",
    matcher: "",
    action: "to-md",
    enabled: true,
  };
}

function isRuleType(value: string): value is RuleType {
  return RULE_TYPES.some((type) => type === value);
}

function isRuleAction(value: string): value is RuleAction {
  return RULE_ACTIONS.some((action) => action === value);
}

export function AdvancedSettings() {
  const { data: settings, update, updateAsync } = useSettings();
  const { t } = useI18n();
  const importInputRef = useRef<HTMLInputElement>(null);
  const defaultRuleName = t("options.rules.defaultName");
  const previousDefaultRuleNameRef = useRef(defaultRuleName);
  const [draft, setDraft] = useState<ExtractionRule>(() => emptyRule(defaultRuleName));
  const [transferFeedback, setTransferFeedback] = useState<ImportExportFeedback>({
    tone: "info",
    messageKey: "options.feedback.ready",
  });
  const rules = useMemo(() => settings?.customRules ?? [], [settings]);
  const activePreset: RulePreset = settings
    ? {
        ...getExportTemplate(settings.exportDefaults.presetId),
        rules: settings.exportDefaults.conversion.presetRules,
      }
    : getExportTemplate("md-attachments");

  useEffect(() => {
    const previousDefaultRuleName = previousDefaultRuleNameRef.current;
    if (previousDefaultRuleName === defaultRuleName) return;

    previousDefaultRuleNameRef.current = defaultRuleName;
    setDraft((current) =>
      current.name === previousDefaultRuleName ? { ...current, name: defaultRuleName } : current,
    );
  }, [defaultRuleName]);

  if (!settings) return null;

  const addRule = () => {
    update({ customRules: [...rules, { ...draft, id: makeId() }] });
    setDraft(emptyRule(t("options.rules.defaultName")));
  };
  const removeRule = (id: string) => update({ customRules: rules.filter((r) => r.id !== id) });
  const patchRule = (id: string, patch: Partial<ExtractionRule>) =>
    update({ customRules: rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) });

  const exportCurrentRules = () => {
    const json = exportRules(activePreset, rules);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    link.href = url;
    link.download = `rules-${settings.exportDefaults.presetId}-${timestamp}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setTransferFeedback({ tone: "success", messageKey: "options.feedback.exportStarted" });
  };

  const importCurrentRules = (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onerror = () => {
      const message = t("options.importErrors.readFailed");
      setTransferFeedback({ tone: "error", message });
      alert(message);
      input.value = "";
    };
    reader.onload = async () => {
      try {
        if (typeof reader.result !== "string") {
          throw new Error(t("options.importErrors.textJsonRequired"));
        }
        const result = importRules(reader.result);
        await updateAsync({
          customRules: result.customRules,
          exportDefaults: {
            ...settings.exportDefaults,
            presetId: normalizePresetId(result.preset.id),
            conversion: {
              ...settings.exportDefaults.conversion,
              presetRules: result.preset.rules,
            },
          },
        });
        setTransferFeedback({
          tone: "success",
          message: t("options.feedback.imported", {
            count: result.customRules.length,
            preset: getPresetName(t, result.preset),
          }),
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : t("options.importErrors.importFailed");
        setTransferFeedback({ tone: "error", message });
        alert(message);
      } finally {
        input.value = "";
      }
    };
    reader.readAsText(file);
  };

  return (
    <section id="advanced" className="cx-options-section">
      <details className="cx-options-advanced">
        <summary>{t("options.sections.advanced")}</summary>
        <p className="cx-options-panel-copy">{t("options.sections.advancedDescription")}</p>
        <div className="cx-options-settings-stack">
          <section id="rules" className="cx-options-section">
            <Card className="cx-options-card">
              <CardHeader className="cx-options-card-header">
                <div className="cx-options-title-row">
                  <FileJson className="h-4 w-4" />
                  <div>
                    <CardTitle>{t("options.rules.title")}</CardTitle>
                    <CardDescription>{t("options.rules.description")}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="cx-options-card-content">
                <div className="cx-options-rules-stack">
                  {rules.length === 0 && (
                    <p className="cx-options-empty">{t("options.rules.empty")}</p>
                  )}
                  {rules.map((r) => (
                    <RuleRow key={r.id} rule={r} onPatch={patchRule} onRemove={removeRule} />
                  ))}
                </div>

                <Separator className="cx-options-separator" />

                <div className="cx-options-editor-panel">
                  <div>
                    <Label className="cx-options-panel-title">{t("options.rules.newRule")}</Label>
                    <p className="cx-options-panel-copy">{t("options.rules.newRuleDescription")}</p>
                  </div>
                  <div className="cx-options-new-rule-grid">
                    <Input
                      placeholder={t("options.rules.matcherPlaceholder")}
                      value={draft.matcher}
                      aria-label={t("options.rules.matcherPlaceholder")}
                      onChange={(e) => setDraft({ ...draft, matcher: e.target.value })}
                    />
                    <Select
                      value={draft.type}
                      onValueChange={(v) => isRuleType(v) && setDraft({ ...draft, type: v })}
                    >
                      <SelectTrigger aria-label={t("options.rules.type")}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {RULE_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={draft.action}
                      onValueChange={(v) => isRuleAction(v) && setDraft({ ...draft, action: v })}
                    >
                      <SelectTrigger aria-label={t("options.rules.action")}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {RULE_ACTIONS.map((a) => (
                          <SelectItem key={a} value={a}>
                            {a}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button variant="accent" onClick={addRule} disabled={!draft.matcher}>
                      <Plus className="h-4 w-4" />
                      {t("options.rules.add")}
                    </Button>
                  </div>
                </div>

                <div className="cx-options-transfer-panel">
                  <div className="cx-options-transfer-copy">
                    <FileJson className="h-4 w-4" />
                    <div>
                      <Label className="cx-options-panel-title">
                        {t("options.rules.importExport")}
                      </Label>
                      <p className="cx-options-panel-copy">
                        {t("options.rules.importExportDescription")}
                      </p>
                    </div>
                  </div>
                  <div className="cx-options-transfer-actions">
                    <Button variant="outline" onClick={exportCurrentRules}>
                      <Download className="h-4 w-4" />
                      {t("options.rules.export")}
                    </Button>
                    <Button variant="outline" onClick={() => importInputRef.current?.click()}>
                      <Upload className="h-4 w-4" />
                      {t("options.rules.import")}
                    </Button>
                    <input
                      ref={importInputRef}
                      type="file"
                      accept=".json,application/json"
                      className="hidden"
                      onChange={importCurrentRules}
                    />
                  </div>
                  <FeedbackMessage feedback={transferFeedback} />
                </div>
              </CardContent>
            </Card>
          </section>

          <Card className="cx-options-card">
            <CardHeader className="cx-options-card-header">
              <div className="cx-options-title-row">
                <CheckCircle2 className="h-4 w-4" />
                <div>
                  <CardTitle>{t("options.exportSettings.title")}</CardTitle>
                  <CardDescription>{t("options.exportSettings.description")}</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="cx-options-card-content cx-options-settings-stack">
              <NumberSettingRow
                label={t("options.general.concurrency")}
                min={1}
                max={10}
                value={settings.concurrency}
                onSave={(value) => update({ concurrency: value })}
              />
              <NumberSettingRow
                label={t("options.exportSettings.maxRetries")}
                min={MAX_RETRIES_MIN}
                max={MAX_RETRIES_MAX}
                value={settings.maxRetries}
                onSave={(value) => update({ maxRetries: value })}
              />
              <NumberSettingRow
                label={t("options.exportSettings.requestTimeout")}
                min={REQUEST_TIMEOUT_SECONDS_MIN}
                max={REQUEST_TIMEOUT_SECONDS_MAX}
                value={Math.round(settings.requestTimeout / 1000)}
                onSave={(value) => update({ requestTimeout: value * 1000 })}
              />
              <NumberSettingRow
                label={t("options.exportSettings.maxConcurrency")}
                min={MAX_CONCURRENCY_MIN}
                max={MAX_CONCURRENCY_MAX}
                value={settings.maxConcurrency}
                onSave={(value) => update({ maxConcurrency: value })}
              />
              <div>
                <Label htmlFor="confluence-base-url">
                  {t("options.general.confluenceBaseUrl")}
                </Label>
                <div className="mt-3 space-y-2">
                  <Input
                    key={settings.confluenceBaseUrl ?? ""}
                    id="confluence-base-url"
                    type="url"
                    defaultValue={settings.confluenceBaseUrl ?? ""}
                    placeholder="https://wiki.example.com/wiki"
                    onBlur={(event) => {
                      const next = event.currentTarget.value.trim();
                      if (next !== (settings.confluenceBaseUrl ?? "")) {
                        update({ confluenceBaseUrl: next || undefined });
                      }
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("options.general.confluenceBaseUrlDescription")}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </details>
    </section>
  );
}

function RuleRow({
  rule,
  onPatch,
  onRemove,
}: {
  rule: ExtractionRule;
  onPatch: (id: string, patch: Partial<ExtractionRule>) => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="cx-options-rule-row">
      <div className="cx-options-rule-toggle">
        <Switch
          aria-label={`${t("options.rules.enabled")}: ${rule.name}`}
          checked={rule.enabled}
          onCheckedChange={(v) => onPatch(rule.id, { enabled: v })}
        />
        <span>{rule.enabled ? t("options.rules.enabled") : t("options.rules.disabled")}</span>
      </div>
      <Input
        value={rule.name}
        aria-label={t("options.rules.namePlaceholder")}
        placeholder={t("options.rules.namePlaceholder")}
        onChange={(e) => onPatch(rule.id, { name: e.target.value })}
      />
      <Input
        value={rule.matcher}
        aria-label={t("options.rules.matcherPlaceholder")}
        placeholder={
          rule.type === "section"
            ? t("options.rules.sectionMatcherPlaceholder")
            : t("options.rules.cssMatcherPlaceholder")
        }
        onChange={(e) => onPatch(rule.id, { matcher: e.target.value })}
      />
      <Select
        value={rule.type}
        onValueChange={(v) => isRuleType(v) && onPatch(rule.id, { type: v })}
      >
        <SelectTrigger aria-label={t("options.rules.type")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {RULE_TYPES.map((type) => (
            <SelectItem key={type} value={type}>
              {type}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={rule.action}
        onValueChange={(v) => isRuleAction(v) && onPatch(rule.id, { action: v })}
      >
        <SelectTrigger aria-label={t("options.rules.action")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {RULE_ACTIONS.map((action) => (
            <SelectItem key={action} value={action}>
              {action}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => onRemove(rule.id)}
        aria-label={t("options.rules.deleteAria")}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}

function FeedbackMessage({ feedback }: { feedback: ImportExportFeedback }) {
  const { t } = useI18n();
  const message = feedback.messageKey
    ? t(feedback.messageKey, feedback.messageValues)
    : (feedback.message ?? "");

  return (
    <p
      role={feedback.tone === "error" ? "alert" : "status"}
      className={`cx-options-feedback cx-options-feedback-${feedback.tone}`}
    >
      {message}
    </p>
  );
}

function NumberSettingRow({
  label,
  min,
  max,
  value,
  onSave,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  onSave: (value: number) => void;
}) {
  const save = (event: React.FocusEvent<HTMLInputElement>) => {
    const next = clampInteger(Number(event.currentTarget.value), min, max, value);
    event.currentTarget.value = String(next);
    if (next !== value) onSave(next);
  };

  return (
    <LabelRow label={label}>
      <Input
        key={value}
        aria-label={label}
        type="number"
        min={min}
        max={max}
        className="w-24"
        defaultValue={value}
        onBlur={save}
      />
    </LabelRow>
  );
}

function LabelRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="cx-options-setting-row">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
