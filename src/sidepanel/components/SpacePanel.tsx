import { useQuery } from "@tanstack/react-query";
import { Globe, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { DEFAULT_PRESET_ID } from "@/lib/rule-engine";
import { fetchSpacePageEstimate } from "../extraction";
import type { CurrentTabInfo } from "../hooks/useCurrentTab";
import { useExtractJob } from "../hooks/useExtractJob";
import { useI18n } from "../hooks/useI18n";
import { usePageInfo } from "../hooks/usePageInfo";
import { useSettings } from "../hooks/useSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { JobStatus } from "./JobStatus";
import { PresetSelector } from "./PresetSelector";

export function SpacePanel({ tab }: { tab: CurrentTabInfo }) {
  const info = usePageInfo(tab.host, tab.pageId);
  const { t } = useI18n();
  const { data: settings, update } = useSettings();
  const { state, run, cancel } = useExtractJob();
  const [label, setLabel] = useState("");
  const [prefix, setPrefix] = useState("");

  const spaceKey = info.data?.meta?.spaceKey;
  const preset = settings?.activePresetId ?? DEFAULT_PRESET_ID;
  const isRunning = state?.status === "running";
  const options = useMemo(() => {
    const trimmedLabel = label.trim();
    const trimmedPrefix = prefix.trim();
    if (!trimmedLabel && !trimmedPrefix) return undefined;
    return {
      ...(trimmedLabel ? { label: trimmedLabel } : {}),
      ...(trimmedPrefix ? { prefix: trimmedPrefix } : {}),
    };
  }, [label, prefix]);
  const estimate = useQuery({
    queryKey: ["space-page-estimate", tab.host, spaceKey, options?.label, options?.prefix],
    enabled: Boolean(tab.host && spaceKey),
    queryFn: ({ signal }) => {
      if (!tab.host || !spaceKey) {
        throw new Error(t("space.estimateError"));
      }
      return fetchSpacePageEstimate(tab.host, spaceKey, options, signal);
    },
    staleTime: 30_000,
  });

  return (
    <div className="min-w-0 space-y-3">
      <div className="space-y-1">
        <Label>{t("space.title")}</Label>
        <div className="rounded-md border bg-card p-3 text-sm">
          {info.isLoading ? (
            <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("space.detecting")}
            </div>
          ) : spaceKey ? (
            <div className="flex min-w-0 items-center gap-2">
              <Globe className="h-4 w-4 shrink-0 text-primary" />
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">{t("space.key")}</div>
                <div className="break-all font-mono font-medium">{spaceKey}</div>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t("space.openPageHint")}</p>
          )}
        </div>
      </div>

      <PresetSelector value={preset} onChange={(id) => update({ activePresetId: id })} />

      <div className="space-y-2 rounded-md border bg-card p-3">
        <div className="space-y-1">
          <Label htmlFor="space-label-filter">{t("space.labelFilter")}</Label>
          <Input
            id="space-label-filter"
            value={label}
            disabled={isRunning}
            placeholder={t("space.labelPlaceholder")}
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="space-prefix-filter">{t("space.prefixFilter")}</Label>
          <Input
            id="space-prefix-filter"
            value={prefix}
            disabled={isRunning}
            placeholder={t("space.prefixPlaceholder")}
            onChange={(event) => setPrefix(event.target.value)}
          />
        </div>
        <div className="text-xs text-muted-foreground">
          {estimate.isFetching
            ? t("space.estimating")
            : t("space.pagesCount", { count: estimate.data ?? 0 })}
        </div>
      </div>

      <Button
        className="w-full"
        disabled={!spaceKey || !tab.host || isRunning}
        onClick={() =>
          spaceKey &&
          tab.host &&
          run({
            kind: "extract-space",
            spaceKey,
            host: tab.host,
            presetId: preset,
            options,
          })
        }
      >
        {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />}
        {t("space.export")}
      </Button>

      <JobStatus state={state} onCancel={cancel} />
    </div>
  );
}
