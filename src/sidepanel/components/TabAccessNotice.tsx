import type { ReactNode } from "react";
import { AlertCircle, Loader2, RefreshCw, ShieldAlert } from "lucide-react";
import type { TabAccessState } from "@/lib/browser/tab-access";
import type { CurrentTabGrantStatus } from "../hooks/useCurrentTab";
import { useI18n } from "../hooks/useI18n";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";

interface TabAccessNoticeProps {
  accessState?: TabAccessState;
  accessOrigin?: string;
  grantStatus: CurrentTabGrantStatus;
  onGrantAccess: () => void;
  onRetry: () => void;
}

export function TabAccessNotice({
  accessState,
  accessOrigin,
  grantStatus,
  onGrantAccess,
  onRetry,
}: TabAccessNoticeProps) {
  const { t } = useI18n();
  if (!accessState || accessState === "available") return null;

  if (accessState === "unsupported-url") {
    return (
      <NoticeCard
        icon={<AlertCircle className="h-4 w-4" />}
        title={t("tabAccess.unsupportedTitle")}
        description={t("tabAccess.unsupportedDescription")}
      />
    );
  }

  if (accessState === "host-access-missing") {
    return (
      <NoticeCard
        icon={<ShieldAlert className="h-4 w-4" />}
        title={t("tabAccess.hostMissingTitle")}
        description={t("tabAccess.hostMissingDescription", {
          origin: accessOrigin ?? t("settings.diagnostics.none"),
        })}
      >
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={grantStatus === "requesting"}
          onClick={onGrantAccess}
        >
          {grantStatus === "requesting" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t("tabAccess.grant")}
        </Button>
        {grantStatus === "declined" && (
          <p className="text-[11px] text-muted-foreground">{t("tabAccess.grantDeclined")}</p>
        )}
        {grantStatus === "failed" && (
          <p className="text-[11px] text-destructive">{t("tabAccess.grantFailed")}</p>
        )}
      </NoticeCard>
    );
  }

  return (
    <NoticeCard
      icon={<AlertCircle className="h-4 w-4" />}
      title={t("tabAccess.probeFailedTitle")}
      description={t("tabAccess.probeFailedDescription")}
    >
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>
        <RefreshCw className="h-3.5 w-3.5" />
        {t("tabAccess.retry")}
      </Button>
    </NoticeCard>
  );
}

function NoticeCard({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardContent className="space-y-2 p-3 text-xs">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 text-primary">{icon}</span>
          <div className="min-w-0 space-y-1">
            <div className="font-medium text-foreground">{title}</div>
            <div className="break-words text-muted-foreground">{description}</div>
          </div>
        </div>
        {children && <div className="space-y-1.5 pl-6">{children}</div>}
      </CardContent>
    </Card>
  );
}
