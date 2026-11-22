import { Download, PanelsTopLeft } from "lucide-react";
import type { ReactNode } from "react";
import type { I18nKey } from "@/i18n";
import type { ExtractRequest } from "@/lib/export/contracts";
import { getExportTemplate } from "@/lib/rule-engine";
import type { ExportDefaults, ExtractionRule } from "@/types";
import { useExtractJob } from "../hooks/useExtractJob";
import { useI18n } from "../hooks/useI18n";
import { usePageInfo } from "../hooks/usePageInfo";
import { useSettings } from "../hooks/useSettings";
import { Button } from "../ui/button";
import { SegmentControl, type SegmentControlItem } from "../ui/segment-control";
import type { ExportScope } from "../workspace/contracts";
import { destinationCapability } from "../workspace/destinations";
import { useWorkspace } from "../workspace/WorkspaceProvider";
import {
  DESTINATION_LABEL_KEYS,
  DESTINATION_REASON_KEYS,
  ExportDestination,
} from "./ExportDestination";
import { JiraPanel } from "./JiraPanel";
import { PagePanel } from "./PagePanel";
import { PickerPanel } from "./PickerPanel";
import { getPresetName, PresetSelector } from "./PresetSelector";
import { SpacePanel } from "./SpacePanel";
import { SubtreePanel } from "./SubtreePanel";

const SCOPE_KEYS: Record<ExportScope, I18nKey> = {
  page: "sidepanel.scopes.page",
  subtree: "sidepanel.scopes.subtree",
  space: "sidepanel.scopes.space",
  fragment: "sidepanel.scopes.fragment",
  issue: "sidepanel.scopes.issue",
  search: "sidepanel.scopes.search",
};
const PACKAGE_KEYS = {
  editable: "options.package.editable",
  images: "options.package.images",
  attachments: "options.package.attachments",
  plantUmlAssets: "options.package.plantUmlAssets",
  comments: "options.package.comments",
  history: "options.package.history",
} as const;
const removesContent = (rule: ExtractionRule) =>
  rule.enabled &&
  (rule.action === "skip" || (rule.action === "to-csv" && rule.options?.removeAfterCsv === true));

