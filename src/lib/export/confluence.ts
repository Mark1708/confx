import { createTranslator } from "@/i18n";
import type { ConfluenceApi, FetchOptions } from "@/lib/confluence-api";
import { createConfluenceApi } from "@/lib/create-api";
import {
  type ExtractPageOptions,
  extractFromHtml,
  folderForPage,
  storageSnapshotForPage,
} from "@/lib/extractor";
import { capturePageInventory, serializeConfluenceExportManifest } from "@/lib/export-manifest";
import { isAbortError } from "@/lib/http-client";
import { slugify } from "@/lib/table-to-csv";
import { flattenTree, walkTree } from "@/lib/tree-walker";
import type {
  ConfluenceExportInventory,
  ConfluenceExportManifestSource,
  ConfluenceExportType,
  ConfluencePageMeta,
  ExportPageOrigin,
  ExtractedPage,
  ExtractSpaceRequest,
} from "@/types";
import { AssetRegistry } from "./asset-registry";
import type {
  EmitEntry,
  ExportContext,
  ExportOutcome,
  ExportPackageInfo,
  ExportSummary,
  PreparedExport,
  ProgressTranslator,
} from "./contracts";
import { writePageEntries } from "./package-writer";
import { archivePathKey, safeZipSegment } from "./paths";
import { effectivePackage } from "./prepare";
import { outcomeCounts, p } from "./progress";

const SUBTREE_PAGE_ATTEMPTS = 2;

/** A source failure is fatal; destinations may identify the page left unexported. */
export class PageSourceError extends Error {
  constructor(
    readonly pageId: string,
    readonly cause: unknown,
  ) {
    super(`Failed to export page ${pageId}`, { cause });
    this.name = "PageSourceError";
  }
}

interface PageTarget {
  id: string;
  title: string;
  folder: string;
  origin: ExportPageOrigin;
}

interface Discovery {
  type: ConfluenceExportType;
  source: ConfluenceExportManifestSource;
  targets: PageTarget[];
  attempts: number;
  rewriteLinks: boolean;
  packageInfo?: ExportPackageInfo;
  readme?: { title: string; rows: Array<{ id: string; depth: number }> };
}

function createPageOptions(prepared: PreparedExport, signal: AbortSignal): ExtractPageOptions {
  const policy = effectivePackage(prepared);
  return {
    rules: prepared.effectiveRules,
    includeEditable: policy.editable,
    includeFrontMatter: prepared.defaults.conversion.includeFrontMatter,
    rewriteLinks: prepared.defaults.conversion.rewriteInternalLinks,
    exportImages: policy.images,
    exportAttachments: policy.attachments,
    exportPlantUmlAssets: policy.plantUmlAssets,
    maxAttachmentSize: prepared.maxAttachmentSize,
    includeComments: policy.comments,
    includeHistory: policy.history,
    signal,
  };
}

