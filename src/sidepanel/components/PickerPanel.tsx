import { Crosshair, Download, X } from "lucide-react";
import { BrowserApi } from "@/lib/browser/browser-api";
import { DEFAULT_PRESET_ID } from "@/lib/rule-engine";
import type { CurrentTabInfo } from "../hooks/useCurrentTab";
import { useExtractJob } from "../hooks/useExtractJob";
import { useI18n } from "../hooks/useI18n";
import { usePickerBridge } from "../hooks/usePickerBridge";
import { useSettings } from "../hooks/useSettings";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { JobStatus } from "./JobStatus";
import { PresetSelector } from "./PresetSelector";

export function PickerPanel({ tab }: { tab: CurrentTabInfo }) {
  const { data: settings, update } = useSettings();
  const { t } = useI18n();
  const { state, run, cancel } = useExtractJob();
  const { pickedBlock, clear } = usePickerBridge();

  const preset = settings?.activePresetId ?? DEFAULT_PRESET_ID;

  const startPicker = async () => {
    if (!tab.tabId) return;
    await BrowserApi.executeScript({
      target: { tabId: tab.tabId },
      func: () => window.postMessage({ __cx_cmd: "start-picker" }, "*"),
    });
  };

  return (
    <div className="min-w-0 space-y-3">
      <h2 className="text-sm font-semibold">{t("picker.title")}</h2>
      <p className="text-xs text-muted-foreground">
        {t("picker.helpStart")} <kbd className="rounded border bg-muted px-1 text-[10px]">[</kbd>
        {" / "}
        <kbd className="rounded border bg-muted px-1 text-[10px]">]</kbd> {t("picker.helpLevels")}
        <kbd className="ml-1 rounded border bg-muted px-1 text-[10px]">Esc</kbd>{" "}
        {t("picker.helpCancel")}
      </p>

      <Button className="w-full" onClick={startPicker} disabled={!tab.tabId}>
        <Crosshair className="h-4 w-4" />
        {t("picker.launch")}
      </Button>

      {!pickedBlock && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="space-y-3 p-4 text-xs text-muted-foreground">
            <div className="flex min-w-0 items-start gap-3">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface shadow-[0_0_16px_hsl(var(--accent-glow))]">
                <Crosshair className="h-4 w-4 text-primary" />
              </div>
              <div className="min-w-0 space-y-1">
                <div className="font-medium text-foreground">{t("picker.emptyTitle")}</div>
                <div>{t("picker.emptyDescription")}</div>
              </div>
            </div>
            {!tab.tabId && (
              <div className="rounded-md border border-warning/30 bg-warning/5 p-2 text-warning">
                {t("picker.noActiveTab")}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {pickedBlock && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex min-w-0 items-start justify-between gap-2">
              <div className="min-w-0 space-y-1">
                <CardTitle className="flex min-w-0 flex-wrap items-center gap-2">
                  {t("picker.selectedTitle")}
                  <Badge variant="success">{t("picker.ready")}</Badge>
                </CardTitle>
                <CardDescription>{t("picker.selectedDescription")}</CardDescription>
              </div>
              <Button variant="ghost" size="icon" className="shrink-0" onClick={clear}>
                <X className="h-3 w-3" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-2 pt-0 text-xs">
            <div className="line-clamp-2 text-muted-foreground">
              {pickedBlock.meta.title} · {(pickedBlock.html.length / 1024).toFixed(1)} KB HTML
            </div>
            <Button
              variant="accent"
              className="w-full"
              disabled={state?.status === "running"}
              onClick={() =>
                run({
                  kind: "extract-block",
                  html: pickedBlock.html,
                  pageMeta: pickedBlock.meta,
                  presetId: preset,
                })
              }
            >
              <Download className="h-4 w-4" />
              {t("picker.extract")}
            </Button>
          </CardContent>
        </Card>
      )}

      <PresetSelector value={preset} onChange={(id) => update({ activePresetId: id })} />

      <JobStatus state={state} onCancel={cancel} />
    </div>
  );
}