export function ExportComposer() {
  const { tab, source, draft, patchDraft, binding, pickedBlock } = useWorkspace();
  const { t } = useI18n();
  const { data: settings } = useSettings();
  const extract = useExtractJob();
  const product = draft.source.product;
  const jiraIssue = product === "jira" && draft.scope !== "fragment";
  const fragment = draft.scope === "fragment";
  const fullConfluence = product === "confluence" && draft.scope !== "fragment";
  const info = usePageInfo(product === "confluence" ? tab.host : undefined, tab.pageId);
  const page =
    !info.isPlaceholderData && info.data?.ok && info.data.meta?.id === tab.pageId
      ? info.data.meta
      : undefined;
  const available = Boolean(
    source && tab.accessState === "available" && source.baseUrl === draft.source.baseUrl,
  );
  const scopes: ExportScope[] =
    product === "confluence"
      ? ["page", "subtree", "space", "fragment"]
      : product === "jira"
        ? ["issue", "search", "fragment"]
        : ["fragment"];
  const items: SegmentControlItem<ExportScope>[] = scopes.map((scope) => ({
    value: scope,
    label: t(SCOPE_KEYS[scope]),
  }));
  const { defaults } = extract;
  const filtersContent =
    defaults.conversion.presetRules.some(removesContent) ||
    settings?.customRules.some(removesContent) === true;
  const editable = fullConfluence && !filtersContent;
  const unavailablePackage: (keyof ExportDefaults["package"])[] = jiraIssue
    ? ["images", "plantUmlAssets", "history"]
    : fragment
      ? ["attachments", "comments", "history"]
      : [];
  const tablesOnly = defaults.presetId === "tables-only";
  const resources = defaults.presetId === "md-attachments";
  const effectiveExtras = (Object.keys(PACKAGE_KEYS) as (keyof typeof PACKAGE_KEYS)[]).filter(
    (key) =>
      !tablesOnly &&
      defaults.package[key] &&
      !unavailablePackage.includes(key) &&
      (key !== "editable" || editable) &&
      (!["images", "attachments", "plantUmlAssets"].includes(key) || resources),
  );
  const packageSummary = tablesOnly
    ? t(jiraIssue ? "composer.jiraTablesSummary" : "composer.tablesSummary")
    : ["Markdown", ...effectiveExtras.map((key) => t(PACKAGE_KEYS[key]))].join(" · ");
  let request: ExtractRequest | null = null;
  if (available && source && scopes.includes(draft.scope)) {
    switch (draft.scope) {
      case "page":
        if (page?.id)
          request = {
            kind: "extract-page",
            host: source.baseUrl,
            pageId: page.id,
            presetId: defaults.presetId,
          };
        break;
      case "subtree":
        if (draft.subtree.rootId)
          request = {
            kind: "extract-subtree",
            host: source.baseUrl,
            rootPageId: draft.subtree.rootId,
            presetId: defaults.presetId,
          };
        break;
      case "space": {
        const { spaceKey, label, prefix } = draft.space;
        if (spaceKey?.trim())
          request = {
            kind: "extract-space",
            host: source.baseUrl,
            spaceKey,
            presetId: defaults.presetId,
            options: {
              ...(label.trim() ? { label: label.trim() } : {}),
              ...(prefix.trim() ? { prefix: prefix.trim() } : {}),
            },
          };
        break;
      }
      case "fragment":
        if (pickedBlock)
          request = {
            kind: "extract-block",
            html: pickedBlock.html,
            pageMeta: pickedBlock.meta,
            presetId: defaults.presetId,
          };
        break;
      case "issue":
        if (tab.issueKey)
          request = { kind: "extract-jira-issue", host: source.baseUrl, issueKey: tab.issueKey };
        break;
      case "search":
        if (draft.jira.jql.trim())
          request = {
            kind: "extract-jira-search",
            host: source.baseUrl,
            jql: draft.jira.jql.trim(),
          };
        break;
    }
  }
  const inWorkspace = binding?.owner.surface === "workspace";
  const needsWorkspace =
    !inWorkspace &&
    (draft.destination !== "download-zip" || ["subtree", "space", "search"].includes(draft.scope));
  const capability = destinationCapability(draft.destination, binding?.owner.surface);
  const unsupported = inWorkspace && !capability.supported;
  const canStart = Boolean(request && !extract.busy && !extract.selecting && !unsupported);
  const packageNote =
    filtersContent && fullConfluence
      ? t("composer.filteredEditable")
      : jiraIssue
        ? t("composer.jiraPackage")
        : fragment
          ? t("composer.fragmentPackage")
          : undefined;

  return (
    <div className="cx-composer" data-export-scope={draft.scope}>
      <div className="cx-composer-steps">
        <ExportStep number={1} title={t("composer.what")}>
          <SegmentControl
            ariaLabel={t("composer.scope")}
            items={items}
            value={draft.scope}
            onValueChange={(scope) => patchDraft({ scope })}
            size="sm"
          />
          <div className="mt-3 min-w-0">
            {!scopes.includes(draft.scope) ? (
              <p role="note" className="text-xs text-muted-foreground">
                {t("composer.scopeUnavailable")}
              </p>
            ) : draft.scope === "page" ? (
              <PagePanel tab={tab} />
            ) : draft.scope === "subtree" ? (
              <SubtreePanel tab={tab} />
            ) : draft.scope === "space" ? (
              <SpacePanel tab={tab} />
            ) : draft.scope === "fragment" ? (
              <PickerPanel tab={tab} />
            ) : (
              <JiraPanel tab={tab} />
            )}
          </div>
        </ExportStep>
        <ExportStep number={2} title={t("composer.package")}>
          <PresetSelector
            value={defaults}
            onChange={extract.setDefaults}
            onSaveDefaults={extract.saveDefaults}
            savingDefaults={extract.savingDefaults}
            defaultsError={extract.defaultsError}
            disabled={extract.draftLocked}
            allowEditable={editable}
            unavailablePackage={unavailablePackage}
            unavailableConversion={jiraIssue || fragment ? ["rewriteInternalLinks"] : []}
            showDepth={draft.scope === "subtree" || draft.scope === "space"}
            packageNote={packageNote}
          />
          <p className="mt-2 text-[11px] text-muted-foreground">{t("composer.editableHelp")}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t("composer.rulesSummary", {
              base: defaults.conversion.presetRules.length,
              custom: settings?.customRules.length ?? 0,
            })}
          </p>
        </ExportStep>
        <ExportStep number={3} title={t("composer.where")}>
          <ExportDestination disabled={extract.draftLocked || extract.selecting} />
        </ExportStep>
      </div>
      <aside className="cx-export-summary" aria-label={t("composer.summary")}>
        <h2 className="text-sm font-semibold">{t("composer.summary")}</h2>
        <dl className="mt-3 space-y-2 text-xs">
          <SummaryRow
            label={t("composer.source")}
            value={
              draft.scope === "subtree"
                ? (draft.subtree.rootId ?? "—")
                : (tab.issueKey ?? page?.title ?? tab.title ?? draft.source.baseUrl)
            }
          />
          <SummaryRow label={t("composer.scope")} value={t(SCOPE_KEYS[draft.scope])} />
          <SummaryRow
            label={t("presets.label")}
            value={getPresetName(t, getExportTemplate(defaults.presetId))}
          />
          <SummaryRow label={t("composer.package")} value={packageSummary} />
          <SummaryRow
            label={t("sidepanel.destination.label")}
            value={t(DESTINATION_LABEL_KEYS[draft.destination])}
          />
        </dl>
        <p className="mt-3 text-[11px] text-muted-foreground">{t("composer.snapshotHelp")}</p>
        {extract.draftLocked && (
          <p role="note" className="mt-2 text-xs text-muted-foreground">
            {t("composer.locked")}
          </p>
        )}
        {needsWorkspace && (
          <p className="mt-2 text-xs text-muted-foreground">{t("composer.workspaceHelp")}</p>
        )}
        {unsupported && capability.reason && (
          <p role="note" className="mt-2 text-xs text-warning">
            {t(DESTINATION_REASON_KEYS[capability.reason])}
          </p>
        )}
        {!request && (
          <p className="mt-2 text-xs text-muted-foreground">
            {t(available ? "composer.selectionRequired" : "sourceBase.sourceUnavailable")}
          </p>
        )}
        <Button
          type="button"
          variant="accent"
          className="mt-3 h-auto min-h-9 w-full whitespace-normal"
          data-export-start
          disabled={!canStart}
          onClick={() => {
            if (request) void extract.run(request);
          }}
        >
          {needsWorkspace ? (
            <PanelsTopLeft className="h-4 w-4 shrink-0" />
          ) : (
            <Download className="h-4 w-4 shrink-0" />
          )}
          {t(
            extract.selecting
              ? "composer.choosingDestination"
              : needsWorkspace
                ? "composer.continueWorkspace"
                : "composer.start",
          )}
        </Button>
      </aside>
    </div>
  );
}

function ExportStep({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="cx-export-step" aria-label={title}>
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <span className="cx-step-number" aria-hidden="true">
          {number}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}
function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words font-medium">{value}</dd>
    </div>
  );
}
