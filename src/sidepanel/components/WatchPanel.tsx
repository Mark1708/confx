import {
  ArrowRightLeft,
  Bell,
  CheckCircle2,
  Download,
  FileText,
  FolderTree,
  Loader2,
  Minus,
  PencilLine,
  Plus,
  RefreshCw,
  Trash2,
  XCircle,
} from "lucide-react";
import { useMemo } from "react";
import { canonicalBaseUrl, type SourceContext } from "@/lib/source-context";
import type { DiffEntry, Subscription, SubscriptionDiff } from "@/lib/subscriptions";
import { useExtractJob } from "../hooks/useExtractJob";
import { useI18n } from "../hooks/useI18n";
import { useCheckSubscription, useSubscriptions } from "../hooks/useSubscriptions";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Progress } from "../ui/progress";
import { Separator } from "../ui/separator";
import { useWorkspace } from "../workspace/WorkspaceProvider";
import { DESTINATION_LABEL_KEYS } from "./ExportDestination";
import { getPresetName } from "./PresetSelector";
import { getExportTemplate } from "@/lib/rule-engine";

function matchesSubscriptionSource(host: string, source: SourceContext | null): boolean {
  if (source?.product !== "confluence") return false;
  try {
    return canonicalBaseUrl(host) === canonicalBaseUrl(source.baseUrl);
  } catch {
    return false;
  }
}