/** Produces one page at a time; only committed metadata survives each awaited write. */
export async function produceConfluenceExport(
  prepared: PreparedExport,
  context: ExportContext,
  emit: EmitEntry,
): Promise<ExportSummary> {
  const { signal, onProgress } = context;
  signal.throwIfAborted();
  const t = createTranslator(prepared.locale);
  const api = createConfluenceApi(prepared.source.baseUrl, prepared.network);
  const discovery = await discoverExport(prepared, api, context, t);
  signal.throwIfAborted();
  const assets = new AssetRegistry(prepared.defaults.conversion.deduplicateAssets);
  for (const target of discovery.targets) assets.protectPage(target.folder);
  const committedTargets = new Map<string, string>();
  const inventory: ConfluenceExportInventory[] = [];
  const outcome: ExportOutcome = {
    partial: false,
    successfulPages: 0,
    failedPages: 0,
    successfulResources: 0,
    failedResources: 0,
    entriesWritten: 0,
  };
  let packageInfo = discovery.packageInfo;
  if (packageInfo) context.onPackage(packageInfo);
  const write: EmitEntry = async (entry) => {
    signal.throwIfAborted();
    await emit(entry);
    outcome.entriesWritten! += 1;
    signal.throwIfAborted();
  };
  const options = createPageOptions(prepared, signal);
  options.rewriteLinks = discovery.rewriteLinks && options.rewriteLinks;

  for (const [index, target] of discovery.targets.entries()) {
    p(
      onProgress,
      index,
      discovery.targets.length,
      discovery.targets.length === 1
        ? t(
            prepared.request.kind === "extract-block"
              ? "export.progress.processingBlock"
              : "export.progress.fetchingPage",
          )
        : t("export.progress.extractingPage", { title: target.title }),
      {
        phase: "reading",
        counts: { processed: index, total: discovery.targets.length, ...outcomeCounts(outcome) },
      },
    );
    let written: Awaited<ReturnType<typeof producePage>>;
    try {
      written = await producePage(
        api,
        prepared,
        target,
        discovery.attempts,
        options,
        assets,
        committedTargets,
        write,
        (meta) => {
          if (!packageInfo) {
            const block = prepared.request.kind === "extract-block";
            const rootName = `${safeZipSegment(folderForPage(meta)) || "confluence-page"}${block ? "-block" : ""}`;
            packageInfo = { rootName, fileName: `${rootName}.zip` };
            discovery.source = sourceForPage(prepared.source.baseUrl, meta);
            context.onPackage(packageInfo);
          }
          p(onProgress, index, discovery.targets.length, t("export.progress.buildingArchive"), {
            phase: "writing",
            counts: {
              processed: index,
              total: discovery.targets.length,
              ...outcomeCounts(outcome),
            },
          });
        },
      );
    } catch (error) {
      if (error instanceof PageSourceError) {
        // Observed page-source failures must be visible in terminal counts; the run stays fatal.
        outcome.failedPages += 1;
        p(
          onProgress,
          index,
          discovery.targets.length,
          t("export.progress.extractingPage", { title: target.title }),
          {
            phase: "reading",
            counts: {
              processed: index,
              total: discovery.targets.length,
              ...outcomeCounts(outcome),
            },
          },
        );
      }
      throw error;
    }
    inventory.push(written.inventory);
    outcome.successfulPages += 1;
    outcome.successfulResources! += written.resourcesWritten;
    const page = written.inventory.page;
    const failures = written.inventory.failures;
    outcome.partial ||=
      failures.length > 0 ||
      page.attachment_outcome.skipped_size > 0 ||
      page.plantuml_outcome.skipped_limit > 0 ||
      page.plantuml_outcome.unsupported > 0;
    if (failures.some((failure) => failure.reason === "attachment-list-failed")) {
      outcome.failedResources = null;
    } else if (outcome.failedResources !== null) {
      outcome.failedResources +=
        page.attachment_outcome.failed_downloads +
        page.plantuml_outcome.failed_downloads +
        failures.filter(
          (failure) => failure.scope === "attachment" && failure.reason === "fetch-failed",
        ).length;
    }
    outcome.partial ||= (outcome.failedResources ?? 0) > 0;
    p(onProgress, index + 1, discovery.targets.length, t("export.progress.buildingArchive"), {
      phase: "writing",
      counts: { processed: index + 1, total: discovery.targets.length, ...outcomeCounts(outcome) },
    });
  }

  signal.throwIfAborted();
  if (discovery.readme) {
    await write({ path: "README.md", body: subtreeReadme(discovery.readme, inventory, t) });
  }
  await write({
    path: discovery.type === "space" ? "space-manifest.json" : "manifest.json",
    body: serializeConfluenceExportManifest({
      type: discovery.type,
      preset: prepared.defaults.presetId,
      source: discovery.source,
      pages: inventory,
      ...(discovery.type === "space"
        ? {
            additionalCounts: {
              requested_pages: discovery.targets.length,
              exported_pages: inventory.length,
              skipped_pages: 0,
            },
          }
        : {}),
    }),
  });
  if (prepared.request.kind === "extract-watch-changed") {
    await write({ path: "watch-diff.json", body: JSON.stringify(prepared.request.diff, null, 2) });
  }
  signal.throwIfAborted();
  p(onProgress, inventory.length, discovery.targets.length, t("export.progress.buildingArchive"), {
    phase: "finalizing",
    counts: {
      processed: inventory.length,
      total: discovery.targets.length,
      ...outcomeCounts(outcome),
    },
  });
  if (!packageInfo) throw new Error("Export package metadata is unavailable");
  return { ...packageInfo, outcome };
}

