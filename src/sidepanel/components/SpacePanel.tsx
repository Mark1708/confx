import { useQuery } from "@tanstack/react-query";
import { Globe, Loader2 } from "lucide-react";
import { useEffect, useMemo } from "react";
import { toFetchOptions } from "@/lib/create-api";
import { fetchSpacePageEstimate } from "@/lib/export/confluence";
import type { CurrentTabInfo } from "../hooks/useCurrentTab";
import { useExtractJob } from "../hooks/useExtractJob";
import { useI18n } from "../hooks/useI18n";
import { usePageInfo } from "../hooks/usePageInfo";
import { useSettings } from "../hooks/useSettings";
import { TabAccessNotice } from "./TabAccessNotice";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { useWorkspace } from "../workspace/WorkspaceProvider";

export function SpacePanel({ tab }: { tab: CurrentTabInfo }) {
  const { source, draft, patchDraft } = useWorkspace();
  const available =
    source?.product === "confluence" &&
    source.baseUrl === tab.host &&
    tab.accessState === "available";
  const info = usePageInfo(available ? source.baseUrl : undefined, tab.pageId);
  const { t } = useI18n();
  const { data: settings } = useSettings();
  const { draftLocked } = useExtractJob();
  const { spaceKey, label, prefix } = draft.space;

  useEffect(() => {
    if (
      spaceKey !== undefined ||
      !available ||
      info.isPlaceholderData ||
      info.data?.meta?.id !== tab.pageId ||
      !info.data?.meta?.spaceKey
    ) {
      return;
    }
    patchDraft({ space: { ...draft.space, spaceKey: info.data.meta.spaceKey } });
  }, [spaceKey, available, info.isPlaceholderData, info.data, tab.pageId, draft.space, patchDraft]);

  const options = useMemo(() => {
    const trimmedLabel = label.trim();
    const trimmedPrefix = prefix.trim();
    if (!trimmedLabel && !trimmedPrefix) return undefined;
    return {
      ...(trimmedLabel ? { label: trimmedLabel } : {}),
      ...(trimmedPrefix ? { prefix: trimmedPrefix } : {}),
    };
  }, [label, prefix]);
  const baseUrl = available ? source.baseUrl : undefined;
  const network = useMemo(() => (settings ? toFetchOptions(settings) : undefined), [settings]);
  const estimate = useQuery({
    queryKey: ["space-page-estimate", baseUrl, spaceKey, options?.label, options?.prefix, network],
    enabled: Boolean(baseUrl && spaceKey && network),
    queryFn: ({ signal }) => {
      if (!baseUrl || !spaceKey || !network) {
        throw new Error(t("space.estimateError"));
      }
      return fetchSpacePageEstimate(baseUrl, spaceKey, options, network, signal);
    },
    staleTime: 30_000,
  });

  return (
    <div className="min-w-0 space-y-3">
      <div className="space-y-1">
        <TabAccessNotice
          accessState={tab.accessState}
          accessOrigin={tab.accessOrigin}
          grantStatus={tab.grantStatus}
          onGrantAccess={tab.grantAccess}
          onRetry={tab.retry}
        />
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

      <div className="space-y-2 rounded-md border bg-card p-3">
        <div className="space-y-1">
          <Label htmlFor="space-label-filter">{t("space.labelFilter")}</Label>
          <Input
            id="space-label-filter"
            value={label}
            disabled={draftLocked}
            placeholder={t("space.labelPlaceholder")}
            onChange={(event) =>
              patchDraft({ space: { ...draft.space, label: event.target.value } })
            }
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="space-prefix-filter">{t("space.prefixFilter")}</Label>
          <Input
            id="space-prefix-filter"
            value={prefix}
            disabled={draftLocked}
            placeholder={t("space.prefixPlaceholder")}
            onChange={(event) =>
              patchDraft({ space: { ...draft.space, prefix: event.target.value } })
            }
          />
        </div>
        <div className="text-xs text-muted-foreground" role={estimate.isError ? "alert" : "status"}>
          {estimate.isFetching
            ? t("space.estimating")
            : estimate.isError
              ? t("space.estimateError")
              : estimate.data !== undefined
                ? t("space.pagesCount", { count: estimate.data })
                : t("space.estimateUnavailable")}
        </div>
      </div>
    </div>
  );
}
