import { Minus, Plus, RotateCcw, Settings2 } from "lucide-react";
import { BrowserApi } from "@/lib/browser/browser-api";
import {
  clampFontSize,
  DEFAULT_SETTINGS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  FONT_SIZE_STEP,
} from "@/lib/settings";
import { useSettings } from "../hooks/useSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Separator } from "../ui/separator";
import { Switch } from "../ui/switch";

export function SettingsPanel() {
  const { data: settings, update } = useSettings();
  if (!settings) return null;

  const fontSize = clampFontSize(settings.fontSize);
  const setFontSize = (next: number) => update({ fontSize: clampFontSize(next) });

  return (
    <div className="min-w-0 space-y-3">
      <h2 className="text-sm font-semibold">Настройки</h2>

      <div className="space-y-1 rounded-md border p-2">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-0.5">
            <Label className="block">Размер шрифта</Label>
            <p className="text-[11px] leading-tight text-muted-foreground">
              Масштабирует весь интерфейс. {FONT_SIZE_MIN}–{FONT_SIZE_MAX}px.
            </p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-0.5 panel:gap-1">
            <Button
              variant="outline"
              size="icon"
              onClick={() => setFontSize(fontSize - FONT_SIZE_STEP)}
              disabled={fontSize <= FONT_SIZE_MIN}
              aria-label="Уменьшить шрифт"
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
              aria-label="Увеличить шрифт"
            >
              <Plus className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setFontSize(DEFAULT_SETTINGS.fontSize)}
              aria-label="Сбросить"
              title="Сбросить к значению по умолчанию"
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

      <Toggle
        label="Front-matter YAML"
        description="Добавляет метаданные (title, id, url, labels) в начало каждого .md"
        checked={settings.includeFrontMatter}
        onChange={(v) => update({ includeFrontMatter: v })}
      />
      <Toggle
        label="Перезапись внутренних ссылок"
        description="Ссылки на страницы из того же экспорта становятся относительными путями"
        checked={settings.rewriteInternalLinks}
        onChange={(v) => update({ rewriteInternalLinks: v })}
      />
      <Toggle
        label="Дедупликация картинок"
        description="Одинаковые изображения (по SHA-256) сохраняются один раз"
        checked={settings.deduplicateImages}
        onChange={(v) => update({ deduplicateImages: v })}
      />

      <Separator />

      <div className="space-y-1">
        <Label>Параллельных запросов</Label>
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
        Редактор правил
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