async function producePage(
  api: ConfluenceApi,
  prepared: PreparedExport,
  target: PageTarget,
  attempts: number,
  options: ExtractPageOptions,
  registry: AssetRegistry,
  committedTargets: Map<string, string>,
  emit: EmitEntry,
  onPrepared: (meta: ConfluencePageMeta) => void,
): Promise<{ inventory: ConfluenceExportInventory; resourcesWritten: number }> {
  const signal = options.signal!;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    signal.throwIfAborted();
    const assets = registry.beginPage(target.folder);
    let page: ExtractedPage;
    try {
      const request = prepared.request;
      if (request.kind === "extract-block") {
        page = await extractFromHtml(
          api,
          request.html,
          {
            ...request.pageMeta,
            baseUrl: prepared.source.baseUrl,
            url: prepared.source.pageUrl,
            labels: request.pageMeta.labels ? [...request.pageMeta.labels] : undefined,
            ancestors: request.pageMeta.ancestors?.map((ancestor) => ({ ...ancestor })),
          },
          {
            ...options,
            assets,
            folder: target.folder,
            includeEditable: false,
            rewriteLinks: false,
            exportAttachments: false,
            includeComments: false,
            includeHistory: false,
          },
        );
        page.editable = { status: "unavailable", reason: "partial-export" };
      } else {
        const raw = await api.getPage(
          target.id,
          [
            "body.view",
            "body.storage",
            "ancestors",
            "space",
            "version",
            "metadata.labels",
            "children.attachment",
          ],
          signal,
        );
        signal.throwIfAborted();
        committedTargets.set(target.id, target.folder);
        page = await extractFromHtml(api, raw.body?.view?.value ?? "", api.toPageMeta(raw), {
          ...options,
          assets,
          folder: target.folder,
          pageIdToFolder: committedTargets,
          storageHtml: raw.body?.storage?.value,
          fullPageStorage: storageSnapshotForPage(raw),
        });
      }
      signal.throwIfAborted();
    } catch (error) {
      assets.discard();
      committedTargets.delete(target.id);
      if (signal.aborted || isAbortError(error)) throw error;
      if (attempt === attempts) throw new PageSourceError(target.id, error);
      continue;
    }

    // This boundary is deliberately outside the source retry catch: an emit is irreversible.
    let resourcesWritten: number;
    try {
      onPrepared(page.meta);
      const written = await writePageEntries(
        page,
        emit,
        signal,
        prepared.defaults.presetId === "tables-only",
      );
      resourcesWritten = written.resourcesWritten;
      signal.throwIfAborted();
    } catch (error) {
      assets.discard();
      committedTargets.delete(target.id);
      throw error;
    }
    assets.commit();
    return { inventory: capturePageInventory(page, target.origin), resourcesWritten };
  }
  throw new Error(`No source attempt for page ${target.id}`);
}

