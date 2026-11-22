import { Bell, FilePenLine, FileText, PanelsTopLeft, Settings } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { BrowserApi } from "@/lib/browser/browser-api";
import { useFontSize } from "../hooks/useFontSize";
import { useI18n } from "../hooks/useI18n";
import { useSubscriptions } from "../hooks/useSubscriptions";
import { useTheme } from "../hooks/useTheme";
import { Button } from "../ui/button";
import { SegmentControl, type SegmentControlItem } from "../ui/segment-control";
import type { WorkspaceSection } from "../workspace/contracts";
import { failureMessageKey } from "../workspace/export-controller";
import { openWorkspaceTab } from "../workspace/open-workspace";
import { useWorkspaceShell } from "../workspace/WorkspaceProvider";
import { EditorRoundtripPanel } from "./EditorRoundtripPanel";
import { JobStatus } from "./JobStatus";
import { TabAccessNotice } from "./TabAccessNotice";

const SOURCE_BASE_WARNING_KEYS = {
  "invalid-url": "sourceBase.invalidUrl",
  "cross-origin": "sourceBase.crossOrigin",
  "path-mismatch": "sourceBase.pathMismatch",
} as const;

export function WorkspaceShell({ children }: { children: ReactNode }) {
  useFontSize();
  useTheme();
  const { locale, t } = useI18n();
  const { subscriptions } = useSubscriptions();
  const {
    tab,
    source,
    sourceKey,
    draft,
    patchDraft,
    controller,
    exportView,
    workspace,
    settings,
    binding,
    store,
    error,
  } = useWorkspaceShell();
  const [emptySection, setEmptySection] = useState<WorkspaceSection>("export");
  const [actionError, setActionError] = useState<string | null>(null);
  const section = draft?.section ?? emptySection;
  const contentRef = useRef<HTMLDivElement>(null);
  const previousSection = useRef(section);
  const previousPage = useRef<string | null>(null);
  const [sourceMoved, setSourceMoved] = useState(false);
  const editorIdentity = `${tab.tabId ?? draft?.source.tabId ?? ""}:${tab.host ?? draft?.source.baseUrl ?? ""}:${tab.pageId ?? ""}`;
  const workspaceSourceTabId =
    source?.tabId ??
    (tab.accessState === "host-access-missing" || tab.accessState === "injection-failed"
      ? tab.tabId
      : undefined);
  const pendingChanges = subscriptions.reduce((count, subscription) => {
    const diff = subscription.lastDiffSummary;
    return count + (diff ? diff.added + diff.removed + diff.changed + diff.moved : 0);
  }, 0);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dataset.surface = binding?.owner.surface ?? "panel";
    document.title = t("common.appName");
  }, [locale, t, binding?.owner.surface]);
  useEffect(() => {
    if (previousSection.current !== section) {
      previousSection.current = section;
      contentRef.current?.scrollTo({ top: 0 });
    }
  }, [section]);
  useEffect(() => {
    if (source?.pageUrl) {
      setSourceMoved(previousPage.current !== null && previousPage.current !== source.pageUrl);
      previousPage.current = source.pageUrl;
    }
  }, [source?.pageUrl]);
  const sections: SegmentControlItem<WorkspaceSection>[] = [
    {
      value: "export",
      label: t("sidepanel.sections.export"),
      icon: <FileText className="h-3 w-3 shrink-0" />,
    },
    {
      value: "edit",
      label: t("sidepanel.sections.edit"),
      icon: <FilePenLine className="h-3 w-3 shrink-0" />,
    },
    {
      value: "watch",
      label: t("sidepanel.sections.watch"),
      icon: <Bell className="h-3 w-3 shrink-0" />,
      badge:
        pendingChanges > 0 ? (
          <span className="text-[10px] tabular-nums">
            {pendingChanges > 99 ? "99+" : pendingChanges}
          </span>
        ) : null,
    },
  ];
  const changeSection = (next: WorkspaceSection) => {
    if (draft) patchDraft({ section: next });
    else setEmptySection(next);
  };
  const openWorkspace = async (tool: "export" | "edit") => {
    if (workspaceSourceTabId === undefined) return;
    setActionError(null);
    try {
      await store.flush();
      await openWorkspaceTab(workspaceSourceTabId, tool);
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const exportFailureKey = exportView.errorCode ? failureMessageKey(exportView.errorCode) : null;
  const notice =
    actionError ??
    error ??
    (exportFailureKey ? t(exportFailureKey) : exportView.error) ??
    (settings.error instanceof Error ? settings.error.message : null);
  const pinned = binding?.mode === "pinned";
  return (
    <div className="cx-workspace-shell">
      <header className="cx-workspace-header">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary text-xs font-bold text-primary-foreground"
            aria-hidden="true"
          >
            CX
          </span>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold">ConfX</h1>
            <p className="truncate text-[11px] text-muted-foreground">
              {t(pinned ? "composer.pinnedSource" : "composer.currentSource")}
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={workspaceSourceTabId === undefined}
          onClick={() => void openWorkspace(section === "edit" ? "edit" : "export")}
          aria-label={t("sidepanel.header.openWorkspace")}
        >
          <PanelsTopLeft className="h-3.5 w-3.5 shrink-0" />
          <span className="hidden sm:inline">{t("sidepanel.header.openWorkspace")}</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("sidepanel.header.settings")}
          onClick={() => {
            setActionError(null);
            void BrowserApi.openOptionsPage().catch((failure) =>
              setActionError(failure instanceof Error ? failure.message : String(failure)),
            );
          }}
        >
          <Settings className="h-4 w-4" />
        </Button>
      </header>
      <div className="cx-workspace-source">
        <p className="break-words text-xs font-medium">
          {tab.issueKey ??
            tab.title ??
            tab.host ??
            draft?.source.baseUrl ??
            t("sourceBase.sourceUnavailable")}
        </p>
        <p className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
          <span>
            {draft?.source.product === "confluence"
              ? "Confluence"
              : draft?.source.product === "jira"
                ? "Jira"
                : t("composer.htmlSource")}
          </span>
          <span>{t(source ? "composer.accessReady" : "composer.accessUnavailable")}</span>
        </p>
        {sourceMoved && (
          <p role="status" className="mt-1 text-xs text-muted-foreground">
            {t("composer.sourceMoved")}
          </p>
        )}
        {(section !== "export" || !draft || draft.scope === "subtree") && (
          <TabAccessNotice
            accessState={tab.accessState}
            accessOrigin={tab.accessOrigin}
            grantStatus={tab.grantStatus}
            onGrantAccess={tab.grantAccess}
            onRetry={tab.retry}
          />
        )}
        {workspace.hydrated && !source && (
          <p role="status" className="mt-2 text-xs text-muted-foreground">
            {t("sourceBase.sourceUnavailable")}
          </p>
        )}
        {binding?.owner.surface === "workspace" && workspace.hydrated && !source && (
          <SourceSelection onError={setActionError} />
        )}
      </div>
      {tab.baseOverrideDiagnostic && (
        <p role="status" className="border-b px-3 py-2 text-xs text-muted-foreground">
          {t(SOURCE_BASE_WARNING_KEYS[tab.baseOverrideDiagnostic])}
        </p>
      )}
      {notice && (
        <p role="alert" className="break-words border-b px-3 py-2 text-xs text-destructive">
          {notice}
        </p>
      )}
      {exportView.state && (
        <div className="cx-workspace-job">
          <JobStatus
            state={exportView.state}
            busy={exportView.busy}
            ownsJob={exportView.ownsJob}
            onCancel={() => controller?.cancel()}
            onFocusOwner={() => {
              setActionError(null);
              void controller
                ?.focusOwner()
                .catch((failure) =>
                  setActionError(failure instanceof Error ? failure.message : String(failure)),
                );
            }}
          />
        </div>
      )}
      <nav className="cx-workspace-nav" aria-label={t("sidepanel.header.primarySection")}>
        <SegmentControl
          ariaLabel={t("sidepanel.header.primarySection")}
          items={sections}
          value={section}
          onValueChange={changeSection}
        />
      </nav>
      <main ref={contentRef} className="cx-workspace-content">
        <div hidden={section === "edit"} className="min-w-0" key={sourceKey}>
          {children}
        </div>
        <section
          hidden={section !== "edit"}
          aria-label={t("sidepanel.sections.edit")}
          className="min-w-0"
        >
          <EditorRoundtripPanel
            key={editorIdentity}
            tab={tab}
            inWorkspace={binding?.owner.surface === "workspace"}
            onChooseInTab={
              workspaceSourceTabId !== undefined ? () => openWorkspace("edit") : undefined
            }
          />
        </section>
      </main>
    </div>
  );
}

