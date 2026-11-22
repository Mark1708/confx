import { useEffect } from "react";
import { useFontSize } from "../sidepanel/hooks/useFontSize";
import { useI18n } from "../sidepanel/hooks/useI18n";
import { useSettings } from "../sidepanel/hooks/useSettings";
import { useTheme } from "../sidepanel/hooks/useTheme";
import { AdvancedSettings } from "./components/AdvancedSettings";
import { AppearanceSettings } from "./components/AppearanceSettings";
import { DefaultsSettings } from "./components/DefaultsSettings";
import { DiagnosticsSettings } from "./components/DiagnosticsSettings";
import { LauncherSettings } from "./components/LauncherSettings";

const SECTIONS = ["defaults", "appearance", "launcher", "advanced", "diagnostics"] as const;

export function OptionsApp() {
  const { data: settings, error } = useSettings();
  const { locale, t } = useI18n();
  useTheme();
  useFontSize();
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dataset.surface = "options";
    document.title = t("settings.title");
  }, [locale, t]);
  return (
    <div className="cx-options">
      <aside className="cx-options-sidebar" aria-label={t("options.sidebar.aria")}>
        <div className="cx-options-brand">
          <span className="cx-options-logo" aria-hidden="true">
            CX
          </span>
          <h1 className="cx-options-brand-title">{t("settings.title")}</h1>
        </div>
        <nav className="cx-options-nav">
          {SECTIONS.map((section) => (
            <a
              key={section}
              className="cx-options-nav-link"
              href={`#${section}`}
              onClick={() => {
                if (section === "advanced") {
                  const advanced =
                    document.querySelector<HTMLDetailsElement>("#advanced > details");
                  if (advanced) advanced.open = true;
                }
              }}
            >
              {section === "launcher" ? t("launcher.title") : t(`options.sections.${section}`)}
            </a>
          ))}
        </nav>
      </aside>
      <main className="cx-options-main">
        <header className="cx-options-hero">
          <h2>{t("options.hero.title")}</h2>
          <p>{t("options.hero.description")}</p>
        </header>
        {error && (
          <p role="alert" className="mb-3 break-words text-xs text-destructive">
            {error.message}
          </p>
        )}
        {settings ? (
          <>
            <DefaultsSettings />
            <AppearanceSettings />
            <LauncherSettings />
            <AdvancedSettings />
            <DiagnosticsSettings />
          </>
        ) : (
          <p role="status" className="text-xs text-muted-foreground">
            {t("options.sections.loading")}
          </p>
        )}
      </main>
    </div>
  );
}