async function discoverExport(
  prepared: PreparedExport,
  api: ConfluenceApi,
  context: ExportContext,
  t: ProgressTranslator,
): Promise<Discovery> {
  const request = prepared.request;
  const host = prepared.source.baseUrl;
  const { signal, onProgress } = context;
  switch (request.kind) {
    case "extract-page":
      return {
        type: "single-page",
        source: { host },
        attempts: 1,
        rewriteLinks: false,
        targets: [{ id: request.pageId, title: "", folder: "", origin: "root" }],
      };
    case "extract-block":
      return {
        type: "block",
        source: { host },
        attempts: 1,
        rewriteLinks: false,
        targets: [
          { id: request.pageMeta.id, title: request.pageMeta.title, folder: "", origin: "block" },
        ],
      };
    case "extract-watch-changed": {
      const rootName = `${safeZipSegment(slugify(request.rootTitle)) || "watch-changed"}-changed`;
      return {
        type: "watch-changed",
        source: { host, rootTitle: request.rootTitle },
        attempts: 1,
        rewriteLinks: false,
        packageInfo: { rootName, fileName: `${rootName}.zip` },
        targets: request.pageIds.map((id) => ({
          id,
          title: id,
          folder: `pages/${id}`,
          origin: "watch",
        })),
      };
    }
    case "extract-subtree": {
      p(onProgress, 0, 1, t("export.progress.walkingTree"), {
        phase: "discovering",
        counts: { processed: 0, total: null },
      });
      const tree = await walkTree(api, request.rootPageId, {
        maxDepth: prepared.defaults.maxDepth ?? Number.POSITIVE_INFINITY,
        concurrency: prepared.discoveryConcurrency,
        signal,
        onPage: (node, depth) =>
          p(onProgress, 0, 0, t("export.progress.foundPage", { title: node.title, depth }), {
            phase: "discovering",
          }),
      });
      signal.throwIfAborted();
      const all = flattenTree(tree);
      const folders = new Map<string, string>();
      const parents = new Map<string, string>();
      const used = new Set<string>();
      for (const node of all) {
        for (const child of node.children) parents.set(child.page.id, node.page.id);
      }
      for (const node of all) {
        const slug = safeZipSegment(slugify(node.page.title)) || `page-${node.page.id}`;
        const parent = folders.get(parents.get(node.page.id) ?? "");
        const base = parent ? `${parent}/${slug}` : slug;
        let folder = base;
        let suffix = 1;
        while (used.has(archivePathKey(folder))) folder = `${base}-${++suffix}`;
        used.add(archivePathKey(folder));
        folders.set(node.page.id, folder);
      }
      const rows: Array<{ id: string; depth: number }> = [];
      const stack = [tree];
      while (stack.length > 0) {
        const node = stack.pop()!;
        rows.push({ id: node.page.id, depth: node.depth });
        for (let index = node.children.length - 1; index >= 0; index -= 1)
          stack.push(node.children[index]);
      }
      const rootSlug = safeZipSegment(slugify(tree.page.title));
      const rootName = rootSlug || `subtree-${request.rootPageId}`;
      return {
        type: "subtree",
        source: {
          host,
          rootPageId: request.rootPageId,
          rootTitle: tree.page.title,
          space: tree.page.space?.key ?? null,
        },
        attempts: SUBTREE_PAGE_ATTEMPTS,
        rewriteLinks: true,
        packageInfo: { rootName, fileName: `${rootSlug || "subtree"}.zip` },
        targets: all.map((node) => ({
          id: node.page.id,
          title: node.page.title,
          folder: folders.get(node.page.id)!,
          origin: "subtree",
        })),
        readme: { title: tree.page.title, rows },
      };
    }
    case "extract-space": {
      p(onProgress, 0, 1, t("export.progress.fetchingSpaceInfo"), {
        phase: "discovering",
        counts: { processed: 0, total: null },
      });
      const space = await api.getSpace(request.spaceKey, signal);
      const pages = await api.getSpacePages(request.spaceKey, request.options, signal);
      signal.throwIfAborted();
      const used = new Set<string>();
      const targets = pages.map((page): PageTarget => {
        const slug = safeZipSegment(folderForPage(page));
        let folder = slug;
        let suffix = 1;
        while (used.has(archivePathKey(folder))) folder = `${slug}-${++suffix}`;
        used.add(archivePathKey(folder));
        return { id: page.id, title: page.title, folder, origin: "space" };
      });
      const rootName = safeZipSegment(slugify(space.name)) || `space-${space.key}`;
      return {
        type: "space",
        source: {
          host,
          space: space.key,
          spaceName: space.name,
          requestedPages: pages.length,
          skippedPages: 0,
        },
        attempts: SUBTREE_PAGE_ATTEMPTS,
        rewriteLinks: true,
        packageInfo: { rootName, fileName: `${rootName}.zip` },
        targets,
      };
    }
    default:
      throw new Error(`Unsupported Confluence export request: ${request.kind}`);
  }
}

function sourceForPage(host: string, meta: ConfluencePageMeta): ConfluenceExportManifestSource {
  return {
    host,
    pageId: meta.id,
    title: meta.title,
    version: meta.version ?? null,
    space: meta.spaceKey || null,
    url: meta.url,
    labels: [...(meta.labels ?? [])],
    ancestors: meta.ancestors?.map((ancestor) => ({ ...ancestor })) ?? [],
  };
}

function subtreeReadme(
  readme: NonNullable<Discovery["readme"]>,
  inventory: readonly ConfluenceExportInventory[],
  t: ProgressTranslator,
): string {
  const pages = new Map(inventory.map(({ page }) => [page.id, page]));
  const lines = [`# ${readme.title}`, "", t("export.readme.generatedBy"), ""];
  for (const row of readme.rows) {
    const page = pages.get(row.id);
    if (page) lines.push(`${"  ".repeat(row.depth)}- [${page.title}](${page.archive_path})`);
  }
  return lines.join("\n");
}

export async function fetchSpacePageEstimate(
  resolvedBaseUrl: string,
  spaceKey: string,
  options: ExtractSpaceRequest["options"] | undefined,
  network: FetchOptions,
  signal?: AbortSignal,
): Promise<number> {
  const api = createConfluenceApi(resolvedBaseUrl, network);
  const pages = await api.getSpacePages(spaceKey, options, signal);
  return pages.length;
}
