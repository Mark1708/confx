import { useQuery } from "@tanstack/react-query";
import { Copy, Download, Loader2 } from "lucide-react";
import { marked } from "marked";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createConfluenceApi, toFetchOptions } from "@/lib/create-api";
import { extractFromHtml } from "@/lib/extractor";
import { loadSettings } from "@/lib/settings";
import { resolveSourceBase } from "@/lib/source-context";
import { slugify } from "@/lib/table-to-csv";
import { useFontSize } from "@/sidepanel/hooks/useFontSize";
import { useI18n } from "@/sidepanel/hooks/useI18n";
import { useTheme } from "@/sidepanel/hooks/useTheme";

import { sanitizeViewerHtml } from "@/viewer/sanitize";

type ViewMode = "formatted" | "raw";

interface ViewerParams {
  host: string;
  pageId: string;
  title?: string;
}

function readParams(): ViewerParams | null {
  const sp = new URLSearchParams(window.location.search);
  const host = sp.get("host") ?? "";
  const pageId = sp.get("pageId") ?? "";
  const title = sp.get("title") ?? undefined;
  if (!host || !pageId) return null;
  return { host, pageId, title };
}

async function fetchMarkdown(
  params: ViewerParams,
  signal?: AbortSignal,
): Promise<{ markdown: string; title: string }> {
  const settings = await loadSettings();
  signal?.throwIfAborted();
  const { baseUrl } = resolveSourceBase(params.host, params.host, settings.confluenceBaseUrl);
  const api = createConfluenceApi(baseUrl, toFetchOptions(settings));

  const raw = await api.getPage(
    params.pageId,
    [
      "body.view",
      "body.storage",
      "children.attachment",
      "ancestors",
      "space",
      "version",
      "metadata.labels",
    ],
    signal,
  );
  signal?.throwIfAborted();
  const meta = api.toPageMeta(raw);
  const html = raw.body?.view?.value ?? "";

  const extracted = await extractFromHtml(api, html, meta, {
    rules: [...settings.exportDefaults.conversion.presetRules, ...settings.customRules],
    folder: "",
    includeFrontMatter: settings.exportDefaults.conversion.includeFrontMatter,
    includeEditable: false,
    exportImages: false,
    exportAttachments: false,
    exportPlantUmlAssets: false,
    storageHtml: raw.body?.storage?.value,
    rewriteLinks: false,
    includeComments: false,
    includeHistory: false,
    signal,
  });

  return { markdown: extracted.markdown, title: meta.title };
}

async function fetchViewerMarkdown(
  params: ViewerParams | null,
  signal?: AbortSignal,
): Promise<{ markdown: string; title: string }> {
  if (!params) throw new Error("Missing viewer parameters");
  return fetchMarkdown(params, signal);
}

export function App() {
  useTheme();
  useFontSize();
  const { locale, t } = useI18n();

  const params = useMemo(() => readParams(), []);
  const [mode, setMode] = useState<ViewMode>("formatted");
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);
  const renderedRef = useRef<HTMLDivElement | null>(null);

  const query = useQuery({
    queryKey: ["viewer-md", params?.host, params?.pageId],
    queryFn: ({ signal }) => fetchViewerMarkdown(params, signal),
    enabled: !!params,
  });

  const displayTitle = query.data?.title ?? params?.title ?? t("viewer.defaultTitle");

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = displayTitle;
  }, [displayTitle, locale]);

  const rendered = useMemo(() => {
    if (!query.data?.markdown) return "";
    try {
      return sanitizeViewerHtml(
        marked.parse(query.data.markdown, {
          async: false,
          breaks: false,
          gfm: true,
        }) as string,
      );
    } catch (err) {
      console.error("[viewer] marked parse error", err);
      return "";
    }
  }, [query.data?.markdown]);

  useEffect(() => {
    if (!renderedRef.current) return;
    renderedRef.current.innerHTML = rendered;
  }, [rendered]);

  const setRenderedNode = useCallback(
    (node: HTMLDivElement | null) => {
      renderedRef.current = node;
      if (!node) return;
      node.innerHTML = rendered;
    },
    [rendered],
  );

  function showFlash(msg: string): void {
    setFlash(msg);
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 1800);
  }

  async function handleCopy(): Promise<void> {
    if (!query.data?.markdown) return;
    try {
      await navigator.clipboard.writeText(query.data.markdown);
      showFlash(t("viewer.copied"));
    } catch (err) {
      console.error("[viewer] clipboard failed", err);
      showFlash(t("viewer.copyFailed"));
    }
  }

  function handleDownload(): void {
    if (!query.data?.markdown) return;
    const blob = new Blob([query.data.markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const base = slugify(displayTitle) || `page-${params?.pageId ?? "unknown"}`;
    a.href = url;
    a.download = `${base}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    showFlash(t("viewer.downloading"));
  }

  if (!params) {
    return (
      <div className="cx-viewer">
        <div className="cx-status error">{t("viewer.missingParams")}</div>
      </div>
    );
  }

  return (
    <div className="cx-viewer">
      <header className="cx-viewer-header">
        <div className="cx-viewer-brand">
          <div className="cx-viewer-logo" aria-hidden="true">
            CX
          </div>
          <div className="cx-viewer-heading">
            <div className="cx-viewer-name">ConfX</div>
            <div className="cx-viewer-kicker">{t("viewer.kicker")}</div>
          </div>
        </div>

        <div className="cx-viewer-title-wrap">
          <div className="cx-viewer-title" title={displayTitle}>
            {displayTitle}
          </div>
        </div>

        <div className="cx-viewer-controls">
          <div className="cx-toggle" role="tablist" aria-label={t("viewer.displayMode")}>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "formatted"}
              className={mode === "formatted" ? "active" : ""}
              onClick={() => setMode("formatted")}
            >
              {t("viewer.formatted")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "raw"}
              className={mode === "raw" ? "active" : ""}
              onClick={() => setMode("raw")}
            >
              {t("viewer.raw")}
            </button>
          </div>

          <button
            type="button"
            className="cx-action"
            onClick={handleCopy}
            disabled={!query.data?.markdown}
            title={t("viewer.copyTitle")}
          >
            <Copy />
            <span>{t("viewer.copy")}</span>
          </button>

          <button
            type="button"
            className="cx-action primary"
            onClick={handleDownload}
            disabled={!query.data?.markdown}
            title={t("viewer.downloadTitle")}
          >
            <Download />
            <span>{t("viewer.download")}</span>
          </button>
        </div>
      </header>

      <main className="cx-viewer-body">
        {query.isLoading && (
          <div className="cx-status">
            <Loader2 className="inline h-4 w-4 animate-spin" /> {t("viewer.loading")}
          </div>
        )}
        {query.isError && (
          <div className="cx-status error">
            {t("viewer.loadError", { message: (query.error as Error).message })}
          </div>
        )}
        {query.data && mode === "formatted" && <div ref={setRenderedNode} className="cx-prose" />}
        {query.data && mode === "raw" && <pre className="cx-raw">{query.data.markdown}</pre>}
      </main>

      <div className={`cx-flash ${flash ? "show" : ""}`} aria-live="polite">
        {flash ?? ""}
      </div>
    </div>
  );
}
