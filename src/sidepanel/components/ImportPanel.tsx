import { Loader2, Upload } from "lucide-react";
import { type ChangeEvent, useMemo, useState } from "react";
import { createConfluenceApi } from "@/lib/create-api";
import {
  buildImportPlan,
  publishImportPlan,
  type ImportPagePlan,
  type ImportPlan,
  type PublishRowResult,
} from "@/lib/markdown-import";
import type { CurrentTabInfo } from "../hooks/useCurrentTab";
import { useI18n } from "../hooks/useI18n";
import { usePageInfo } from "../hooks/usePageInfo";
import { useSettings } from "../hooks/useSettings";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";

export function ImportPanel({ tab }: { tab: CurrentTabInfo }) {
  const { t } = useI18n();
  const pageInfo = usePageInfo(tab.host, tab.pageId);
  const { data: settings } = useSettings();
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [activePath, setActivePath] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<PublishRowResult[]>([]);

  const targetReady = Boolean(
    tab.host &&
    tab.pageId &&
    pageInfo.data?.meta?.id === tab.pageId &&
    pageInfo.data.meta.spaceKey &&
    !pageInfo.isPlaceholderData,
  );
  const selectedPage = plan?.pages.find((page) => page.path === activePath) ?? plan?.pages[0];
  const selectedCount = selectedPaths.size;
  const canPublish = Boolean(plan && selectedCount > 0 && !publishing);

  const pageByPath = useMemo(
    () => new Map(plan?.pages.map((page) => [page.path, page]) ?? []),
    [plan],
  );

  const buildPlanFromFiles = async (files: File[]) => {
    if (!targetReady || !tab.host || !pageInfo.data?.meta) return;
    setBuilding(true);
    setError(null);
    setRows([]);
    try {
      const api = await createConfluenceApi(tab.host);
      const nextPlan = await buildImportPlan(
        files,
        {
          host: api.host,
          spaceKey: pageInfo.data.meta.spaceKey,
          parentId: pageInfo.data.meta.id,
        },
        { maxAttachmentSize: settings?.maxAttachmentSize ?? 50 * 1024 * 1024 },
        api,
      );
      const selectable = nextPlan.pages
        .filter((page) => page.action !== "blocked" && page.previewHtml)
        .map((page) => page.path);
      setPlan(nextPlan);
      setSelectedPaths(new Set(selectable));
      setActivePath(nextPlan.pages[0]?.path ?? null);
    } catch (err) {
      setPlan(null);
      setSelectedPaths(new Set());
      setActivePath(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBuilding(false);
    }
  };

  const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length > 0) void buildPlanFromFiles(files);
  };

  const togglePath = (path: string) => {
    const page = pageByPath.get(path);
    if (!page || page.action === "blocked" || !page.previewHtml) return;
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const publish = async () => {
    if (!plan || !tab.host || selectedPaths.size === 0) return;
    if (!window.confirm(t("import.confirm", { count: selectedPaths.size }))) return;
    setPublishing(true);
    setError(null);
    try {
      const api = await createConfluenceApi(tab.host);
      const result = await publishImportPlan(plan, selectedPaths, api);
      setRows(result.rows);
      setSelectedPaths(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPublishing(false);
    }
  };

  if (!targetReady) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("import.title")}</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          {pageInfo.isLoading ? t("import.loadingContext") : t("import.unavailable")}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{t("import.title")}</h2>
          <p className="text-xs text-muted-foreground">{t("import.subtitle")}</p>
        </div>
        <Badge variant="warning">{t("import.wip")}</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("import.sourceTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2">
          <FileInput
            label={t("import.pickFiles")}
            accept=".md,text/markdown"
            multiple
            onChange={handleFiles}
          />
          <FileInput label={t("import.pickDirectory")} multiple onChange={handleFiles} directory />
          <FileInput
            label={t("import.pickZip")}
            accept=".zip,application/zip"
            onChange={handleFiles}
          />
          {building && (
            <StatusLine
              icon={<Loader2 className="h-3 w-3 animate-spin" />}
              text={t("import.building")}
            />
          )}
          {error && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </CardContent>
      </Card>

      {plan && (
        <Card>
          <CardHeader>
            <CardTitle>{t("import.reviewTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full min-w-[760px] text-left text-xs">
                <thead className="bg-surface-hover text-muted-foreground">
                  <tr>
                    <th className="p-2">{t("import.select")}</th>
                    <th className="p-2">{t("import.path")}</th>
                    <th className="p-2">{t("import.pageTitle")}</th>
                    <th className="p-2">{t("import.action")}</th>
                    <th className="p-2">{t("import.version")}</th>
                    <th className="p-2">{t("import.attachments")}</th>
                    <th className="p-2">{t("import.messages")}</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.pages.map((page) => (
                    <PageRow
                      key={page.path}
                      page={page}
                      checked={selectedPaths.has(page.path)}
                      active={page.path === selectedPage?.path}
                      onToggle={() => togglePath(page.path)}
                      onOpen={() => setActivePath(page.path)}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            <Button variant="accent" className="w-full" disabled={!canPublish} onClick={publish}>
              {publishing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              {t("import.publishSelected", { count: selectedCount })}
            </Button>
          </CardContent>
        </Card>
      )}

      {selectedPage && (
        <Card>
          <CardHeader>
            <CardTitle>{t("import.previewTitle", { title: selectedPage.title })}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <iframe
              title={t("import.previewFrame")}
              sandbox=""
              className="h-64 w-full rounded-md border border-border bg-white"
              srcDoc={`<base href="${escapeHtml(plan?.target.host ?? tab.host ?? "")}/">${selectedPage.previewHtml}`}
            />
            <pre className="max-h-64 overflow-auto rounded-md border border-border bg-surface-hover p-2 text-[10px] text-muted-foreground">
              {selectedPage.storage}
            </pre>
          </CardContent>
        </Card>
      )}

      {rows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t("import.publishResult")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-xs">
            {rows.map((row) => (
              <div key={row.path} className="rounded-md border border-border p-2">
                <span className="font-medium">{row.title}</span>: {t(`import.status.${row.status}`)}
                {row.error && <span className="text-destructive"> — {row.error}</span>}
                {row.url && (
                  <a
                    className="ml-2 text-primary underline"
                    href={row.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("import.openPage")}
                  </a>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function FileInput({
  label,
  directory,
  ...props
}: {
  label: string;
  directory?: boolean;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="grid gap-1 text-xs font-medium">
      <span>{label}</span>
      <Input type="file" {...props} {...(directory ? { webkitdirectory: "" } : {})} />
    </label>
  );
}

function PageRow({
  page,
  checked,
  active,
  onToggle,
  onOpen,
}: {
  page: ImportPagePlan;
  checked: boolean;
  active: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const blocked = page.action === "blocked" || !page.previewHtml;
  const messages = [...page.warnings, ...page.errors].join("; ");
  const bytes = page.assets.reduce((total, asset) => total + asset.file.size, 0);

  return (
    <tr className={active ? "bg-primary/5" : "border-t border-border"}>
      <td className="p-2">
        <input type="checkbox" checked={checked} disabled={blocked} onChange={onToggle} />
      </td>
      <td className="p-2">
        <button type="button" className="text-left text-primary underline" onClick={onOpen}>
          {page.path}
        </button>
      </td>
      <td className="p-2">{page.title}</td>
      <td className="p-2">{t(`import.actionValue.${page.action}`)}</td>
      <td className="p-2">{page.reviewedVersion ?? page.source?.version ?? "—"}</td>
      <td className="p-2">
        {page.assets.length} / {formatBytes(bytes)}
      </td>
      <td className="max-w-64 truncate p-2" title={messages}>
        {messages || "—"}
      </td>
    </tr>
  );
}

function StatusLine({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-surface-hover p-2 text-xs text-muted-foreground">
      {icon}
      {text}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
