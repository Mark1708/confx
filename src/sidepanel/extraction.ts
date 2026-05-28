import { strToU8, Zip, ZipDeflate } from "fflate";
import { bundleExtractedPages } from "@/lib/bundler";
import { ConfluenceApi, extractBaseUrl } from "@/lib/confluence-api";
import { type ExtractPageOptions, extractFromHtml, extractOnePage, folderForPage } from "@/lib/extractor";
import { ImageDedup } from "@/lib/image-fetcher";
import { JiraApi } from "@/lib/jira-api";
import { BrowserApi } from "@/lib/browser/browser-api";
import { extractJiraIssue as extractIssueLib, jiraIssuesToCsv } from "@/lib/jira-extractor";
import { getPreset } from "@/lib/rule-engine";
import { loadSettings } from "@/lib/settings";
import { slugify } from "@/lib/table-to-csv";
import { flattenTree, walkTree } from "@/lib/tree-walker";
import type {
  AppSettings,
  ConfluencePageMeta,
  ExtractBlockRequest,
  ExtractedJiraIssue,
  ExtractedPage,
  ExtractJiraIssueRequest,
  ExtractJiraSearchRequest,
  ExtractPageRequest,
  ExtractSpaceRequest,
  ExtractSubtreeRequest,
  JiraAttachment,
} from "@/types";

export interface ProgressEvent {
  current: number;
  total: number;
  message: string;
}

export type ProgressHandler = (p: ProgressEvent) => void;

function p(handler: ProgressHandler | undefined, current: number, total: number, message: string): void {
  handler?.({ current, total, message });
}

function createZip(): { zip: Zip; chunks: Uint8Array[] } {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((err, data) => {
    if (err) throw err;
    chunks.push(data);
  });

  return { zip, chunks };
}

function addFile(zip: Zip, path: string, data: Uint8Array): void {
  const file = new ZipDeflate(path, { level: DEFLATE_LEVEL });
  zip.add(file);
  file.push(data, true);
}

function addStringFile(zip: Zip, path: string, content: string): void {
  addFile(zip, path, strToU8(content));
}

async function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

function chunksToZipBlob(chunks: Uint8Array[]): Blob {
  const archive = concatChunks(chunks);
  return new Blob([toArrayBuffer(archive)], { type: ZIP_MIME_TYPE });
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const archive = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.length;
  }

  return archive;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function safeZipSegment(value: string): string {
  const sanitized = Array.from(value)
    .map((char) => (isUnsafeZipChar(char) ? "-" : char))
    .join("")
    .replace(/^\.+$/, "")
    .trim();
  return sanitized;
}

function isUnsafeZipChar(char: string): boolean {
  return char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char);
}

function getRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  const child = isRecord(value) ? value[key] : undefined;
  return isRecord(child) ? child : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function jiraText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value, null, 2);
}

export interface ExtractJobResult {
  fileName: string;
  zipBlob: Blob;
}

const SUBTREE_PAGE_ATTEMPTS = 2;
const ZIP_MIME_TYPE = "application/zip";
const DEFLATE_LEVEL = 6;

function createConfluenceApi(settings: AppSettings, host: string): ConfluenceApi {
  return new ConfluenceApi(extractBaseUrl(settings.confluenceBaseUrl || host));
}

