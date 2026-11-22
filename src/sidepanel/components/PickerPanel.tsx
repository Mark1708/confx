import { useState } from "react";
import { Crosshair, X } from "lucide-react";
import { BrowserApi } from "@/lib/browser/browser-api";
import type { CurrentTabInfo } from "../hooks/useCurrentTab";
import { useExtractJob } from "../hooks/useExtractJob";
import { useI18n } from "../hooks/useI18n";
import { usePickerBridge } from "../hooks/usePickerBridge";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { TabAccessNotice } from "./TabAccessNotice";

export function PickerPanel({ tab }: { tab: CurrentTabInfo }) {
  const { t } = useI18n();
  const { draftLocked } = useExtractJob();
  const { pickedBlock, clear } = usePickerBridge();
  const [launchFailureTarget, setLaunchFailureTarget] = useState<string | null>(null);
  const pickerTarget = `${tab.tabId ?? ""}:${tab.url ?? ""}`;

  const accessState = launchFailureTarget === pickerTarget ? "injection-failed" : tab.accessState;

  const startPicker = async () => {
    if (!tab.tabId || accessState !== "available" || draftLocked) return;
    setLaunchFailureTarget(null);
    try {
      const [probe] = await BrowserApi.executeScript({
        target: { tabId: tab.tabId },
        func: () => {
          const ready = Reflect.get(globalThis, "__cx_picker_ready") === true;
          if (ready) window.postMessage({ __cx_cmd: "start-picker" }, location.origin);
          return ready;
        },
      });
      if (!probe?.result) {
        await BrowserApi.executeScript({
          target: { tabId: tab.tabId },
          files: ["content-scripts/picker-entry.js"],
        });
        await BrowserApi.executeScript({
          target: { tabId: tab.tabId },
          func: () => window.postMessage({ __cx_cmd: "start-picker" }, location.origin),
        });
      }
    } catch (error) {
      console.warn("[cx] picker launch failed", error);
      setLaunchFailureTarget(pickerTarget);
    }
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
      <p className="text-xs text-muted-foreground">{t("composer.fragmentHelp")}</p>

      <Button
        variant="outline"
        className="w-full"
        onClick={startPicker}
        disabled={!tab.tabId || accessState !== "available" || draftLocked}
      >
        <Crosshair className="h-4 w-4" />
        {t("picker.launch")}
      </Button>

      <TabAccessNotice
        accessState={accessState}
        accessOrigin={tab.accessOrigin}
        grantStatus={tab.grantStatus}
        onGrantAccess={tab.grantAccess}
        onRetry={() => {
          setLaunchFailureTarget(null);
          void tab.retry();
        }}
      />

      {!pickedBlock && accessState === "available" && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="space-y-3 p-4 text-xs text-muted-foreground">
            <div className="flex min-w-0 items-start gap-3">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface">
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
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0"
                disabled={draftLocked}
                aria-label={t("picker.clearSelection")}
                onClick={clear}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-2 pt-0 text-xs">
            <div className="line-clamp-2 text-muted-foreground">
              {pickedBlock.meta.title} · {(pickedBlock.html.length / 1024).toFixed(1)} KB HTML
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
