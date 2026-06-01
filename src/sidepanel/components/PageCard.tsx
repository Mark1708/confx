import { AlertCircle, ExternalLink, FileText, Loader2 } from "lucide-react";
import { useI18n } from "../hooks/useI18n";
import type { PageInfoResponse } from "../hooks/usePageInfo";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";

interface Props {
  loading: boolean;
  data?: PageInfoResponse;
  error?: Error | null;
  url?: string;
}

export function PageCard({ loading, data, error, url }: Props) {
  const { t } = useI18n();
  if (loading) {
    return (
      <Card className="overflow-hidden">
        <CardContent className="space-y-3 p-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
            {t("page.card.loading")}
          </div>
          <div className="space-y-2">
            <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
            <div className="h-2 w-1/2 animate-pulse rounded bg-muted" />
            <div className="flex gap-1">
              <div className="h-5 w-14 animate-pulse rounded-md bg-muted" />
              <div className="h-5 w-10 animate-pulse rounded-md bg-muted" />
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="border-destructive/30 bg-destructive/5">
        <CardContent className="flex items-start gap-3 p-3 text-xs">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="space-y-1">
            <div className="font-medium text-foreground">{t("page.card.readError")}</div>
            <div className="text-destructive/90">{error.message}</div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!data?.ok || !data.meta) {
    return (
      <Card className="border-primary/30 bg-primary/5">
        <CardContent className="space-y-3 p-4 text-xs text-muted-foreground">
          <div className="flex min-w-0 items-start gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface shadow-[0_0_16px_hsl(var(--accent-glow))]">
              <FileText className="h-4 w-4 text-primary" />
            </div>
            <div className="min-w-0 space-y-1">
              <div className="font-medium text-foreground">{t("page.card.emptyTitle")}</div>
              <div>{t("page.card.emptyDescription")}</div>
            </div>
          </div>
          {url && (
            <div className="flex items-start gap-2 rounded-md border border-border bg-surface p-2 font-mono text-[10px]">
              <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="break-all">{url}</span>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  const m = data.meta;
  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <CardTitle className="flex min-w-0 items-center gap-2">
            <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="line-clamp-2">{m.title}</span>
          </CardTitle>
          {m.spaceKey && (
            <Badge className="max-w-[6rem] shrink-0 truncate" variant="outline">
              {m.spaceKey}
            </Badge>
          )}
        </div>
        {m.ancestors && m.ancestors.length > 0 && (
          <CardDescription className="line-clamp-2 pl-5">
            {m.ancestors.map((a) => a.title).join(" › ")}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex flex-wrap gap-1 p-3 pt-0 text-[11px] text-muted-foreground">
        <Badge variant="secondary">ID {m.id}</Badge>
        {m.version != null && <Badge variant="secondary">v{m.version}</Badge>}
        {(data.childCount ?? 0) > 0 && (
          <Badge variant="secondary">
            {t("page.card.childrenCount", { count: data.childCount ?? 0 })}
          </Badge>
        )}
        {(m.attachmentCount ?? 0) > 0 && (
          <Badge variant="secondary">
            {t("page.card.attachmentsCount", { count: m.attachmentCount ?? 0 })}
          </Badge>
        )}
        {m.labels?.map((l) => (
          <Badge key={l} variant="outline">
            {l}
          </Badge>
        ))}
      </CardContent>
    </Card>
  );
}
