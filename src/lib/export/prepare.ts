import { toFetchOptions } from "@/lib/create-api";
import { canonicalBaseUrl, type SourceContext } from "@/lib/source-context";
import type { AppSettings, DeepReadonly, ExportDefaults } from "@/types";
import type { DestinationKind, ExtractRequest, PreparedExport } from "./contracts";
import { safeZipSegment } from "./paths";

function freezeDeep<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value as DeepReadonly<T>;
}

function initialRootName(request: ExtractRequest): string {
  switch (request.kind) {
    case "extract-page":
      return `page-${request.pageId}`;
    case "extract-subtree":
      return `subtree-${request.rootPageId}`;
    case "extract-space":
      return `space-${request.spaceKey}`;
    case "extract-watch-changed":
      return request.rootTitle || "changed-pages";
    case "extract-block":
      return request.pageMeta.title || "selected-block";
    case "extract-jira-issue":
      return request.issueKey;
    case "extract-jira-search":
      return "jira-search";
  }
}

export function prepareExport<R extends ExtractRequest>(
  source: SourceContext,
  request: R,
  settings: AppSettings,
  defaults: ExportDefaults = settings.exportDefaults,
  destination: DestinationKind = "download-zip",
): PreparedExport<R> {
  const captured = structuredClone({ source, request, defaults });
  captured.source.baseUrl = canonicalBaseUrl(captured.source.baseUrl);
  if (captured.request.kind === "extract-block") {
    captured.request.pageMeta.baseUrl = captured.source.baseUrl;
  } else {
    captured.request.host = captured.source.baseUrl;
  }
  if ("presetId" in captured.request) captured.request.presetId = captured.defaults.presetId;
  if (captured.request.kind === "extract-subtree" || captured.request.kind === "extract-space") {
    if (captured.request.maxDepth !== undefined)
      captured.defaults.maxDepth = captured.request.maxDepth;
    else if (captured.defaults.maxDepth !== null)
      captured.request.maxDepth = captured.defaults.maxDepth;
  }
  const effectiveRules = [
    ...captured.defaults.conversion.presetRules,
    ...structuredClone(settings.customRules),
  ];
  return freezeDeep({
    id: crypto.randomUUID(),
    source: captured.source,
    request: captured.request,
    defaults: captured.defaults,
    effectiveRules,
    network: toFetchOptions(settings),
    discoveryConcurrency: settings.concurrency,
    maxAttachmentSize: settings.maxAttachmentSize,
    rootName: safeZipSegment(initialRootName(captured.request)) || "confx-export",
    destination,
    locale: settings.locale,
  });
}

export function effectivePackage(prepared: PreparedExport): ExportDefaults["package"] {
  const options = prepared.defaults.package;
  const tablesOnly = prepared.defaults.presetId === "tables-only";
  const resources = prepared.defaults.presetId === "md-attachments";
  const pageCompanions = prepared.request.kind !== "extract-block";
  const fullConfluence = prepared.source.product === "confluence" && pageCompanions;
  return {
    editable: !tablesOnly && fullConfluence && options.editable,
    images: resources && options.images,
    attachments: pageCompanions && resources && options.attachments,
    plantUmlAssets: resources && options.plantUmlAssets,
    comments: pageCompanions && !tablesOnly && options.comments,
    history: pageCompanions && !tablesOnly && options.history,
  };
}