function SourceSelection({ onError }: { onError: (message: string | null) => void }) {
  const { t } = useI18n();
  const [tabs, setTabs] = useState<Array<{ id: number; title: string }>>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(false);
  const [listed, setListed] = useState(false);
  const load = async () => {
    setLoading(true);
    onError(null);
    try {
      const candidates = await BrowserApi.queryTabs({});
      setTabs(
        candidates.flatMap((tab) => {
          if (!tab.id || !tab.url) return [];
          try {
            const url = new URL(tab.url);
            return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
              ? [{ id: tab.id, title: tab.title || url.hostname }]
              : [];
          } catch {
            return [];
          }
        }),
      );
      setListed(true);
    } catch (failure) {
      onError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="mt-2 space-y-2">
      <p className="text-xs text-muted-foreground">{t("composer.chooseSourceHelp")}</p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={loading}
        onClick={() => void load()}
      >
        {t("composer.listSources")}
      </Button>
      {listed && !loading && tabs.length === 0 && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("composer.noSources")}
        </p>
      )}
      {tabs.length > 0 && (
        <>
          <label className="block space-y-1 text-xs">
            <span>{t("composer.source")}</span>
            <select
              className="w-full min-w-0 rounded-md border bg-surface p-2"
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
            >
              <option value="">{t("composer.chooseSource")}</option>
              {tabs.map((tab) => (
                <option key={tab.id} value={tab.id}>
                  {tab.title}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            size="sm"
            disabled={!selected}
            onClick={() => {
              onError(null);
              void openWorkspaceTab(Number(selected), "export").catch((failure) =>
                onError(failure instanceof Error ? failure.message : String(failure)),
              );
            }}
          >
            {t("composer.useSource")}
          </Button>
        </>
      )}
    </div>
  );
}
