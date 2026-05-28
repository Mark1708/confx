import {
  CheckCircle2,
  Download,
  FileJson,
  Plus,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Upload,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { getPreset, PRESETS } from "@/lib/rule-engine";
import type { ExtractionRule, RuleAction, RulePreset, RuleType } from "@/types";
import { useSettings } from "../sidepanel/hooks/useSettings";
import { useTheme } from "../sidepanel/hooks/useTheme";
import { Button } from "../sidepanel/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../sidepanel/ui/card";
import { Input } from "../sidepanel/ui/input";
import { Label } from "../sidepanel/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../sidepanel/ui/select";
import { Separator } from "../sidepanel/ui/separator";
import { Switch } from "../sidepanel/ui/switch";

const RULE_TYPES: RuleType[] = ["selector", "table", "section", "spoiler"];
const RULE_ACTIONS: RuleAction[] = ["skip", "to-csv", "to-md", "gfm-table", "extract-images", "keep-html"];

const MAX_RETRIES_MIN = 1;
const MAX_RETRIES_MAX = 10;
const REQUEST_TIMEOUT_SECONDS_MIN = 5;
const REQUEST_TIMEOUT_SECONDS_MAX = 120;
const MAX_CONCURRENCY_MIN = 1;
const MAX_CONCURRENCY_MAX = 20;

type FeedbackTone = "success" | "error" | "info";

interface ImportExportFeedback {
  tone: FeedbackTone;
  message: string;
}

interface NavItem {
  href: string;
  label: string;
  description: string;
}

const NAV_ITEMS: NavItem[] = [
  { href: "#preset", label: "Пресет", description: "Базовая стратегия" },
  { href: "#rules", label: "Правила", description: "Пользовательский слой" },
  { href: "#general", label: "Общие", description: "Поведение экспорта" },
  { href: "#export", label: "Экспорт", description: "API и лимиты" },
];

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function makeId(): string {
  return `rule_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function emptyRule(): ExtractionRule {
  return {
    id: makeId(),
    name: "New rule",
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

function exportRules(preset: RulePreset, customRules: ExtractionRule[]): string {
  return JSON.stringify({ preset, customRules }, null, 2);
}

function importRules(json: string): { preset: RulePreset; customRules: ExtractionRule[] } {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed) || !isRecord(parsed.preset) || !Array.isArray(parsed.customRules)) {
    throw new Error("Некорректный формат файла правил");
  }

  const presetId = parsed.preset.id;
  if (typeof presetId !== "string") {
    throw new Error("В файле правил не указан пресет");
  }

  const preset = PRESETS.find((item) => item.id === presetId);
  if (!preset) {
    throw new Error(`Неизвестный пресет: ${presetId}`);
  }

  const customRules = parsed.customRules.filter(isExtractionRule);
  if (customRules.length !== parsed.customRules.length) {
    throw new Error("Файл содержит некорректные пользовательские правила");
  }

  return { preset, customRules };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExtractionRule(value: unknown): value is ExtractionRule {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.type === "string" &&
    isRuleType(value.type) &&
    typeof value.matcher === "string" &&
    typeof value.action === "string" &&
    isRuleAction(value.action) &&
    typeof value.enabled === "boolean"
  );
}

export function OptionsApp() {
  const { data: settings, update } = useSettings();
  useTheme();
  const importInputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<ExtractionRule>(emptyRule());
  const [transferFeedback, setTransferFeedback] = useState<ImportExportFeedback>({
    tone: "info",
    message: "Готово к импорту или экспорту JSON правил.",
  });
  const rules = useMemo(() => settings?.customRules ?? [], [settings]);
  const activePreset = getPreset(settings?.activePresetId ?? "");

  if (!settings) return null;

  const addRule = () => {
    update({ customRules: [...rules, { ...draft, id: makeId() }] });
    setDraft(emptyRule());
  };
  const removeRule = (id: string) =>
    update({ customRules: rules.filter((r) => r.id !== id) });
  const patchRule = (id: string, patch: Partial<ExtractionRule>) =>
    update({ customRules: rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) });

  const exportCurrentRules = () => {
    const json = exportRules(activePreset, rules);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    link.href = url;
    link.download = `rules-${settings.activePresetId}-${timestamp}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setTransferFeedback({ tone: "success", message: "Экспорт правил запущен. JSON сохранится в загрузки браузера." });
  };

  const importCurrentRules = (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onerror = () => {
      setTransferFeedback({ tone: "error", message: "Не удалось прочитать файл правил." });
      alert("Не удалось прочитать файл правил");
      input.value = "";
    };
    reader.onload = () => {
      try {
        if (typeof reader.result !== "string") {
          throw new Error("Файл правил должен быть текстовым JSON");
        }
        const result = importRules(reader.result);
        update({ customRules: result.customRules, activePresetId: result.preset.id });
        setTransferFeedback({
          tone: "success",
          message: `Импортировано правил: ${result.customRules.length}. Активный пресет: ${result.preset.name}.`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Не удалось импортировать правила";
        setTransferFeedback({ tone: "error", message });
        alert(message);
      } finally {
        input.value = "";
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="cx-options">
      <aside className="cx-options-sidebar" aria-label="Навигация по настройкам">
        <div className="cx-options-brand">
          <span className="cx-options-logo" aria-hidden="true">CX</span>
          <div>
            <div className="cx-options-kicker">Консоль ConfX</div>
            <div className="cx-options-brand-title">Правила экспорта</div>
          </div>
        </div>

        <nav className="cx-options-nav">
          {NAV_ITEMS.map((item) => (
            <a key={item.href} className="cx-options-nav-link" href={item.href}>
              <span>{item.label}</span>
              <small>{item.description}</small>
            </a>
          ))}
        </nav>

        <div className="cx-options-sidebar-card">
          <ShieldCheck className="h-4 w-4" />
          <div>
            <strong>{rules.length}</strong>
            <span>пользовательских правил поверх пресета</span>
          </div>
        </div>
      </aside>

      <main className="cx-options-main">
        <header className="cx-options-hero">
          <div>
            <p className="cx-options-eyebrow">Панель правил ConfX</p>
            <h1>ConfX — настройки извлечения</h1>
            <p>
              Правила применяются к HTML страницы перед конверсией в Markdown. Пресет активируется в side panel,
              свои правила добавляются к выбранному пресету.
            </p>
          </div>
          <div className="cx-options-hero-panel" role="status" aria-label="Текущая конфигурация">
            <span>Пресет</span>
            <strong>{activePreset.name}</strong>
            <small>{settings.customRules.length} пользовательских правил</small>
          </div>
        </header>

        <section id="preset" className="cx-options-section">
          <Card className="cx-options-card cx-options-card-accent">
            <CardHeader className="cx-options-card-header">
              <div className="cx-options-title-row">
                <SlidersHorizontal className="h-4 w-4" />
                <div>
                  <CardTitle>Активный пресет</CardTitle>
                  <CardDescription>Переключается из side panel на любой вкладке</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="cx-options-card-content">
              <Select value={settings.activePresetId} onValueChange={(id) => update({ activePresetId: id })}>
                <SelectTrigger className="cx-options-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRESETS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="cx-options-preset-preview">
                <div className="cx-options-preset-description">{activePreset.description}</div>
                {activePreset.rules.length > 0 ? (
                  <ul className="cx-options-rule-list">
                    {activePreset.rules.map((r) => (
                      <li key={r.id}>
                        <span className="cx-options-code-pill">{r.type}</span>
                        <span>{r.name}</span>
                        <span className="cx-options-arrow">→</span>
                        <span className="cx-options-code-pill">{r.action}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="cx-options-empty-inline">Пресет не добавляет правил автоматически.</p>
                )}
              </div>
            </CardContent>
          </Card>
        </section>

        <section id="rules" className="cx-options-section">
          <Card className="cx-options-card">
            <CardHeader className="cx-options-card-header">
              <div className="cx-options-title-row">
                <FileJson className="h-4 w-4" />
                <div>
                  <CardTitle>Пользовательские правила</CardTitle>
                  <CardDescription>Применяются поверх пресета. Порядок: верхние правила раньше.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="cx-options-card-content">
              <div className="cx-options-rules-stack">
                {rules.length === 0 && <p className="cx-options-empty">Пока нет правил. Добавьте matcher ниже.</p>}
                {rules.map((r) => (
                  <RuleRow key={r.id} rule={r} onPatch={patchRule} onRemove={removeRule} />
                ))}
              </div>

              <Separator className="cx-options-separator" />

              <div className="cx-options-editor-panel">
                <div>
                  <Label className="cx-options-panel-title">Новое правило</Label>
                  <p className="cx-options-panel-copy">Matcher может быть CSS-селектором или regex заголовка секции.</p>
                </div>
                <div className="cx-options-new-rule-grid">
                  <Input
                    placeholder="matcher (CSS / regex)"
                    value={draft.matcher}
                    onChange={(e) => setDraft({ ...draft, matcher: e.target.value })}
                  />
                  <Select value={draft.type} onValueChange={(v) => isRuleType(v) && setDraft({ ...draft, type: v })}>
                    <SelectTrigger>
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
                    <SelectTrigger>
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
                    Добавить
                  </Button>
                </div>
              </div>

              <div className="cx-options-transfer-panel">
                <div className="cx-options-transfer-copy">
                  <FileJson className="h-4 w-4" />
                  <div>
                    <Label className="cx-options-panel-title">Импорт и экспорт правил</Label>
                    <p className="cx-options-panel-copy">JSON содержит активный пресет и все пользовательские правила.</p>
                  </div>
                </div>
                <div className="cx-options-transfer-actions">
                  <Button variant="outline" onClick={exportCurrentRules}>
                    <Download className="h-4 w-4" />
                    Экспорт правил
                  </Button>
                  <Button variant="outline" onClick={() => importInputRef.current?.click()}>
                    <Upload className="h-4 w-4" />
                    Импорт правил
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

        <section id="general" className="cx-options-section cx-options-grid-two">
          <Card className="cx-options-card">
            <CardHeader className="cx-options-card-header">
              <div className="cx-options-title-row">
                <Settings2 className="h-4 w-4" />
                <div>
                  <CardTitle>Общие настройки</CardTitle>
                  <CardDescription>Что включать в архив и Markdown</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="cx-options-card-content cx-options-settings-stack">
              <LabelRow label="Front-matter YAML в каждый .md">
                <Switch checked={settings.includeFrontMatter} onCheckedChange={(v) => update({ includeFrontMatter: v })} />
              </LabelRow>
              <LabelRow label="Перезапись внутренних ссылок">
                <Switch checked={settings.rewriteInternalLinks} onCheckedChange={(v) => update({ rewriteInternalLinks: v })} />
              </LabelRow>
              <LabelRow label="Дедупликация картинок">
                <Switch checked={settings.deduplicateImages} onCheckedChange={(v) => update({ deduplicateImages: v })} />
              </LabelRow>
              <LabelRow label="Параллельных запросов">
                <Input
                  type="number"
                  min={1}
                  max={10}
                  className="cx-options-number-input"
                  value={settings.concurrency}
                  onChange={(e) => update({ concurrency: Number(e.target.value) || 1 })}
                />
              </LabelRow>
            </CardContent>
          </Card>

          <Card id="export" className="cx-options-card">
            <CardHeader className="cx-options-card-header">
              <div className="cx-options-title-row">
                <CheckCircle2 className="h-4 w-4" />
                <div>
                  <CardTitle>Настройки экспорта</CardTitle>
                  <CardDescription>Ограничения для запросов к Confluence API</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="cx-options-card-content cx-options-settings-stack">
              <NumberSettingRow
                label="Максимум повторных попыток"
                min={MAX_RETRIES_MIN}
                max={MAX_RETRIES_MAX}
                value={settings.maxRetries}
                onSave={(value) => update({ maxRetries: value })}
              />
              <NumberSettingRow
                label="Таймаут запроса (сек.)"
                min={REQUEST_TIMEOUT_SECONDS_MIN}
                max={REQUEST_TIMEOUT_SECONDS_MAX}
                value={Math.round(settings.requestTimeout / 1000)}
                onSave={(value) => update({ requestTimeout: value * 1000 })}
              />
              <NumberSettingRow
                label="Макс. параллельных запросов"
                min={MAX_CONCURRENCY_MIN}
                max={MAX_CONCURRENCY_MAX}
                value={settings.maxConcurrency}
                onSave={(value) => update({ maxConcurrency: value })}
              />
            </CardContent>
          </Card>
        </section>
      </main>
    </div>
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
  return (
    <div className="cx-options-rule-row">
      <div className="cx-options-rule-toggle">
        <Switch checked={rule.enabled} onCheckedChange={(v) => onPatch(rule.id, { enabled: v })} />
        <span>{rule.enabled ? "Вкл" : "Выкл"}</span>
      </div>
      <Input value={rule.name} placeholder="Название" onChange={(e) => onPatch(rule.id, { name: e.target.value })} />
      <Input
        value={rule.matcher}
        placeholder={
          rule.type === "section"
            ? "regex на заголовок секции (например: API\\s+компонент)"
            : "CSS-селектор (например: table.confluenceTable)"
        }
        onChange={(e) => onPatch(rule.id, { matcher: e.target.value })}
      />
      <Select value={rule.type} onValueChange={(v) => isRuleType(v) && onPatch(rule.id, { type: v })}>
        <SelectTrigger>
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
      <Select value={rule.action} onValueChange={(v) => isRuleAction(v) && onPatch(rule.id, { action: v })}>
        <SelectTrigger>
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
      <Button variant="ghost" size="icon" onClick={() => onRemove(rule.id)} aria-label="Удалить правило">
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}

function FeedbackMessage({ feedback }: { feedback: ImportExportFeedback }) {
  return <p className={`cx-options-feedback cx-options-feedback-${feedback.tone}`}>{feedback.message}</p>;
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