/** Trigger a Chrome download for a Blob. Uses a blob: URL (no base64 size bloat). */
export async function downloadBlob(blob: Blob, fileName: string): Promise<number> {
  const url = URL.createObjectURL(blob);
  try {
    const id = await BrowserApi.download({ url, filename: fileName, saveAs: true });
    return id;
  } finally {
    // Revoke after Chrome has grabbed the blob (small delay is safe)
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

export async function extractPage(
  req: ExtractPageRequest,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<ExtractJobResult> {
  const settings = await loadSettings();
  const preset = getPreset(req.presetId);
  const api = createConfluenceApi(settings, req.host);

  p(onProgress, 0, 1, "Получение страницы…");
  const page = await extractOnePage(api, req.pageId, {
    rules: [...preset.rules, ...settings.customRules],
    folder: "",
    includeFrontMatter: settings.includeFrontMatter,
    rewriteLinks: false,
    dedup: settings.deduplicateImages ? new ImageDedup() : undefined,
    exportAttachments: settings.exportAttachments,
    maxAttachmentSize: settings.maxAttachmentSize,
    signal,
  });
  p(onProgress, 1, 1, "Сборка архива…");

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

export async function extractBlock(
  req: ExtractBlockRequest,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<ExtractJobResult> {
  const settings = await loadSettings();
  const preset = getPreset(req.presetId);
  const api = createConfluenceApi(settings, req.pageMeta.baseUrl);

  p(onProgress, 0, 1, "Обрабатываю блок…");
  const page = await extractFromHtml(api, req.html, req.pageMeta, {
    rules: [...preset.rules, ...settings.customRules],
    folder: "",
    includeFrontMatter: settings.includeFrontMatter,
    rewriteLinks: false,
    dedup: settings.deduplicateImages ? new ImageDedup() : undefined,
    exportAttachments: settings.exportAttachments,
    maxAttachmentSize: settings.maxAttachmentSize,
    signal,
  });
  p(onProgress, 1, 1, "Сборка архива…");

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
  const preset = getPreset(req.presetId);
  const api = createConfluenceApi(settings, req.host);

  p(onProgress, 0, 1, "Обход дерева…");
  const tree = await walkTree(api, req.rootPageId, {
    maxDepth: req.maxDepth ?? Number.POSITIVE_INFINITY,
    concurrency: settings.concurrency,
    signal,
    onPage: (node, depth) =>
      p(onProgress, 0, 0, `Найдено: ${node.title} (уровень ${depth})`),
  });

  const all = flattenTree(tree);
  const pageIdToFolder = buildFolderMap(all);
  const dedup = settings.deduplicateImages ? new ImageDedup() : undefined;
  const pages: ExtractedPage[] = [];
  let skippedPages = 0;

  for (let i = 0; i < all.length; i++) {
    const node = all[i];
    const skippedLabel = skippedPages > 0 ? `, пропущено: ${skippedPages}` : "";
    p(onProgress, i, all.length, `Извлекаю: ${node.page.title}${skippedLabel}`);

    try {
      const page = await extractSubtreePageWithRetry({
        api,
        pageId: node.page.id,
        rules: [...preset.rules, ...settings.customRules],
        pageIdToFolder,
        dedup,
        includeFrontMatter: settings.includeFrontMatter,
        rewriteLinks: settings.rewriteInternalLinks,
        exportAttachments: settings.exportAttachments,
        maxAttachmentSize: settings.maxAttachmentSize,
        signal,
      });
      pages.push(page);
    } catch (error: unknown) {
      if (isAbortError(error, signal)) throw error;

      skippedPages += 1;
      console.warn(`Failed to extract page ${node.page.id}; skipping`, error);
    }
  }

  const buildMessage = skippedPages > 0 ? `Сборка архива… Пропущено: ${skippedPages}` : "Сборка архива…";
  p(onProgress, all.length, all.length, buildMessage);
  const readme = buildSubtreeReadme(tree, pageIdToFolder);
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
  const preset = getPreset(req.presetId);
  const api = createConfluenceApi(settings, req.host);

  p(onProgress, 0, 1, "Получение информации о пространстве…");
  const spaceInfo = await api.getSpace(req.spaceKey, signal);
  const pageMetas = await api.getSpacePages(req.spaceKey, req.options, signal);
  const pageIdToFolder = buildSpaceFolderMap(pageMetas);
  const dedup = settings.deduplicateImages ? new ImageDedup() : undefined;
  const pages: ExtractedPage[] = [];
  let skippedPages = 0;

  for (let i = 0; i < pageMetas.length; i += 1) {
    const meta = pageMetas[i];
    const skippedLabel = skippedPages > 0 ? `, пропущено: ${skippedPages}` : "";
    p(onProgress, i, pageMetas.length, `Извлекаю: ${meta.title}${skippedLabel}`);

    try {
      const page = await extractSubtreePageWithRetry({
        api,
        pageId: meta.id,
        rules: [...preset.rules, ...settings.customRules],
        pageIdToFolder,
        dedup,
        includeFrontMatter: settings.includeFrontMatter,
        rewriteLinks: settings.rewriteInternalLinks,
        exportAttachments: settings.exportAttachments,
        maxAttachmentSize: settings.maxAttachmentSize,
        signal,
      });
      pages.push(page);
    } catch (error: unknown) {
      if (isAbortError(error, signal)) throw error;

      skippedPages += 1;
      console.warn(`Failed to extract space page ${meta.id}; skipping`, error);
    }
  }

  const buildMessage = skippedPages > 0 ? `Сборка архива… Пропущено: ${skippedPages}` : "Сборка архива…";
  p(onProgress, pageMetas.length, pageMetas.length, buildMessage);

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
  const settings = await loadSettings();
  const api = createConfluenceApi(settings, host);
  const pages = await api.getSpacePages(spaceKey, options, signal);
  return pages.length;
}

interface SpaceManifestArgs {
  host: string;
  presetId: string;
  spaceKey: string;
  spaceName: string;
  requestedPages: number;
  skippedPages: number;
  pages: ExtractedPage[];
}

interface SpaceBundleOptions {
  rootName: string;
  manifestJson: string;
}

function buildSpaceManifest(args: SpaceManifestArgs): string {
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

async function bundleSpacePages(pages: ExtractedPage[], opts: SpaceBundleOptions): Promise<Blob> {
  const { zip, chunks } = createZip();
  const seenBinaryHashes = new Set<string>();

  addStringFile(zip, `${opts.rootName}/space-manifest.json`, opts.manifestJson);
  for (const page of pages) await addExtractedPageToZip(zip, opts.rootName, page, seenBinaryHashes);

  zip.end();
  return chunksToZipBlob(chunks);
}

async function addExtractedPageToZip(
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

function addPageTables(zip: Zip, rootName: string, pagePrefix: string, page: ExtractedPage): void {
  for (const table of page.tables) {
    addStringFile(zip, `${rootName}/${pagePrefix}tables/${table.name}`, table.csv);
  }
}

async function addPageBinaries(
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
    addFile(zip, `${rootName}/${pagePrefix}${attachment.zipPath}`, await blobToUint8Array(attachment.blob));
  }
}

function addPageMetadataFiles(zip: Zip, rootName: string, pagePrefix: string, page: ExtractedPage): void {
  if (page.comments.length > 0) {
    addStringFile(zip, `${rootName}/${pagePrefix}comments.json`, JSON.stringify(page.comments, null, 2));
  }
  if (page.history.length > 0) {
    addStringFile(zip, `${rootName}/${pagePrefix}history.json`, JSON.stringify(page.history, null, 2));
  }
}

export async function extractJiraIssue(
  req: ExtractJiraIssueRequest,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<ExtractJobResult> {
  const api = new JiraApi(req.host);

  p(onProgress, 0, 1, "Получение тикета…");
  const issue = await loadJiraIssue(api, req.issueKey, signal);

  p(onProgress, 1, 1, "Сборка архива…");
  const zipBlob = await bundleJiraIssue(api, issue, signal);
  return { fileName: `${safeZipSegment(issue.meta.key) || "jira-issue"}.zip`, zipBlob };
}

export async function extractJiraSearch(
  req: ExtractJiraSearchRequest,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<ExtractJobResult> {
  const api = new JiraApi(req.host);

  p(onProgress, 0, 1, "Поиск тикетов…");
  const metas = await api.searchIssues(req.jql, 50, signal);
  const issues: ExtractedJiraIssue[] = [];

  for (let i = 0; i < metas.length; i += 1) {
    p(onProgress, i, metas.length, `Извлекаю тикет: ${metas[i].key}`);
    issues.push(await loadJiraIssue(api, metas[i].key, signal));
  }

  p(onProgress, metas.length, metas.length, "Сборка архива…");
  const zipBlob = await bundleJiraSearch(api, issues, signal);
  return { fileName: "jira-search.zip", zipBlob };
}

async function loadJiraIssue(
  api: JiraApi,
  issueKey: string,
  signal?: AbortSignal,
): Promise<ExtractedJiraIssue> {
  const [meta, description, comments, attachments] = await Promise.all([
    api.getIssue(issueKey, signal),
    fetchJiraDescription(api, issueKey, signal),
    api.getComments(issueKey, signal),
    api.getAttachments(issueKey, signal),
  ]);

  return extractIssueLib(meta, description, comments, attachments);
}

async function fetchJiraDescription(api: JiraApi, issueKey: string, signal?: AbortSignal): Promise<string> {
  const raw = await api.fetchJson<unknown>(
    `/rest/api/2/issue/${encodeURIComponent(issueKey)}?fields=description`,
    signal,
  );
  const fields = getRecord(raw, "fields");
  return jiraText(fields?.description);
}

async function bundleJiraIssue(api: JiraApi, issue: ExtractedJiraIssue, signal?: AbortSignal): Promise<Blob> {
  const { zip, chunks } = createZip();
  const root = safeZipSegment(issue.meta.key) || "jira-issue";

  addStringFile(zip, `${root}/index.md`, issue.markdown);
  addStringFile(zip, `${root}/issue.json`, JSON.stringify(issue.json, null, 2));

  for (const attachment of issue.attachments) {
    await addJiraAttachment(zip, api, `${root}/attachments`, attachment, signal);
  }

  zip.end();
  return chunksToZipBlob(chunks);
}

async function bundleJiraSearch(api: JiraApi, issues: ExtractedJiraIssue[], signal?: AbortSignal): Promise<Blob> {
  const { zip, chunks } = createZip();
  const root = "issues";
  const markdown = issues.map((issue) => issue.markdown).join("\n\n---\n\n");

  addStringFile(zip, `${root}/index.md`, markdown);
  addStringFile(zip, `${root}/issues.json`, JSON.stringify(issues.map((issue) => issue.json), null, 2));
  addStringFile(zip, `${root}/issues.csv`, jiraIssuesToCsv(issues.map((issue) => issue.meta)));

  for (const issue of issues) {
    const folder = `${root}/attachments/${safeZipSegment(issue.meta.key) || "issue"}`;
    for (const attachment of issue.attachments) await addJiraAttachment(zip, api, folder, attachment, signal);
  }

  zip.end();
  return chunksToZipBlob(chunks);
}

async function addJiraAttachment(
  zip: Zip,
  api: JiraApi,
  folder: string,
  attachment: JiraAttachment,
  signal?: AbortSignal,
): Promise<void> {
  if (!attachment.contentUrl) return;

  const blob = await api.fetchBlob(attachment.contentUrl, signal);
  const path = `${folder}/${safeZipSegment(attachment.fileName) || `attachment-${attachment.id}`}`;
  addFile(zip, path, await blobToUint8Array(blob));
}

interface SubtreePageArgs extends ExtractPageOptions {
  api: ConfluenceApi;
  pageId: string;
  pageIdToFolder: Map<string, string>;
}

async function extractSubtreePageWithRetry(args: SubtreePageArgs): Promise<ExtractedPage> {
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

async function extractSubtreePage(args: SubtreePageArgs): Promise<ExtractedPage> {
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
    exportAttachments: args.exportAttachments,
    maxAttachmentSize: args.maxAttachmentSize,
    signal: args.signal,
  });
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

interface Flat {
  page: { id: string; title: string };
  depth: number;
  children: Array<{ page: { id: string } }>;
}

function buildFolderMap(all: Flat[]): Map<string, string> {
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

function buildSpaceFolderMap(pages: ConfluencePageMeta[]): Map<string, string> {
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

function findParentFolder(
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

function buildSubtreeReadme(
  tree: Awaited<ReturnType<typeof walkTree>>,
  folders: Map<string, string>,
): string {
  const lines = [`# ${tree.page.title}`, "", "Экспортировано расширением Confluence Extractor.", ""];
  const render = (node: typeof tree, indent: number): void => {
    const folder = folders.get(node.page.id);
    const link = folder ? `[${node.page.title}](${folder}/index.md)` : node.page.title;
    lines.push(`${"  ".repeat(indent)}- ${link}`);
    for (const c of node.children) render(c, indent + 1);
  };
  render(tree, 0);
  return lines.join("\n");
}

export interface PageInfo {
  meta: ConfluencePageMeta;
  childCount: number;
  children: Array<{ id: string; title: string }>;
}

export async function fetchPageInfo(
  host: string,
  pageId: string,
  signal?: AbortSignal,
): Promise<PageInfo> {
  const settings = await loadSettings();
  const api = createConfluenceApi(settings, host);
  const raw = await api.getPage(
    pageId,
    ["space", "version", "ancestors", "metadata.labels", "children.attachment"],
    signal,
  );
  const meta = api.toPageMeta(raw);
  const children = await api.getChildren(pageId, 100, signal);
  return {
    meta,
    childCount: children.length,
    children: children.map((c) => ({ id: c.id, title: c.title })),
  };
}

export async function fetchChildren(
  host: string,
  pageId: string,
  signal?: AbortSignal,
): Promise<Array<{ id: string; title: string; hasChildren: boolean }>> {
  const settings = await loadSettings();
  const api = createConfluenceApi(settings, host);
  const children = await api.getChildren(pageId, 100, signal);
  // Check whether each child has grandchildren (cheap HEAD: size>0 via one more request is expensive —
  // instead we fetch children with expand=children.page.
  const withFlag = await Promise.all(
    children.map(async (c) => {
      try {
        const sub = await api.fetchJson<{ size: number }>(
          `/rest/api/content/${c.id}/child/page?limit=1`,
          signal,
        );
        return { id: c.id, title: c.title, hasChildren: (sub.size ?? 0) > 0 };
      } catch {
        return { id: c.id, title: c.title, hasChildren: false };
      }
    }),
  );
  return withFlag;
}
