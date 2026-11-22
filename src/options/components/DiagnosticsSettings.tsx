import { Download } from "lucide-react";
import { useState } from "react";
import { BrowserApi } from "@/lib/browser/browser-api";
import { storage } from "@/lib/browser/storage";
import { EXPORT_ACTIVE_KEY, loadJobState } from "@/lib/export-state";
import { useI18n } from "../../sidepanel/hooks/useI18n";
import { Button } from "../../sidepanel/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../sidepanel/ui/card";

const SAFE_REASON_CODES: Readonly<Record<string, true>> = {
  "permission-denied": true,
  "writer-failure": true,
  "zip-limit-exceeded": true,
  "destination-collision": true,
  cancelled: true,
  "owner-lost": true,
  "legacy-owner-unavailable": true,
  "owner-closed": true,
  "lock-unavailable": true,
};

/** Explicit projection only: never export a snapshot, settings object or raw error. */
export async function collectSafeDiagnostics() {
  const manifest = BrowserApi.getManifest();
  const pointer = await storage.session.get(EXPORT_ACTIVE_KEY);
  const activeId = pointer[EXPORT_ACTIVE_KEY];
  const job = typeof activeId === "string" ? await loadJobState(activeId) : null;
  return {
    schema: 1,
    extension: { version: manifest.version, manifestVersion: manifest.manifest_version },
    surface: "options",
    secureContext: globalThis.isSecureContext === true,
    capabilities: {
      directoryPicker: typeof Reflect.get(globalThis, "showDirectoryPicker") === "function",
      webLocks: typeof navigator.locks?.request === "function",
      downloads: typeof chrome.downloads?.download === "function",
      sidePanel: typeof chrome.sidePanel?.open === "function",
    },
    lastExport: job
      ? {
          status: job.status,
          phase: job.phase,
          reasonCode:
            job.terminalReason && Object.hasOwn(SAFE_REASON_CODES, job.terminalReason)
              ? job.terminalReason
              : null,
        }
      : null,
  };
}

export function DiagnosticsSettings() {
  const { t } = useI18n();
  const [report, setReport] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exportReport = async () => {
    setExporting(true);
    setError(false);
    let url: string | undefined;
    try {
      const json = JSON.stringify(await collectSafeDiagnostics(), null, 2);
      setReport(json);
      url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "confx-diagnostics.json";
      link.click();
    } catch {
      setError(true);
    } finally {
      if (url) URL.revokeObjectURL(url);
      setExporting(false);
    }
  };
  return (
    <section id="diagnostics" className="cx-options-section">
      <Card className="cx-options-card">
        <CardHeader className="cx-options-card-header">
          <CardTitle>{t("options.sections.diagnostics")}</CardTitle>
          <CardDescription>{t("options.diagnostics.description")}</CardDescription>
        </CardHeader>
        <CardContent className="cx-options-card-content cx-options-settings-stack">
          <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
            <li>{t("options.diagnostics.includes")}</li>
            <li>{t("options.diagnostics.excludes")}</li>
          </ul>
          <Button
            type="button"
            variant="outline"
            disabled={exporting}
            onClick={() => void exportReport()}
          >
            <Download className="h-4 w-4" />
            {t("options.diagnostics.export")}
          </Button>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {t("options.diagnostics.failed")}
            </p>
          )}
          {report && (
            <details>
              <summary className="cursor-pointer text-xs">
                {t("options.diagnostics.preview")}
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto rounded-md border p-2 text-xs">
                {report}
              </pre>
            </details>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
