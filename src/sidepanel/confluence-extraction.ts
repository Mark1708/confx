import type { Zip } from "fflate";
import { createTranslator } from "@/i18n";
import { bundleExtractedPages } from "@/lib/bundler";
import type { ConfluenceApi } from "@/lib/confluence-api";
import { createConfluenceApi } from "@/lib/create-api";
import {
  type ExtractPageOptions,
  extractFromHtml,
  extractOnePage,
  folderForPage,
} from "@/lib/extractor";
import { ImageDedup } from "@/lib/image-fetcher";
import { getPreset } from "@/lib/rule-engine";
import { loadSettings } from "@/lib/settings";
import { slugify } from "@/lib/table-to-csv";
import { flattenTree, walkTree } from "@/lib/tree-walker";
import type {
  AppSettings,
  ConfluencePageMeta,
  ExtractBlockRequest,
  ExtractedPage,
  ExtractPageRequest,
  ExtractSpaceRequest,
  ExtractSubtreeRequest,
  ExtractWatchChangedRequest,
} from "@/types";
import { type ExtractJobResult, isAbortError, SUBTREE_PAGE_ATTEMPTS } from "./extraction-shared";
import {
  buildArchiveProgress,
  buildSkippedSuffix,
  p,
  type ProgressHandler,
  type ProgressTranslator,
} from "./progress";
import { addFile, addStringFile, blobToUint8Array, chunksToZipBlob, createZip } from "./zip-utils";

