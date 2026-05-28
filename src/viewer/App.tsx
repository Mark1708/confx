import { useQuery } from "@tanstack/react-query";
import { Copy, Download, Loader2 } from "lucide-react";
import { marked } from "marked";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfluenceApi } from "@/lib/confluence-api";
import { extractFromHtml } from "@/lib/extractor";
import { ImageDedup } from "@/lib/image-fetcher";
import { getPreset } from "@/lib/rule-engine";
import { loadSettings } from "@/lib/settings";
import { slugify } from "@/lib/table-to-csv";
import { useFontSize } from "@/sidepanel/hooks/useFontSize";
import { useTheme } from "@/sidepanel/hooks/useTheme";

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

async function fetchMarkdown(params: ViewerParams): Promise<{ markdown: string; title: string }> {
  const settings = await loadSettings();
  const preset = getPreset(settings.activePresetId);
  const api = new ConfluenceApi(params.host);

  const raw = await api.getPage(params.pageId, [
    "body.view",
    "children.attachment",
    "ancestors",
    "space",
    "version",
    "metadata.labels",
  ]);
  const meta = api.toPageMeta(raw);
  const html = raw.body?.view?.value ?? "";

  const extracted = await extractFromHtml(api, html, meta, {
    rules: [...preset.rules, ...settings.customRules],
    folder: "",
    includeFrontMatter: settings.includeFrontMatter,
    rewriteLinks: false,
    dedup: settings.deduplicateImages ? new ImageDedup() : undefined,
  });

  return { markdown: extracted.markdown, title: meta.title };
}

async function fetchViewerMarkdown(params: ViewerParams | null): Promise<{ markdown: string; title: string }> {
  if (!params) throw new Error("Missing viewer parameters");
  return fetchMarkdown(params);
}

export function App() {
  useTheme();
  useFontSize();

  const params = useMemo(() => readParams(), []);
  const [mode, setMode] = useState<ViewMode>("formatted");
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);
  const renderedRef = useRef<HTMLDivElement | null>(null);

  const query = useQuery({
    queryKey: ["viewer-md", params?.host, params?.pageId],
    queryFn: () => fetchViewerMarkdown(params),
    enabled: !!params,
  });

  const displayTitle = query.data?.title ?? params?.title ?? "Просмотр Markdown";

  useEffect(() => {
    document.title = displayTitle;
  }, [displayTitle]);

  const rendered = useMemo(() => {
    if (!query.data?.markdown) return "";
    try {
      return marked.parse(query.data.markdown, { async: false, breaks: false, gfm: true }) as string;
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
      showFlash("Скопировано в буфер обмена");
    } catch (err) {
      console.error("[viewer] clipboard failed", err);
      showFlash("Не удалось скопировать");
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
    showFlash("Файл скачивается");
  }

  if (!params) {
    return (
      <div className="cx-viewer">
        <div className="cx-status error">
          В URL не переданы параметры <code>host</code> и <code>pageId</code>.
        </div>
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
            <div className="cx-viewer-kicker">Просмотр Markdown</div>
          </div>
        </div>

        <div className="cx-viewer-title-wrap">
          <div className="cx-viewer-title" title={displayTitle}>
            {displayTitle}
          </div>
        </div>

        <div className="cx-viewer-controls">
          <div className="cx-toggle" role="tablist" aria-label="Режим отображения">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "formatted"}
              className={mode === "formatted" ? "active" : ""}
              onClick={() => setMode("formatted")}
            >
              Форматированный
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "raw"}
              className={mode === "raw" ? "active" : ""}
              onClick={() => setMode("raw")}
            >
              Исходный
            </button>
          </div>

          <button
            type="button"
            className="cx-action"
            onClick={handleCopy}
            disabled={!query.data?.markdown}
            title="Скопировать markdown в буфер обмена"
          >
            <Copy />
            <span>Скопировать</span>
          </button>

          <button
            type="button"
            className="cx-action primary"
            onClick={handleDownload}
            disabled={!query.data?.markdown}
            title="Скачать как .md"
          >
            <Download />
            <span>Скачать</span>
          </button>
        </div>
      </header>

      <main className="cx-viewer-body">
        {query.isLoading && (
          <div className="cx-status">
            <Loader2 className="inline h-4 w-4 animate-spin" /> Загружаю страницу…
          </div>
        )}
        {query.isError && (
          <div className="cx-status error">
            Не удалось загрузить страницу: {(query.error as Error).message}
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
