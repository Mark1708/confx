import { useQuery } from "@tanstack/react-query";
import { Globe, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { fetchSpacePageEstimate } from "../extraction";
import type { CurrentTabInfo } from "../hooks/useCurrentTab";
import { useExtractJob } from "../hooks/useExtractJob";
import { usePageInfo } from "../hooks/usePageInfo";
import { useSettings } from "../hooks/useSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { JobStatus } from "./JobStatus";
import { PresetSelector } from "./PresetSelector";

export function SpacePanel({ tab }: { tab: CurrentTabInfo }) {
  const info = usePageInfo(tab.host, tab.pageId);
  const { data: settings, update } = useSettings();
  const { state, run, cancel } = useExtractJob();
  const [label, setLabel] = useState("");
  const [prefix, setPrefix] = useState("");

  const spaceKey = info.data?.meta?.spaceKey;
  const preset = settings?.activePresetId ?? "ui-component";
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
        throw new Error("Не удалось определить пространство для оценки экспорта");
      }
      return fetchSpacePageEstimate(tab.host, spaceKey, options, signal);
    },
    staleTime: 30_000,
  });

  return (
    <div className="min-w-0 space-y-3">
      <div className="space-y-1">
        <Label>Пространство</Label>
        <div className="rounded-md border bg-card p-3 text-sm">
          {info.isLoading ? (
            <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Определяю пространство…
            </div>
          ) : spaceKey ? (
            <div className="flex min-w-0 items-center gap-2">
              <Globe className="h-4 w-4 shrink-0 text-primary" />
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">Ключ пространства</div>
                <div className="break-all font-mono font-medium">{spaceKey}</div>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Откройте Confluence-страницу для определения пространства
            </p>
          )}
        </div>
      </div>

      <PresetSelector value={preset} onChange={(id) => update({ activePresetId: id })} />

      <div className="space-y-2 rounded-md border bg-card p-3">
        <div className="space-y-1">
          <Label htmlFor="space-label-filter">Label-фильтр</Label>
          <Input
            id="space-label-filter"
            value={label}
            disabled={isRunning}
            placeholder="например: public"
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="space-prefix-filter">Префикс заголовка</Label>
          <Input
            id="space-prefix-filter"
            value={prefix}
            disabled={isRunning}
            placeholder="например: API"
            onChange={(event) => setPrefix(event.target.value)}
          />
        </div>
        <div className="text-xs text-muted-foreground">
          {estimate.isFetching ? "Оцениваю размер экспорта…" : `Будет экспортировано страниц: ${estimate.data ?? 0}`}
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
        Экспортировать пространство
      </Button>

      <JobStatus state={state} onCancel={cancel} />
    </div>
  );
}