export function WatchPanel() {
  const { t } = useI18n();
  const { subscriptions, loading, error, remove } = useSubscriptions();
  const { draft, patchDraft } = useWorkspace();
  const { expandedId } = draft.watch;

  if (loading) {
    return (
      <div className="min-w-0 space-y-3">
        <h2 className="text-sm font-semibold">{t("watch.title")}</h2>
        <Card>
          <CardContent className="space-y-3 p-3 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              {t("watch.loading")}
            </div>
            <div className="space-y-2">
              <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
              <div className="h-8 w-full animate-pulse rounded-md bg-muted" />
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-w-0 space-y-3">
        <h2 className="text-sm font-semibold">{t("watch.title")}</h2>
        <p role="alert" className="text-xs text-destructive">
          {error.message}
        </p>
      </div>
    );
  }

  if (!subscriptions.length) {
    return (
      <div className="min-w-0 space-y-3">
        <h2 className="text-sm font-semibold">{t("watch.title")}</h2>
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="space-y-3 p-3 text-xs text-muted-foreground wide-panel:p-4">
            <div className="flex min-w-0 items-start gap-2 wide-panel:gap-3">
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface shadow-[0_0_16px_hsl(var(--accent-glow))] wide-panel:h-9 wide-panel:w-9">
                <Bell className="h-4 w-4 text-primary" />
              </div>
              <div className="min-w-0 space-y-1">
                <div className="font-medium text-foreground">{t("watch.emptyTitle")}</div>
                <p>
                  {t("watch.emptyDescriptionStart")} <b>{t("sidepanel.scopes.page")}</b>{" "}
                  {t("watch.emptyDescriptionMiddle")} <b>{t("sidepanel.scopes.subtree")}</b>{" "}
                  {t("watch.emptyDescriptionEnd")}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-3">
      <h2 className="text-sm font-semibold">
        {t("watch.title")}
        <Badge className="ml-2" variant="secondary">
          {subscriptions.length}
        </Badge>
      </h2>

      {subscriptions.map((sub) => (
        <SubscriptionRow
          key={sub.id}
          sub={sub}
          expanded={expandedId === sub.id}
          onToggle={() =>
            patchDraft({
              watch: { ...draft.watch, expandedId: expandedId === sub.id ? null : sub.id },
            })
          }
          onExpand={() => patchDraft({ watch: { ...draft.watch, expandedId: sub.id } })}
          onDelete={() => remove(sub.id)}
        />
      ))}
    </div>
  );
}

interface RowProps {
  sub: Subscription;
  expanded: boolean;
  onToggle: () => void;
  onExpand: () => void;
  onDelete: () => void;
}

function SubscriptionRow({ sub, expanded, onToggle, onExpand, onDelete }: RowProps) {
  const { t } = useI18n();
  const check = useCheckSubscription();
  const { source, tab } = useWorkspace();
  const matchesSource = matchesSubscriptionSource(sub.host, source);
  const available = matchesSource && tab.accessState === "available";
  const total = Object.keys(sub.snapshot).length;
  const pendingChanges =
    (sub.lastDiffSummary?.added ?? 0) +
    (sub.lastDiffSummary?.removed ?? 0) +
    (sub.lastDiffSummary?.changed ?? 0) +
    (sub.lastDiffSummary?.moved ?? 0);
  const savedDiff = expanded && pendingChanges > 0 ? sub.checkHistory?.at(-1)?.diff : undefined;
  const diff = check.state.diff ?? savedDiff;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <CardTitle className="flex min-w-0 items-center gap-2">
              {sub.scope === "subtree" ? (
                <FolderTree className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <button
                type="button"
                onClick={onToggle}
                aria-expanded={expanded}
                className="min-w-0 line-clamp-2 text-left hover:underline"
              >
                {sub.rootTitle}
              </button>
            </CardTitle>
            <CardDescription className="break-words">
              {pendingChanges > 0 ? t("watch.hasChanges") : t("watch.noPendingChanges")}
            </CardDescription>
          </div>
          {sub.spaceKey && (
            <Badge
              className="ml-auto max-w-[4.5rem] shrink-0 truncate wide-panel:max-w-[6rem]"
              variant="outline"
            >
              {sub.spaceKey}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2 p-3 pt-0 text-[11px]">
        <div className="flex min-w-0 flex-wrap items-center gap-1 text-muted-foreground">
          <Badge variant="secondary">
            {sub.scope === "subtree" ? t("watch.scopeSubtree") : t("watch.scopePage")}
          </Badge>
          <Badge variant="secondary">{t("watch.pagesShort", { count: total })}</Badge>
          {pendingChanges > 0 ? (
            <Badge variant="default">{t("watch.changesCount", { count: pendingChanges })}</Badge>
          ) : (
            <Badge variant="success">{t("watch.upToDate")}</Badge>
          )}
          <span className="min-w-0 break-all font-mono text-[10px] wide-panel:ml-auto">
            {sub.lastCheckedAt ? formatDate(sub.lastCheckedAt) : t("watch.never")}
          </span>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            className="min-w-[6.5rem] flex-1"
            disabled={check.state.running || !available}
            onClick={() => {
              if (!available) return;
              onExpand();
              void check.run(sub);
            }}
          >
            {check.state.running ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            {t("watch.check")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete} title={t("watch.deleteTitle")}>
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>

        {!matchesSource && (
          <p role="status" className="text-warning">
            {t("watch.sourceMismatch", { host: sub.host })}
          </p>
        )}

        {check.state.running && (
          <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-2">
            <div className="flex min-w-0 items-center gap-2 text-xs">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span className="min-w-0 flex-1 truncate">{check.state.message}</span>
              <span className="font-mono text-muted-foreground">{check.state.visited}</span>
            </div>
            <Progress value={Math.min(100, (check.state.visited / Math.max(total, 1)) * 100)} />
          </div>
        )}

        {check.state.error && (
          <div className="flex min-w-0 items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">{check.state.error}</span>
          </div>
        )}

        {diff && (
          <DiffView
            sub={sub}
            diff={diff}
            onAccept={check.state.nextSnapshot ? check.accept : undefined}
            onClose={() => {
              check.reset();
              if (expanded) onToggle();
            }}
          />
        )}

        {expanded && !diff && !check.state.running && <LastSummary sub={sub} />}
      </CardContent>
    </Card>
  );
}

function LastSummary({ sub }: { sub: Subscription }) {
  const { t } = useI18n();
  const s = sub.lastDiffSummary;
  const history = sub.checkHistory ?? [];
  return (
    <div className="min-w-0 space-y-2 rounded-md border border-border/60 bg-muted/30 p-2 text-[10px] text-muted-foreground">
      <div>
        ID: <span className="break-all font-mono">{sub.rootId}</span>
      </div>
      <div>{t("watch.created", { date: formatDate(sub.createdAt) })}</div>
      {s && (
        <div className="mt-1">
          {t("watch.lastCheck", {
            added: s.added,
            removed: s.removed,
            changed: s.changed,
            moved: s.moved,
          })}
        </div>
      )}
      <div className="space-y-1">
        <div className="font-medium text-foreground">{t("watch.historyTitle")}</div>
        {history.length === 0 ? (
          <div>{t("watch.historyEmpty")}</div>
        ) : (
          <ul className="space-y-0.5">
            {history
              .slice(-5)
              .reverse()
              .map((entry) => (
                <li key={entry.checkedAt} className="break-words font-mono">
                  {t("watch.historyEntry", {
                    date: formatDate(entry.checkedAt),
                    added: entry.summary.added,
                    removed: entry.summary.removed,
                    changed: entry.summary.changed,
                    moved: entry.summary.moved,
                  })}
                </li>
              ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface DiffProps {
  sub: Subscription;
  diff: SubscriptionDiff;
  onAccept?: () => void;
  onClose: () => void;
}

function DiffView({ sub, diff, onAccept, onClose }: DiffProps) {
  const { t } = useI18n();
  const extract = useExtractJob();
  const preset = extract.defaults.presetId;

  const downloadable = useMemo(() => [...diff.added, ...diff.changed], [diff]);
  const { source, tab, draft, patchDraft, binding } = useWorkspace();
  const selectedPageIds = draft.watch.selectedPageIds[sub.id];
  const selected = useMemo(() => {
    const requested = selectedPageIds === undefined ? undefined : new Set(selectedPageIds);
    const ids = new Set<string>();
    for (const entry of downloadable) {
      if (!requested || requested.has(entry.pageId)) ids.add(entry.pageId);
    }
    return ids;
  }, [downloadable, selectedPageIds]);
  const matchesSource = matchesSubscriptionSource(sub.host, source);
  const available = matchesSource && tab.accessState === "available";
  const toggle = (id: string) => {
    if (extract.draftLocked) return;
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    patchDraft({
      watch: {
        ...draft.watch,
        selectedPageIds: { ...draft.watch.selectedPageIds, [sub.id]: [...next] },
      },
    });
  };

  const total = diff.added.length + diff.removed.length + diff.changed.length + diff.moved.length;
  if (total === 0) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-success/30 bg-success/5 p-2 text-xs">
        <CheckCircle2 className="h-3.5 w-3.5 text-success" />
        <span className="flex-1">{t("watch.noChanges")}</span>
        <Button size="sm" variant="ghost" onClick={onClose}>
          OK
        </Button>
      </div>
    );
  }

  const downloadSelected = async () => {
    if (!available || extract.busy || selected.size === 0) return;
    await extract.run({
      kind: "extract-watch-changed",
      host: sub.host,
      presetId: preset,
      pageIds: downloadable
        .filter((entry) => selected.has(entry.pageId))
        .map((entry) => entry.pageId),
      rootTitle: sub.rootTitle,
      diff,
    });
  };

  return (
    <div className="min-w-0 space-y-2 rounded-md border border-border bg-background p-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs wide-panel:gap-2">
        <span className="font-medium">{t("watch.diffTitle")}</span>
        <span className="font-mono text-muted-foreground">{total}</span>
        <span className="ml-auto flex min-w-0 flex-wrap gap-1">
          {onAccept && (
            <Button size="sm" variant="accent" onClick={onAccept}>
              {t("watch.accept")}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t("watch.close")}
          </Button>
        </span>
      </div>
      {!onAccept && <p className="text-muted-foreground">{t("watch.recheckToAccept")}</p>}
      <Separator />

      <DiffSection
        label={t("watch.added")}
        icon={<Plus className="h-3 w-3 text-emerald-600" />}
        entries={diff.added}
        selectable
        disabled={extract.draftLocked}
        selected={selected}
        onToggle={toggle}
      />
      <DiffSection
        label={t("watch.changed")}
        icon={<PencilLine className="h-3 w-3 text-amber-600" />}
        entries={diff.changed}
        selectable
        disabled={extract.draftLocked}
        selected={selected}
        onToggle={toggle}
      />
      <DiffSection
        label={t("watch.moved")}
        icon={<ArrowRightLeft className="h-3 w-3 text-sky-600" />}
        entries={diff.moved}
      />
      <DiffSection
        label={t("watch.removed")}
        icon={<Minus className="h-3 w-3 text-destructive" />}
        entries={diff.removed}
      />

      {downloadable.length > 0 && (
        <div className="space-y-1 rounded-md border p-2 text-xs">
          <p>
            {getPresetName(t, getExportTemplate(preset))} ·{" "}
            {t(DESTINATION_LABEL_KEYS[draft.destination])}
          </p>
          <Button
            type="button"
            size="sm"
            variant="link"
            onClick={() => patchDraft({ section: "export" })}
          >
            {t("composer.changePackage")}
          </Button>
          {extract.defaultsError && (
            <p role="alert" className="text-destructive">
              {extract.defaultsError}
            </p>
          )}
          {binding?.owner.surface !== "workspace" && (
            <p className="text-muted-foreground">{t("composer.watchWorkspaceHelp")}</p>
          )}
        </div>
      )}

      {downloadable.length > 0 && (
        <Button
          size="sm"
          className="w-full"
          onClick={downloadSelected}
          disabled={!available || extract.busy || selected.size === 0}
        >
          <Download className="h-3 w-3" />
          {binding?.owner.surface !== "workspace"
            ? t("composer.continueWorkspace")
            : t("watch.exportChanged", { count: selected.size })}
        </Button>
      )}
    </div>
  );
}

interface DiffSectionProps {
  label: string;
  icon: React.ReactNode;
  entries: DiffEntry[];
  selectable?: boolean;
  disabled?: boolean;
  selected?: Set<string>;
  onToggle?: (id: string) => void;
}

function DiffSection({
  label,
  icon,
  entries,
  selectable,
  selected,
  disabled,
  onToggle,
}: DiffSectionProps) {
  if (!entries.length) return null;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1 text-[11px] font-medium">
        {icon}
        <span>{label}</span>
        <span className="text-muted-foreground">({entries.length})</span>
      </div>
      <ul className="min-w-0 space-y-0.5 pl-1 wide-panel:pl-4">
        {entries.map((e) => (
          <li
            key={e.pageId}
            className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] wide-panel:gap-x-2"
          >
            {selectable && selected && onToggle && (
              <input
                type="checkbox"
                className="h-3 w-3"
                checked={selected.has(e.pageId)}
                disabled={disabled}
                aria-label={e.title}
                onChange={() => onToggle(e.pageId)}
              />
            )}
            <span className="min-w-0 flex-1 truncate">{e.title}</span>
            {e.fromVersion != null && e.toVersion != null && (
              <span className="shrink-0 font-mono text-muted-foreground">
                v{e.fromVersion}→v{e.toVersion}
              </span>
            )}
            {e.toVersion != null && e.fromVersion == null && (
              <span className="shrink-0 font-mono text-muted-foreground">v{e.toVersion}</span>
            )}
            {e.updatedBy && (
              <span className="max-w-[56px] truncate text-muted-foreground wide-panel:max-w-[80px]">
                {e.updatedBy}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: "2-digit",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
