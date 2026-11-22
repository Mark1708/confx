import { useQueryClient } from "@tanstack/react-query";
import { Bell, BellRing, Loader2, RefreshCw } from "lucide-react";
import { makeSubscriptionId } from "@/lib/subscriptions";
import type { CurrentTabInfo } from "../hooks/useCurrentTab";
import { useI18n } from "../hooks/useI18n";
import { usePageInfo } from "../hooks/usePageInfo";
import { useSubscriptions } from "../hooks/useSubscriptions";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { PageCard } from "./PageCard";

export function PagePanel({ tab }: { tab: CurrentTabInfo }) {
  const qc = useQueryClient();
  const info = usePageInfo(tab.host, tab.pageId);
  const { t } = useI18n();
  const subs = useSubscriptions();

  const pageData =
    !info.isPlaceholderData && info.data?.meta?.id === tab.pageId ? info.data : undefined;
  const pageId = pageData?.meta?.id;

  const subId = tab.host && pageId ? makeSubscriptionId(tab.host, pageId, "page") : null;
  const subscribed = Boolean(subId && subs.subscriptions.some((s) => s.id === subId));

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">{t("page.title")}</h2>
          {pageData?.ok && <Badge variant="success">{t("page.available")}</Badge>}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0"
          onClick={() => qc.invalidateQueries({ queryKey: ["page-info"] })}
          aria-label={t("tabAccess.retry")}
        >
          <RefreshCw className="h-3 w-3" />
        </Button>
      </div>

      <PageCard
        loading={info.isLoading || info.isPlaceholderData}
        data={pageData}
        error={info.error as Error | null}
        url={tab.url}
        accessState={tab.accessState}
        accessOrigin={tab.accessOrigin}
        grantStatus={tab.grantStatus}
        onGrantAccess={tab.grantAccess}
        onRetry={tab.retry}
      />

      <Button
        variant="outline"
        className="w-full"
        disabled={
          tab.accessState !== "available" ||
          !pageId ||
          !tab.host ||
          subs.subscribing ||
          subscribed ||
          Boolean(subs.error)
        }
        onClick={() =>
          pageId && tab.host && subs.subscribe({ host: tab.host, rootId: pageId, scope: "page" })
        }
      >
        {subs.subscribing ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : subscribed ? (
          <BellRing className="h-4 w-4" />
        ) : (
          <Bell className="h-4 w-4" />
        )}
        {subscribed ? t("page.subscriptionActive") : t("page.subscribeChanges")}
      </Button>
      {subs.error && (
        <p role="alert" className="text-xs text-destructive">
          {subs.error.message}
        </p>
      )}
    </div>
  );
}