export async function extractPage(
  req: ExtractPageRequest,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<ExtractJobResult> {
  const settings = await loadSettings();
  const t = createTranslator(settings.locale);
  const preset = getPreset(req.presetId);
  const exportPresetAssets = shouldExportPresetAssets(preset.id);
  const api = await createConfluenceApi(req.host);

  p(onProgress, 0, 1, t("export.progress.fetchingPage"));
  const page = await extractOnePage(api, req.pageId, {
    rules: [...preset.rules, ...settings.customRules],
    folder: "",
    includeFrontMatter: settings.includeFrontMatter,
    rewriteLinks: false,
    dedup: settings.deduplicateImages ? new ImageDedup() : undefined,
    exportImages: exportPresetAssets,
    exportAttachments: shouldExportPresetAttachments(preset.id, settings),
    maxAttachmentSize: settings.maxAttachmentSize,
    includeComments: settings.includeComments,
    includeHistory: settings.includeHistory,
    signal,
  });
  p(onProgress, 1, 1, t("export.progress.buildingArchive"));

  const zipBlob = await bundleExtractedPages([page], {
    rootName: folderForPage(page.meta) || "confluence-page",
    manifestJson: JSON.stringify(
      {
        type: "single-page",
        exported_at: new Date().toISOString(),
        preset: preset.id,
        source: {
          host: req.host,
          pageId: page.meta.id,
          title: page.meta.title,
          version: page.meta.version ?? null,
          space: page.meta.spaceKey || null,
          url: page.meta.url,
          labels: page.meta.labels ?? [],
          ancestors: page.meta.ancestors ?? [],
        },
        counts: {
          tables_csv: page.tables.length,
          images: page.images.length,
          attachments: page.attachments.length,
        },
      },
      null,
      2,
    ),
  });
  const fileName = `${folderForPage(page.meta) || "confluence-page"}.zip`;
  return { fileName, zipBlob };
}

export async function extractWatchChanged(
  req: ExtractWatchChangedRequest,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<ExtractJobResult> {
  const settings = await loadSettings();
  const t = createTranslator(settings.locale);
  const preset = getPreset(req.presetId);
  const exportPresetAssets = shouldExportPresetAssets(preset.id);
  const api = await createConfluenceApi(req.host);
  const dedup = settings.deduplicateImages ? new ImageDedup() : undefined;
  const pages: ExtractedPage[] = [];

  for (let index = 0; index < req.pageIds.length; index += 1) {
    const pageId = req.pageIds[index];
    p(onProgress, index, req.pageIds.length, t("export.progress.fetchingPage"));
    pages.push(
      await extractOnePage(api, pageId, {
        rules: [...preset.rules, ...settings.customRules],
        folder: "",
        includeFrontMatter: settings.includeFrontMatter,
        rewriteLinks: false,
        dedup,
        exportImages: exportPresetAssets,
        exportAttachments: shouldExportPresetAttachments(preset.id, settings),
        maxAttachmentSize: settings.maxAttachmentSize,
        includeComments: settings.includeComments,
        includeHistory: settings.includeHistory,
        signal,
      }),
    );
  }

  p(onProgress, req.pageIds.length, req.pageIds.length, t("export.progress.buildingArchive"));
  const rootName = `${slugify(req.rootTitle) || "watch-changed"}-changed`;
  const zipBlob = await bundleExtractedPages(pages, {
    rootName,
    manifestJson: JSON.stringify(
      {
        type: "watch-changed",
        exported_at: new Date().toISOString(),
        preset: preset.id,
        source: { host: req.host, rootTitle: req.rootTitle },
        pageIds: req.pageIds,
        counts: { pages: pages.length },
      },
      null,
      2,
    ),
    extraTextFiles: {
      "watch-diff.json": JSON.stringify(req.diff, null, 2),
    },
  });

  return { fileName: `${rootName}.zip`, zipBlob };
}

export async function extractBlock(
  req: ExtractBlockRequest,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<ExtractJobResult> {
  const settings = await loadSettings();
  const t = createTranslator(settings.locale);
  const preset = getPreset(req.presetId);
  const exportPresetAssets = shouldExportPresetAssets(preset.id);
  const api = await createConfluenceApi(req.pageMeta.baseUrl);

  p(onProgress, 0, 1, t("export.progress.processingBlock"));
  const page = await extractFromHtml(api, req.html, req.pageMeta, {
    rules: [...preset.rules, ...settings.customRules],
    folder: "",
    includeFrontMatter: settings.includeFrontMatter,
    rewriteLinks: false,
    dedup: settings.deduplicateImages ? new ImageDedup() : undefined,
    exportImages: exportPresetAssets,
    exportAttachments: shouldExportPresetAttachments(preset.id, settings),
    maxAttachmentSize: settings.maxAttachmentSize,
    includeComments: settings.includeComments,
    includeHistory: settings.includeHistory,
    signal,
  });
  p(onProgress, 1, 1, t("export.progress.buildingArchive"));

  const zipBlob = await bundleExtractedPages([page], {
    rootName: `${folderForPage(page.meta)}-block`,
    manifestJson: JSON.stringify(
      {
        type: "block",
        exported_at: new Date().toISOString(),
        preset: preset.id,
        source: {
          host: req.pageMeta.baseUrl,
          pageId: page.meta.id,
          title: page.meta.title,
          version: page.meta.version ?? null,
          url: page.meta.url,
        },
        counts: {
          tables_csv: page.tables.length,
          images: page.images.length,
          attachments: page.attachments.length,
        },
      },
      null,
      2,
    ),
  });
  const fileName = `${folderForPage(page.meta)}-block.zip`;
  return { fileName, zipBlob };
}

export async function extractSubtree(
  req: ExtractSubtreeRequest,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<ExtractJobResult> {
  const settings = await loadSettings();
  const t = createTranslator(settings.locale);
  const preset = getPreset(req.presetId);
  const exportPresetAssets = shouldExportPresetAssets(preset.id);
  const api = await createConfluenceApi(req.host);

  p(onProgress, 0, 1, t("export.progress.walkingTree"));
  const tree = await walkTree(api, req.rootPageId, {
    maxDepth: req.maxDepth ?? Number.POSITIVE_INFINITY,
    concurrency: settings.concurrency,
    signal,
    onPage: (node, depth) =>
      p(onProgress, 0, 0, t("export.progress.foundPage", { title: node.title, depth })),
  });

  const all = flattenTree(tree);
  const pageIdToFolder = buildFolderMap(all);
  const dedup = settings.deduplicateImages ? new ImageDedup() : undefined;
  const pages: ExtractedPage[] = [];
  let skippedPages = 0;

  for (let i = 0; i < all.length; i++) {
    const node = all[i];
    p(
      onProgress,
      i,
      all.length,
      t("export.progress.extractingPage", {
        title: node.page.title,
        skipped: buildSkippedSuffix(t, skippedPages),
      }),
    );

    try {
      const page = await extractSubtreePageWithRetry({
        api,
        pageId: node.page.id,
        rules: [...preset.rules, ...settings.customRules],
        pageIdToFolder,
        dedup,
        includeFrontMatter: settings.includeFrontMatter,
        rewriteLinks: settings.rewriteInternalLinks,
        exportImages: exportPresetAssets,
        exportAttachments: shouldExportPresetAttachments(preset.id, settings),
        maxAttachmentSize: settings.maxAttachmentSize,
        includeComments: settings.includeComments,
        includeHistory: settings.includeHistory,
        signal,
      });
      pages.push(page);
    } catch (error: unknown) {
      if (isAbortError(error, signal)) throw error;

      skippedPages += 1;
      console.warn(`Failed to extract page ${node.page.id}; skipping`, error);
    }
  }

  p(onProgress, all.length, all.length, buildArchiveProgress(t, skippedPages));
  const readme = buildSubtreeReadme(tree, pageIdToFolder, t);
  const pagesById = new Map(pages.map((pg) => [pg.meta.id, pg]));
  const manifestJson = JSON.stringify(
    {
      type: "subtree",
      exported_at: new Date().toISOString(),
      preset: preset.id,
      source: {
        host: req.host,
        rootPageId: req.rootPageId,
        rootTitle: tree.page.title,
        space: tree.page.space?.key ?? null,
      },
      counts: {
        pages: pages.length,
        tables_csv: pages.reduce((n, p) => n + p.tables.length, 0),
        images: pages.reduce((n, p) => n + p.images.length, 0),
        attachments: pages.reduce((n, p) => n + p.attachments.length, 0),
      },
      pages: Array.from(pageIdToFolder.entries()).map(([id, folder]) => {
        const pg = pagesById.get(id);
        return {
          id,
          folder,
          title: pg?.meta.title ?? null,
          version: pg?.meta.version ?? null,
          url: pg?.meta.url ?? null,
        };
      }),
    },
    null,
    2,
  );
  const zipBlob = await bundleExtractedPages(pages, {
    rootName: slugify(tree.page.title) || `subtree-${req.rootPageId}`,
    readme,
    manifestJson,
  });
  const fileName = `${slugify(tree.page.title) || "subtree"}.zip`;
  return { fileName, zipBlob };
}

export async function extractSpace(
  req: ExtractSpaceRequest,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<ExtractJobResult> {
  const settings = await loadSettings();
  const t = createTranslator(settings.locale);
  const preset = getPreset(req.presetId);
  const exportPresetAssets = shouldExportPresetAssets(preset.id);
  const api = await createConfluenceApi(req.host);

  p(onProgress, 0, 1, t("export.progress.fetchingSpaceInfo"));
  const spaceInfo = await api.getSpace(req.spaceKey, signal);
  const pageMetas = await api.getSpacePages(req.spaceKey, req.options, signal);
  const pageIdToFolder = buildSpaceFolderMap(pageMetas);
  const dedup = settings.deduplicateImages ? new ImageDedup() : undefined;
  const pages: ExtractedPage[] = [];
  let skippedPages = 0;

  for (let i = 0; i < pageMetas.length; i += 1) {
    const meta = pageMetas[i];
    p(
      onProgress,
      i,
      pageMetas.length,
      t("export.progress.extractingPage", {
        title: meta.title,
        skipped: buildSkippedSuffix(t, skippedPages),
      }),
    );

    try {
      const page = await extractSubtreePageWithRetry({
        api,
        pageId: meta.id,
        rules: [...preset.rules, ...settings.customRules],
        pageIdToFolder,
        dedup,
        includeFrontMatter: settings.includeFrontMatter,
        rewriteLinks: settings.rewriteInternalLinks,
        exportImages: exportPresetAssets,
        exportAttachments: shouldExportPresetAttachments(preset.id, settings),
        maxAttachmentSize: settings.maxAttachmentSize,
        includeComments: settings.includeComments,
        includeHistory: settings.includeHistory,
        signal,
      });
      pages.push(page);
    } catch (error: unknown) {
      if (isAbortError(error, signal)) throw error;

      skippedPages += 1;
      console.warn(`Failed to extract space page ${meta.id}; skipping`, error);
    }
  }

  p(onProgress, pageMetas.length, pageMetas.length, buildArchiveProgress(t, skippedPages));

  const rootName = slugify(spaceInfo.name) || `space-${spaceInfo.key}`;
  const zipBlob = await bundleSpacePages(pages, {
    rootName,
    manifestJson: buildSpaceManifest({
      host: req.host,
      presetId: preset.id,
      spaceKey: spaceInfo.key,
      spaceName: spaceInfo.name,
      requestedPages: pageMetas.length,
      skippedPages,
      pages,
    }),
  });

  return { fileName: `${rootName}.zip`, zipBlob };
}

export async function fetchSpacePageEstimate(
  host: string,
  spaceKey: string,
  options?: ExtractSpaceRequest["options"],
  signal?: AbortSignal,
): Promise<number> {
  const api = await createConfluenceApi(host);
  const pages = await api.getSpacePages(spaceKey, options, signal);
  return pages.length;
}

export interface SpaceManifestArgs {
  host: string;
  presetId: string;
  spaceKey: string;
  spaceName: string;
  requestedPages: number;
  skippedPages: number;
  pages: ExtractedPage[];
}

export interface SpaceBundleOptions {
  rootName: string;
  manifestJson: string;
}

export function buildSpaceManifest(args: SpaceManifestArgs): string {
  return JSON.stringify(
    {
      type: "space",
      exported_at: new Date().toISOString(),
      preset: args.presetId,
      source: {
        host: args.host,
        space: args.spaceKey,
        spaceName: args.spaceName,
      },
      counts: {
        requested_pages: args.requestedPages,
        exported_pages: args.pages.length,
        skipped_pages: args.skippedPages,
        tables_csv: args.pages.reduce((n, page) => n + page.tables.length, 0),
        images: args.pages.reduce((n, page) => n + page.images.length, 0),
        attachments: args.pages.reduce((n, page) => n + page.attachments.length, 0),
      },
      pages: args.pages.map((page) => ({
        id: page.meta.id,
        title: page.meta.title,
        path: page.folder,
        version: page.meta.version ?? null,
        url: page.meta.url,
      })),
    },
    null,
    2,
  );
}

export async function bundleSpacePages(
  pages: ExtractedPage[],
  opts: SpaceBundleOptions,
): Promise<Blob> {
  const { zip, chunks } = createZip();
  const seenBinaryHashes = new Set<string>();

  addStringFile(zip, `${opts.rootName}/space-manifest.json`, opts.manifestJson);
  for (const page of pages) await addExtractedPageToZip(zip, opts.rootName, page, seenBinaryHashes);

  zip.end();
  return chunksToZipBlob(chunks);
}

export async function addExtractedPageToZip(
  zip: Zip,
  rootName: string,
  page: ExtractedPage,
  seenBinaryHashes: Set<string>,
): Promise<void> {
  const pagePrefix = page.folder ? `${page.folder}/` : "";
  addStringFile(zip, `${rootName}/${pagePrefix}index.md`, page.markdown);
  addPageTables(zip, rootName, pagePrefix, page);
  await addPageBinaries(zip, rootName, pagePrefix, page, seenBinaryHashes);
  addPageMetadataFiles(zip, rootName, pagePrefix, page);
}

export function addPageTables(
  zip: Zip,
  rootName: string,
  pagePrefix: string,
  page: ExtractedPage,
): void {
  for (const table of page.tables) {
    addStringFile(zip, `${rootName}/${pagePrefix}tables/${table.name}`, table.csv);
  }
}

export async function addPageBinaries(
  zip: Zip,
  rootName: string,
  pagePrefix: string,
  page: ExtractedPage,
  seenBinaryHashes: Set<string>,
): Promise<void> {
  for (const image of page.images) {
    if (seenBinaryHashes.has(image.hash)) continue;
    seenBinaryHashes.add(image.hash);
    addFile(zip, `${rootName}/${pagePrefix}${image.zipPath}`, await blobToUint8Array(image.blob));
  }

  for (const attachment of page.attachments) {
    if (attachment.skipped || seenBinaryHashes.has(attachment.hash)) continue;
    seenBinaryHashes.add(attachment.hash);
    addFile(
      zip,
      `${rootName}/${pagePrefix}${attachment.zipPath}`,
      await blobToUint8Array(attachment.blob),
    );
  }
}

export function addPageMetadataFiles(
  zip: Zip,
  rootName: string,
  pagePrefix: string,
  page: ExtractedPage,
): void {
  if (page.comments.length > 0) {
    addStringFile(
      zip,
      `${rootName}/${pagePrefix}comments.json`,
      JSON.stringify(page.comments, null, 2),
    );
  }
  if (page.inlineComments.length > 0) {
    addStringFile(
      zip,
      `${rootName}/${pagePrefix}inline-comments.json`,
      JSON.stringify(page.inlineComments, null, 2),
    );
  }
  if (page.history.length > 0) {
    addStringFile(
      zip,
      `${rootName}/${pagePrefix}history.json`,
      JSON.stringify(page.history, null, 2),
    );
  }
}

export interface SubtreePageArgs extends ExtractPageOptions {
  api: ConfluenceApi;
  pageId: string;
  pageIdToFolder: Map<string, string>;
}

export async function extractSubtreePageWithRetry(args: SubtreePageArgs): Promise<ExtractedPage> {
  for (let attempt = 1; attempt <= SUBTREE_PAGE_ATTEMPTS; attempt++) {
    try {
      return await extractSubtreePage(args);
    } catch (error: unknown) {
      if (isAbortError(error, args.signal) || attempt === SUBTREE_PAGE_ATTEMPTS) throw error;
      console.warn(`Retrying page ${args.pageId} extraction after failure`, error);
    }
  }

  throw new Error(`Failed to extract page ${args.pageId}`);
}

export async function extractSubtreePage(args: SubtreePageArgs): Promise<ExtractedPage> {
  const full = await args.api.getPage(
    args.pageId,
    ["body.view", "ancestors", "space", "version", "metadata.labels", "children.attachment"],
    args.signal,
  );
  const meta = args.api.toPageMeta(full);
  const html = full.body?.view?.value ?? "";
  const folder = args.pageIdToFolder.get(args.pageId) ?? slugify(meta.title);

  return extractFromHtml(args.api, html, meta, {
    rules: args.rules,
    folder,
    pageIdToFolder: args.pageIdToFolder,
    dedup: args.dedup,
    includeFrontMatter: args.includeFrontMatter,
    rewriteLinks: args.rewriteLinks,
    exportImages: args.exportImages,
    exportAttachments: args.exportAttachments,
    maxAttachmentSize: args.maxAttachmentSize,
    includeComments: args.includeComments,
    includeHistory: args.includeHistory,
    signal: args.signal,
  });
}

interface Flat {
  page: { id: string; title: string };
  depth: number;
  children: Array<{ page: { id: string } }>;
}

export function buildFolderMap(all: Flat[]): Map<string, string> {
  const map = new Map<string, string>();
  const used = new Set<string>();
  for (const n of all) {
    const slug = slugify(n.page.title) || `page-${n.page.id}`;
    const parentFolder = findParentFolder(n.page.id, all, map);
    let candidate = parentFolder ? `${parentFolder}/${slug}` : slug;
    let suffix = 1;
    while (used.has(candidate)) {
      const base = parentFolder ? `${parentFolder}/${slug}` : slug;
      candidate = `${base}-${++suffix}`;
    }
    used.add(candidate);
    map.set(n.page.id, candidate);
  }
  return map;
}

export function buildSpaceFolderMap(pages: ConfluencePageMeta[]): Map<string, string> {
  const map = new Map<string, string>();
  const used = new Set<string>();

  for (const page of pages) {
    const slug = folderForPage(page);
    let candidate = slug;
    let suffix = 1;
    while (used.has(candidate)) candidate = `${slug}-${++suffix}`;
    used.add(candidate);
    map.set(page.id, candidate);
  }

  return map;
}

export function findParentFolder(
  pageId: string,
  all: Flat[],
  map: Map<string, string>,
): string | undefined {
  for (const candidate of all) {
    if (candidate.children.some((c) => c.page.id === pageId)) {
      return map.get(candidate.page.id);
    }
  }
  return undefined;
}

export function buildSubtreeReadme(
  tree: Awaited<ReturnType<typeof walkTree>>,
  folders: Map<string, string>,
  t: ProgressTranslator,
): string {
  const lines = [`# ${tree.page.title}`, "", t("export.readme.generatedBy"), ""];
  const render = (node: typeof tree, indent: number): void => {
    const folder = folders.get(node.page.id);
    const link = folder ? `[${node.page.title}](${folder}/index.md)` : node.page.title;
    lines.push(`${"  ".repeat(indent)}- ${link}`);
    for (const c of node.children) render(c, indent + 1);
  };
  render(tree, 0);
  return lines.join("\n");
}

export function shouldExportPresetAssets(presetId: string): boolean {
  return presetId === "md-attachments";
}

export function shouldExportPresetAttachments(presetId: string, settings: AppSettings): boolean {
  return shouldExportPresetAssets(presetId) && settings.exportAttachments;
}
