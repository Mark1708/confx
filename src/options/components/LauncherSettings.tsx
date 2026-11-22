import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  getLauncherSites,
  launcherSiteKey,
  loadLauncherState,
  type LauncherProduct,
  resetLauncherSite,
  updateLauncherSite,
  watchLauncherState,
} from "@/lib/launcher-state";
import { useI18n } from "@/sidepanel/hooks/useI18n";
import { useSettings } from "@/sidepanel/hooks/useSettings";
import { Button } from "@/sidepanel/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/sidepanel/ui/card";
import { Label } from "@/sidepanel/ui/label";
import { Switch } from "@/sidepanel/ui/switch";

const LAUNCHER_QUERY = ["launcher-sites"] as const;

interface SiteAction {
  origin: string;
  product: LauncherProduct;
  action: "restore" | "reset";
}

export function LauncherSettings() {
  const { data: settings, updateAsync, saving } = useSettings();
  const { t } = useI18n();
  const client = useQueryClient();
  const [settingsError, setSettingsError] = useState(false);
  const siteRevision = useRef(0);
  const sitesQuery = useQuery({
    queryKey: LAUNCHER_QUERY,
    queryFn: async () => {
      for (;;) {
        const revision = siteRevision.current;
        try {
          const state = await loadLauncherState();
          if (revision === siteRevision.current) return state;
        } catch (error) {
          if (revision === siteRevision.current) throw error;
        }
      }
    },
    staleTime: Infinity,
    retry: false,
  });
  const siteMutation = useMutation({
    mutationFn: ({ origin, product, action }: SiteAction) =>
      action === "reset"
        ? resetLauncherSite(origin, product)
        : updateLauncherSite(origin, product, { hidden: false }),
    onSuccess: () => {
      siteRevision.current++;
      return client.invalidateQueries({ queryKey: LAUNCHER_QUERY }, { cancelRefetch: false });
    },
  });

  useEffect(() => {
    const refresh = () => {
      siteRevision.current++;
      void client.invalidateQueries({ queryKey: LAUNCHER_QUERY }, { cancelRefetch: false });
    };
    const unsubscribe = watchLauncherState(refresh);
    // Cover notifications before the effect subscribed and cached data from a previous mount.
    refresh();
    return unsubscribe;
  }, [client]);

  const sites = getLauncherSites(sitesQuery.data ?? {});
  const changeVisibility = (key: "showConfluenceButton" | "showJiraButton", value: boolean) => {
    setSettingsError(false);
    void updateAsync({ [key]: value }).catch(() => setSettingsError(true));
  };

  return (
    <section id="launcher" className="cx-options-section">
      <Card className="cx-options-card">
        <CardHeader className="cx-options-card-header">
          <CardTitle>{t("launcher.title")}</CardTitle>
          <CardDescription>{t("launcher.description")}</CardDescription>
        </CardHeader>
        <CardContent className="cx-options-card-content cx-options-settings-stack">
          {(["showConfluenceButton", "showJiraButton"] as const).map((key) => (
            <div key={key} className="flex items-center justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <Label htmlFor={`launcher-${key}`}>{t(`settings.toggles.${key}.label`)}</Label>
                <p id={`launcher-${key}-help`} className="text-xs text-muted-foreground">
                  {t(`settings.toggles.${key}.description`)}
                </p>
              </div>
              <Switch
                id={`launcher-${key}`}
                aria-describedby={`launcher-${key}-help`}
                className="min-h-6 min-w-10"
                checked={settings?.[key] ?? false}
                disabled={!settings || saving}
                onCheckedChange={(value) => changeVisibility(key, value)}
              />
            </div>
          ))}
          <p className="text-xs text-muted-foreground">{t("launcher.help")}</p>
          <div className="space-y-3 border-t pt-4">
            <h3 className="text-sm font-medium">{t("launcher.siteOverrides")}</h3>
            <p className="text-xs text-muted-foreground">{t("launcher.localOnly")}</p>
            {sitesQuery.isPending ? (
              <p role="status" className="text-sm">
                {t("launcher.loading")}
              </p>
            ) : null}
            {sitesQuery.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {t("launcher.loadFailed")}
              </p>
            ) : null}
            {!sitesQuery.isPending && !sitesQuery.isError && sites.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("launcher.noSites")}</p>
            ) : null}
            <ul className="space-y-2">
              {sites.map(({ origin, product, override }) => {
                const key = launcherSiteKey(origin, product);
                const label = `${origin} · ${t(`settings.diagnostics.kinds.${product}`)}`;
                return (
                  <li key={key}>
                    <div
                      role="group"
                      aria-label={label}
                      data-launcher-site={key}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                    >
                      <div className="min-w-0 flex-1 basis-48">
                        <p className="break-all text-sm font-medium">{label}</p>
                        <p className="text-xs text-muted-foreground">
                          {override.hidden ? t("launcher.hidden") : t("launcher.visible")}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={siteMutation.isPending || !override.hidden}
                          onClick={() =>
                            siteMutation.mutate({ origin, product, action: "restore" })
                          }
                        >
                          {t("launcher.restoreSite")}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={siteMutation.isPending}
                          onClick={() => siteMutation.mutate({ origin, product, action: "reset" })}
                        >
                          {t("launcher.resetSite")}
                        </Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
          {settingsError || siteMutation.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {t("launcher.saveFailed")}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}
