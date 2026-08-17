import { AsyncUnzipInflate, Unzip } from "fflate";
import { marked } from "marked";
import { ApiError } from "@/types";
import type { ConfluenceApi } from "./confluence-api";
import { fetchInlineComments } from "./comment-fetcher";

export type ImportAction = "create" | "update" | "blocked";

export interface ImportTarget {
  host: string;
  spaceKey: string;
  parentId: string;
}

export interface ImportBuildOptions {
  maxAttachmentSize: number;
}

export interface ImportAsset {
  file: File;
  attachmentName: string;
  role: "image" | "attachment";
}

export interface ImportPagePlan {
  path: string;
  title: string;
  parentPath?: string;
  source?: { pageId: string; version: number };
  action: ImportAction;
  reviewedVersion?: number;
  assets: readonly ImportAsset[];
  storage: string;
  previewHtml: string;
  warnings: readonly string[];
  errors: readonly string[];
}

export interface ImportPlan {
  target: ImportTarget;
  pages: readonly ImportPagePlan[];
}

export interface PublishRowResult {
  path: string;
  title: string;
  action: ImportAction;
  status: "created" | "updated" | "blocked" | "failed" | "skipped";
  pageId?: string;
  url?: string;
  error?: string;
}

export interface PublishResult {
  rows: PublishRowResult[];
}

interface VirtualFile {
  path: string;
  file: File;
  bytes?: Uint8Array;
  text?: string;
}

interface ParsedPage {
  path: string;
  dir: string;
  file: VirtualFile;
  body: string;
  frontMatter: Record<string, string>;
  title: string;
  warnings: string[];
  errors: string[];
}

const MAX_IMPORT_FILES = 2_000;
const MAX_IMPORT_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;
const GENERATED_FILE_NAMES = new Set([
  "README.md",
  "comments.json",
  "inline-comments.json",
  "history.json",
  "manifest.json",
  "space-manifest.json",
]);

export async function buildImportPlan(
  files: readonly File[],
  target: ImportTarget,
  options: ImportBuildOptions,
  api: ConfluenceApi,
  signal?: AbortSignal,
): Promise<ImportPlan> {
  const virtualFiles = await normalizeFiles(files, options);
  const manifest = parseManifest(virtualFiles);
  const hasManifest = manifest.pageFolders.size > 0;
  const generatedMetadataPresent = virtualFiles.some((file) =>
    ["comments.json", "inline-comments.json"].includes(file.path.split("/").at(-1) ?? ""),
  );
  const pageFiles = virtualFiles.filter((file) => isPageMarkdown(file.path, hasManifest, manifest));
  const binaryByPath = new Map(
    virtualFiles.filter((file) => !file.path.endsWith(".md")).map((file) => [file.path, file]),
  );
  const parsedPages = pageFiles.map((file) => parseMarkdownPage(file, generatedMetadataPresent));
  const pagePathSet = new Set(parsedPages.map((page) => page.path));
  const plannedSiblingCounts = countPlannedCreateSiblings(parsedPages, pagePathSet);
  const parsedPageByPath = new Map(parsedPages.map((page) => [page.path, page]));
  const titleByPath = new Map(parsedPages.map((page) => [page.path, page.title]));
  const existingChildTitlesByParent = new Map<string, Promise<Set<string>>>();
  const childTitleByParent = await fetchExistingChildTitles(target.parentId, api, signal);

  const plans = await Promise.all(
    parsedPages.map(async (page) => {
      const warnings = [...page.warnings];
      const errors = [...page.errors];
      const parentPath = findParentPath(page, pagePathSet);
      const manifestHost = manifest.hostByFolder.get(page.dir) ?? manifest.sourceHost;
      const source = buildSource(page.frontMatter, target, errors, manifestHost);
      let action: ImportAction = source ? "update" : "create";
      let reviewedVersion: number | undefined;

      if (!source && plannedSiblingCounts.get(siblingKey(parentPath, page.title))! > 1) {
        errors.push(`duplicate imported sibling title: ${page.title}`);
      }
      if (!source && !parentPath && childTitleByParent.has(page.title)) {
        errors.push(`duplicate title under target parent: ${page.title}`);
      }
      if (!source && parentPath) {
        const parentPage = parsedPageByPath.get(parentPath);
        const parentManifestHost = parentPage
          ? (manifest.hostByFolder.get(parentPage.dir) ?? manifest.sourceHost)
          : undefined;
        const parentSource = parentPage
          ? buildSource(parentPage.frontMatter, target, [], parentManifestHost)
          : undefined;
        if (parentSource) {
          const existingTitles =
            existingChildTitlesByParent.get(parentSource.pageId) ??
            fetchExistingChildTitles(parentSource.pageId, api, signal);
          existingChildTitlesByParent.set(parentSource.pageId, existingTitles);
          if ((await existingTitles).has(page.title)) {
            errors.push(`duplicate title under imported parent: ${page.title}`);
          }
        }
      }

      if (source) {
        try {
          const live = await api.getPage(
            source.pageId,
            ["body.storage", "version", "space", "ancestors"],
            signal,
          );
          const liveVersion = live.version?.number;
          if (page.frontMatter.space && live.space?.key !== page.frontMatter.space) {
            errors.push(`space mismatch for ${source.pageId}`);
          }
          if (liveVersion !== source.version) {
            errors.push(
              `version mismatch for ${source.pageId}: live ${liveVersion ?? "unknown"}, source ${source.version}`,
            );
          } else {
            reviewedVersion = liveVersion;
          }
          const manifestTitle = manifest.titleByFolder.get(page.dir);
          const intentionalRename = manifestTitle !== undefined && page.title !== manifestTitle;
          if (live.title && live.title !== page.title && !intentionalRename) {
            if (manifestTitle !== undefined) {
              errors.push(
                `page was renamed in Confluence to "${live.title}"; re-export before publishing`,
              );
            } else {
              errors.push(
                `title mismatch for ${source.pageId}: live "${live.title}", imported "${page.title}" without export baseline`,
              );
            }
          }
          if (intentionalRename) {
            const liveParentId = live.ancestors?.at(-1)?.id;
            if (liveParentId) {
              const siblingTitles =
                existingChildTitlesByParent.get(liveParentId) ??
                fetchExistingChildTitles(liveParentId, api, signal);
              existingChildTitlesByParent.set(liveParentId, siblingTitles);
              if ((await siblingTitles).has(page.title)) {
                errors.push(`duplicate title under live parent: ${page.title}`);
              }
            }
          }

          try {
            const inlineComments = await fetchInlineComments(source.pageId, api, signal);
            const openInlineCount = inlineComments.filter(
              (comment) => comment.status === "open",
            ).length;
            if (openInlineCount > 0) {
              errors.push(
                `page has ${openInlineCount} open inline comment(s); resolve them in Confluence before publishing`,
              );
            }
          } catch (inlineError) {
            errors.push(
              `inline comment check failed for ${source.pageId}: ${errorMessage(inlineError)}`,
            );
          }
        } catch (error) {
          errors.push(
            `source page ${source.pageId} is inaccessible: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      const compileResult = compileMarkdownToStorage(
        page,
        binaryByPath,
        pagePathSet,
        hasManifest,
        options,
      );
      warnings.push(...compileResult.warnings);
      errors.push(...compileResult.errors);
      if (errors.length > 0) action = "blocked";

      let previewHtml = "";
      if (action !== "blocked") {
        try {
          previewHtml = await api.renderStorage(
            resolvePageLinkPlaceholders(compileResult.storage, new Map(), titleByPath),
            signal,
          );
        } catch (error) {
          errors.push(`preview failed: ${error instanceof Error ? error.message : String(error)}`);
          action = "blocked";
        }
      }

      return {
        path: page.path,
        title: page.title,
        parentPath,
        source,
        action,
        reviewedVersion,
        assets: compileResult.assets,
        storage: compileResult.storage,
        previewHtml,
        warnings,
        errors,
      } satisfies ImportPagePlan;
    }),
  );

  return { target, pages: parentOrdered(plans) };
}

export async function publishImportPlan(
  plan: ImportPlan,
  selectedPaths: ReadonlySet<string>,
  api: ConfluenceApi,
  signal?: AbortSignal,
): Promise<PublishResult> {
  const selected = parentOrdered(plan.pages).filter(
    (page) => selectedPaths.has(page.path) && page.action !== "blocked",
  );
  const idByPath = new Map<string, string>();
  const createdVersionByPath = new Map<string, number>();
  const failedPaths = new Set<string>();
  const rows: PublishRowResult[] = [];
  const titleByPath = new Map(plan.pages.map((page) => [page.path, page.title]));

  for (const page of selected) {
    if (page.source) idByPath.set(page.path, page.source.pageId);
  }

  for (const page of selected.filter((page) => page.action === "create")) {
    const blockedAncestor = nearestSelectedAncestor(page, failedPaths);
    if (blockedAncestor) {
      failedPaths.add(page.path);
      rows.push({
        path: page.path,
        title: page.title,
        action: page.action,
        status: "skipped",
        error: `ancestor failed: ${blockedAncestor}`,
      });
      continue;
    }
    try {
      const parentId = (page.parentPath && idByPath.get(page.parentPath)) || plan.target.parentId;
      const created = await api.createPage(
        { title: page.title, spaceKey: plan.target.spaceKey, parentId, storage: "<p></p>" },
        signal,
      );
      if (typeof created.version?.number !== "number") {
        throw new Error("create response did not include numeric version");
      }
      idByPath.set(page.path, created.id);
      createdVersionByPath.set(page.path, created.version.number);
    } catch (error) {
      failedPaths.add(page.path);
      rows.push({
        path: page.path,
        title: page.title,
        action: page.action,
        status: "failed",
        error: errorMessage(error),
      });
    }
  }

  for (const page of selected) {
    if (rows.some((row) => row.path === page.path)) continue;
    const blockedAncestor = nearestSelectedAncestor(page, failedPaths);
    if (blockedAncestor) {
      failedPaths.add(page.path);
      rows.push({
        path: page.path,
        title: page.title,
        action: page.action,
        status: "skipped",
        error: `ancestor failed: ${blockedAncestor}`,
      });
      continue;
    }

    try {
      const pageId = idByPath.get(page.path);
      if (!pageId) throw new Error("missing target page id");

      let version: number;
      if (page.action === "update") {
        const live = await api.getPage(pageId, ["version"], signal);
        if (live.version?.number !== page.reviewedVersion) {
          failedPaths.add(page.path);
          rows.push({
            path: page.path,
            title: page.title,
            action: page.action,
            status: "blocked",
            pageId,
            error: "version conflict before publish",
          });
          continue;
        }
        version = (page.reviewedVersion ?? 0) + 1;
      } else {
        version = (createdVersionByPath.get(page.path) ?? 0) + 1;
      }

      const existingAttachmentSizes =
        page.action === "update" && page.assets.length > 0
          ? await fetchExistingAttachmentSizes(pageId, api, signal)
          : new Map<string, number>();
      for (const asset of page.assets) {
        if (existingAttachmentSizes.get(asset.attachmentName) === asset.file.size) continue;
        await api.uploadAttachment(pageId, asset.file, signal);
      }

      const storage = resolvePageLinkPlaceholders(page.storage, idByPath, titleByPath);
      const updated = await api.updatePage(
        {
          id: pageId,
          title: page.title,
          spaceKey: plan.target.spaceKey,
          storage,
          version,
        },
        signal,
      );
      rows.push({
        path: page.path,
        title: page.title,
        action: page.action,
        status: page.action === "create" ? "created" : "updated",
        pageId,
        url: updated._links?.webui ? api.url(updated._links.webui) : undefined,
      });
    } catch (error) {
      failedPaths.add(page.path);
      rows.push({
        path: page.path,
        title: page.title,
        action: page.action,
        status: error instanceof ApiError && error.status === 409 ? "blocked" : "failed",
        pageId: idByPath.get(page.path),
        error:
          error instanceof ApiError && error.status === 409
            ? "version conflict during publish"
            : errorMessage(error),
      });
    }
  }

  return { rows };
}

async function normalizeFiles(
  files: readonly File[],
  options: ImportBuildOptions,
): Promise<VirtualFile[]> {
  if (files.length === 0) return [];
  if (files.length === 1 && files[0].name.toLowerCase().endsWith(".zip")) {
    return normalizeZip(files[0], options);
  }

  const paths = files.map((file) => normalizeRelativePath(readRelativePath(file)));
  return Promise.all(
    files.map(async (file, index) => virtualizeFile(file, paths[index], options)),
  ).then(stripCommonRoot);
}

async function normalizeZip(file: File, options: ImportBuildOptions): Promise<VirtualFile[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pending: Promise<VirtualFile>[] = [];
  const seenPaths = new Set<string>();
  let fileCount = 0;
  let totalBytes = 0;

  const unzip = new Unzip((entry) => {
    const normalized = normalizeRelativePath(entry.name);
    if (seenPaths.has(normalized)) throw new Error(`duplicate normalized path: ${normalized}`);
    if (typeof entry.originalSize !== "number")
      throw new Error(`missing original size: ${normalized}`);
    if (![0, 8].includes(entry.compression))
      throw new Error(`unsupported compression method: ${normalized}`);
    fileCount += 1;
    totalBytes += entry.originalSize;
    if (fileCount > MAX_IMPORT_FILES) throw new Error("ZIP contains too many files");
    if (totalBytes > MAX_IMPORT_UNCOMPRESSED_BYTES)
      throw new Error("ZIP uncompressed size limit exceeded");
    if (normalized.endsWith(".md") && entry.originalSize > MAX_MARKDOWN_BYTES)
      throw new Error(`Markdown file too large: ${normalized}`);
    if (!normalized.endsWith(".md") && entry.originalSize > options.maxAttachmentSize)
      throw new Error(`Attachment too large: ${normalized}`);
    seenPaths.add(normalized);

    pending.push(
      new Promise<VirtualFile>((resolve, reject) => {
        const chunks: Uint8Array[] = [];
        entry.ondata = (err, chunk, final) => {
          if (err) {
            reject(err);
            return;
          }
          chunks.push(chunk);
          if (!final) return;
          const size = chunks.reduce((sum, part) => sum + part.byteLength, 0);
          const data = new Uint8Array(size);
          let offset = 0;
          for (const part of chunks) {
            data.set(part, offset);
            offset += part.byteLength;
          }
          const entryFile = new File([data], normalized.split("/").at(-1) ?? normalized);
          resolve(virtualizeFile(entryFile, normalized, options, data));
        };
        entry.start();
      }),
    );
  });
  unzip.register(AsyncUnzipInflate);
  unzip.push(bytes, true);

  return stripCommonRoot(await Promise.all(pending));
}

async function virtualizeFile(
  file: File,
  path: string,
  options: ImportBuildOptions,
  knownBytes?: Uint8Array,
): Promise<VirtualFile> {
  if (path.endsWith(".md") && file.size > MAX_MARKDOWN_BYTES)
    throw new Error(`Markdown file too large: ${path}`);
  if (!path.endsWith(".md") && file.size > options.maxAttachmentSize)
    throw new Error(`Attachment too large: ${path}`);
  const bytes = knownBytes ?? new Uint8Array(await file.arrayBuffer());
  return path.endsWith(".md") || path.endsWith(".json")
    ? { path, file, bytes, text: new TextDecoder().decode(bytes) }
    : { path, file, bytes };
}

function parseManifest(files: readonly VirtualFile[]): {
  pageFolders: Set<string>;
  hostByFolder: Map<string, string>;
  titleByFolder: Map<string, string>;
  sourceHost?: string;
} {
  const manifestFile = files.find((file) =>
    ["manifest.json", "space-manifest.json"].includes(file.path.split("/").at(-1) ?? ""),
  );
  const pageFolders = new Set<string>();
  const hostByFolder = new Map<string, string>();
  const titleByFolder = new Map<string, string>();
  if (!manifestFile?.text) return { pageFolders, hostByFolder, titleByFolder };
  try {
    const raw = JSON.parse(manifestFile.text) as {
      source?: { host?: string; url?: string };
      pages?: Array<{ folder?: string; path?: string; url?: string; title?: string }>;
    };
    const sourceHost = raw.source?.host ?? raw.source?.url;
    for (const page of raw.pages ?? []) {
      const folder = page.folder ?? page.path;
      if (!folder) continue;
      const normalized = normalizeRelativePath(folder);
      pageFolders.add(normalized);
      const pageHost = page.url ?? sourceHost;
      if (pageHost) hostByFolder.set(normalized, pageHost);
      if (page.title) titleByFolder.set(normalized, page.title);
    }
    return { pageFolders, hostByFolder, titleByFolder, sourceHost };
  } catch {
    return { pageFolders, hostByFolder, titleByFolder };
  }
}

function isPageMarkdown(
  path: string,
  hasManifest: boolean,
  manifest: { pageFolders: Set<string> },
): boolean {
  if (!path.endsWith(".md")) return false;
  const name = path.split("/").at(-1) ?? "";
  if (GENERATED_FILE_NAMES.has(name)) return false;
  if (!hasManifest) return true;
  return name === "index.md" && manifest.pageFolders.has(dirname(path));
}

function parseMarkdownPage(file: VirtualFile, generatedMetadataPresent: boolean): ParsedPage {
  const warnings: string[] = [];
  const errors: string[] = [];
  let body = file.text ?? "";
  const frontMatter: Record<string, string> = {};

  if (body.startsWith("---\n")) {
    const end = body.indexOf("\n---", 4);
    if (end === -1) {
      errors.push("malformed front matter");
    } else {
      const rawFrontMatter = body.slice(4, end);
      for (const line of rawFrontMatter.split(/\r?\n/)) {
        const match = /^(title|page_id|space|source_url|version):\s*(.*)$/.exec(line);
        if (!match) continue;
        frontMatter[match[1]] = unquoteScalar(match[2].trim());
      }
      body = body.slice(end + 5).replace(/^\r?\n/, "");
    }
  }

  body = stripMarkedCommentsBlock(body);
  if (
    generatedMetadataPresent &&
    !file.text?.includes("confx:comments:start") &&
    /(^|\n)## Comments(\n|$)/.test(body)
  ) {
    warnings.push("Legacy comments metadata detected without ConfX delimiters; body was retained");
  }

  const h1 = /^#\s+(.+?)\s*$/m.exec(body);
  const title = frontMatter.title || h1?.[1]?.trim() || stem(file.path);
  if (h1?.[1]?.trim() === title) {
    body = body.replace(/^#\s+.+?\s*(\r?\n)+/, "");
  }

  return {
    path: file.path,
    dir: dirname(file.path),
    file,
    body,
    frontMatter,
    title,
    warnings,
    errors,
  };
}

function buildSource(
  frontMatter: Record<string, string>,
  target: ImportTarget,
  errors: string[],
  manifestHost?: string,
): { pageId: string; version: number } | undefined {
  if (!frontMatter.page_id) return undefined;
  const version = Number(frontMatter.version);
  if (!Number.isInteger(version)) {
    errors.push("source page_id requires numeric version");
    return undefined;
  }
  const sourceHost = frontMatter.source_url ?? manifestHost;
  if (!sourceHost) {
    errors.push("source host is required for updates");
    return undefined;
  }
  if (normalizeHost(sourceHost) !== normalizeHost(target.host)) {
    errors.push("source host mismatch");
    return undefined;
  }
  return { pageId: frontMatter.page_id, version };
}

function compileMarkdownToStorage(
  page: ParsedPage,
  binaryByPath: ReadonlyMap<string, VirtualFile>,
  pagePathSet: ReadonlySet<string>,
  hasManifest: boolean,
  options: ImportBuildOptions,
): { storage: string; assets: ImportAsset[]; warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  const assets = collectAssets(page, binaryByPath, hasManifest, options, errors);
  const assetNames = new Set(assets.map((asset) => asset.attachmentName));
  const protectedMarkdown = page.body
    .replace(/^\[TOC\]\s*$/gm, "<confx-toc></confx-toc>")
    .replace(/\[macro:children\]\s*<!--.*?-->\s*\{\}/gs, "<confx-children></confx-children>");

  if (/\[macro:(?!children\])[^\]]+\]/.test(protectedMarkdown))
    errors.push("unsupported macro marker");
  if (
    /<(?!\/?(?:br|details|summary|confx-toc|confx-children)\b)[a-z][^>]*>/i.test(protectedMarkdown)
  ) {
    errors.push("unsupported raw HTML");
  }

  const html = String(marked.parse(protectedMarkdown, { gfm: true, breaks: false }));
  const doc = new DOMParser().parseFromString(html, "text/html");
  const storage = Array.from(doc.body.childNodes)
    .map((node) => renderNode(node, page, binaryByPath, pagePathSet, assetNames, errors))
    .join("");

  return { storage, assets, warnings, errors };
}

function collectAssets(
  page: ParsedPage,
  binaryByPath: ReadonlyMap<string, VirtualFile>,
  hasManifest: boolean,
  options: ImportBuildOptions,
  errors: string[],
): ImportAsset[] {
  const referenced = new Set<string>();
  page.body.replace(/!?\[[^\]]*\]\(([^)]+)\)/g, (_match, href: string) => {
    if (!isExternalUrl(href) && !href.startsWith("#") && !href.endsWith(".md")) {
      referenced.add(resolveVirtualPath(page.dir, href));
    }
    return "";
  });

  const candidates = new Map<string, VirtualFile>();
  for (const path of referenced) {
    const file = binaryByPath.get(path);
    if (!file) {
      errors.push(`Missing asset: ${path}`);
    } else {
      candidates.set(path, file);
    }
  }

  if (hasManifest) {
    const prefixes = [`${page.dir}/images/`, `${page.dir}/attachments/`];
    for (const [path, file] of binaryByPath.entries()) {
      if (prefixes.some((prefix) => path.startsWith(prefix))) candidates.set(path, file);
    }
  }

  const byName = new Map<string, Uint8Array>();
  const assets: ImportAsset[] = [];
  for (const [path, file] of candidates.entries()) {
    if ((file.bytes?.byteLength ?? file.file.size) > options.maxAttachmentSize) {
      errors.push(`Attachment too large: ${path}`);
      continue;
    }
    const attachmentName = path.split("/").at(-1) ?? path;
    const existing = byName.get(attachmentName);
    if (existing && !bytesEqual(existing, file.bytes ?? new Uint8Array())) {
      errors.push(`Conflicting attachment filename: ${attachmentName}`);
      continue;
    }
    if (existing) continue;
    byName.set(attachmentName, file.bytes ?? new Uint8Array());
    assets.push({
      file: file.file,
      attachmentName,
      role: isImagePath(path, file.file.type) ? "image" : "attachment",
    });
  }
  return assets;
}

function renderNode(
  node: ChildNode,
  page: ParsedPage,
  binaryByPath: ReadonlyMap<string, VirtualFile>,
  pagePathSet: ReadonlySet<string>,
  assetNames: ReadonlySet<string>,
  errors: string[],
): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeXml(node.textContent ?? "");
  if (!(node instanceof HTMLElement)) return "";
  const children = Array.from(node.childNodes)
    .map((child) => renderNode(child, page, binaryByPath, pagePathSet, assetNames, errors))
    .join("");

  switch (node.tagName.toLowerCase()) {
    case "confx-toc":
      return '<ac:structured-macro ac:name="toc" />';
    case "confx-children":
      return '<ac:structured-macro ac:name="children" />';
    case "p":
      if (node.textContent?.trim() === "{}") return "";
      return `<p>${children}</p>`;
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return `<${node.tagName.toLowerCase()}>${children}</${node.tagName.toLowerCase()}>`;
    case "strong":
    case "em":
    case "del":
    case "blockquote":
    case "ul":
    case "ol":
    case "li":
    case "table":
    case "thead":
    case "tbody":
    case "tr":
    case "th":
    case "td":
      if (node.tagName.toLowerCase() === "ul" && node.querySelector('input[type="checkbox"]')) {
        return `<ac:task-list>${Array.from(node.querySelectorAll("li"))
          .map(
            (li) =>
              `<ac:task><ac:task-status>${li.querySelector("input")?.hasAttribute("checked") ? "complete" : "incomplete"}</ac:task-status><ac:task-body>${escapeXml(li.textContent?.trim() ?? "")}</ac:task-body></ac:task>`,
          )
          .join("")}</ac:task-list>`;
      }
      return `<${node.tagName.toLowerCase()}>${children}</${node.tagName.toLowerCase()}>`;
    case "br":
      return "<br />";
    case "pre": {
      const code = node.querySelector("code");
      const language = code?.className.match(/language-([\w-]+)/)?.[1];
      const parameter = language
        ? `<ac:parameter ac:name="language">${escapeXml(language)}</ac:parameter>`
        : "";
      return `<ac:structured-macro ac:name="code">${parameter}<ac:plain-text-body><![CDATA[${escapeCdata(code?.textContent ?? node.textContent ?? "")}]]></ac:plain-text-body></ac:structured-macro>`;
    }
    case "code":
      return `<code>${children}</code>`;
    case "a":
      return renderLink(
        node as HTMLAnchorElement,
        page,
        binaryByPath,
        pagePathSet,
        assetNames,
        errors,
        children,
      );
    case "img":
      return renderImage(node as HTMLImageElement, page, binaryByPath, assetNames, errors);
    case "details": {
      const summary = node.querySelector("summary")?.textContent?.trim() || "Details";
      return `<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">${escapeXml(summary)}</ac:parameter><ac:rich-text-body>${children}</ac:rich-text-body></ac:structured-macro>`;
    }
    case "summary":
      return "";
    case "input":
      return "";
    default:
      errors.push(`unsupported HTML element: ${node.tagName.toLowerCase()}`);
      return children;
  }
}

function renderLink(
  node: HTMLAnchorElement,
  page: ParsedPage,
  binaryByPath: ReadonlyMap<string, VirtualFile>,
  pagePathSet: ReadonlySet<string>,
  assetNames: ReadonlySet<string>,
  errors: string[],
  children: string,
): string {
  const href = node.getAttribute("href") ?? "";
  if (/^(javascript|data):/i.test(href)) {
    errors.push(`unsafe URL: ${href}`);
    return children;
  }
  if (isExternalUrl(href) || href.startsWith("#"))
    return `<a href="${escapeAttr(href)}">${children}</a>`;
  const resolved = resolveVirtualPath(page.dir, href);
  if (resolved.endsWith(".md")) {
    if (href.includes("#")) errors.push(`unsupported Markdown anchor link: ${href}`);
    if (!pagePathSet.has(resolved)) errors.push(`unsupported relative reference: ${href}`);
    return `<ac:link><ri:page ri:content-id="CONFX_PAGE_LINK:${escapeAttr(resolved)}" /></ac:link>`;
  }
  const asset = binaryByPath.get(resolved);
  const attachmentName = resolved.split("/").at(-1) ?? resolved;
  if (!asset || !assetNames.has(attachmentName)) errors.push(`Missing asset: ${resolved}`);
  return `<ac:link><ri:attachment ri:filename="${escapeAttr(attachmentName)}" /><ac:plain-text-link-body><![CDATA[${escapeCdata(node.textContent ?? attachmentName)}]]></ac:plain-text-link-body></ac:link>`;
}

function renderImage(
  node: HTMLImageElement,
  page: ParsedPage,
  binaryByPath: ReadonlyMap<string, VirtualFile>,
  assetNames: ReadonlySet<string>,
  errors: string[],
): string {
  const src = node.getAttribute("src") ?? "";
  const alt = node.getAttribute("alt") ?? "";
  if (/^(javascript|data):/i.test(src)) {
    errors.push(`unsafe URL: ${src}`);
    return "";
  }
  if (isExternalUrl(src))
    return `<ac:image ac:alt="${escapeAttr(alt)}"><ri:url ri:value="${escapeAttr(src)}" /></ac:image>`;
  const resolved = resolveVirtualPath(page.dir, src);
  const attachmentName = resolved.split("/").at(-1) ?? resolved;
  if (!binaryByPath.has(resolved) || !assetNames.has(attachmentName))
    errors.push(`Missing asset: ${resolved}`);
  return `<ac:image ac:alt="${escapeAttr(alt)}"><ri:attachment ri:filename="${escapeAttr(attachmentName)}" /></ac:image>`;
}

async function fetchExistingAttachmentSizes(
  pageId: string,
  api: ConfluenceApi,
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const attachments = await api.getAttachments(pageId, signal);
  return new Map(attachments.map((attachment) => [attachment.title, attachment.fileSize]));
}

async function fetchExistingChildTitles(
  parentId: string,
  api: ConfluenceApi,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const children = await api.getChildren(parentId, 100, signal);
  return new Set(children.map((child) => child.title));
}

function parentOrdered(pages: readonly ImportPagePlan[]): ImportPagePlan[] {
  return [...pages].sort(
    (a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path),
  );
}

function nearestSelectedAncestor(
  page: ImportPagePlan,
  failedPaths: ReadonlySet<string>,
): string | undefined {
  if (page.parentPath && failedPaths.has(page.parentPath)) return page.parentPath;
  return undefined;
}

function findParentPath(page: ParsedPage, pagePathSet: ReadonlySet<string>): string | undefined {
  let dir = dirname(page.dir);
  while (dir) {
    const candidate = `${dir}/index.md`;
    if (pagePathSet.has(candidate)) return candidate;
    dir = dirname(dir);
  }
  return undefined;
}

function countPlannedCreateSiblings(
  pages: readonly ParsedPage[],
  pagePathSet: ReadonlySet<string>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const page of pages) {
    if (page.frontMatter.page_id) continue;
    const parentPath = findParentPath(page, pagePathSet);
    const key = siblingKey(parentPath, page.title);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function siblingKey(parentPath: string | undefined, title: string): string {
  return `${parentPath ?? ""}\u0000${title}`;
}

function resolvePageLinkPlaceholders(
  storage: string,
  idByPath: ReadonlyMap<string, string>,
  titleByPath: ReadonlyMap<string, string>,
): string {
  return storage.replace(
    /<ri:page ri:content-id="CONFX_PAGE_LINK:([^"]+)" \/>/g,
    (_match, path: string) => {
      const normalizedPath = unescapeAttr(path);
      const id = idByPath.get(normalizedPath);
      const title = titleByPath.get(normalizedPath) ?? stem(normalizedPath);
      return id
        ? `<ri:page ri:content-id="${escapeAttr(id)}" />`
        : `<ri:page ri:content-title="${escapeAttr(title)}" />`;
    },
  );
}

function unescapeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function stripCommonRoot(files: VirtualFile[]): VirtualFile[] {
  assertNoDuplicatePaths(files);
  const firstSegments = files.map((file) => file.path.split("/")[0]);
  const common = firstSegments[0];
  if (!common || !files.every((file) => file.path.includes("/"))) return files;
  if (!firstSegments.every((segment) => segment === common)) return files;
  return files
    .map((file) => ({ ...file, path: file.path.slice(common.length + 1) }))
    .filter((file) => file.path);
}

function assertNoDuplicatePaths(files: readonly VirtualFile[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) throw new Error(`duplicate normalized path: ${file.path}`);
    seen.add(file.path);
  }
}

function normalizeRelativePath(path: string): string {
  if (path.includes("\0")) throw new Error("NUL byte in path");
  if (path.startsWith("/") || /^[a-z]:/i.test(path))
    throw new Error(`absolute path is not allowed: ${path}`);
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw new Error(`path traversal is not allowed: ${path}`);
    parts.push(part);
  }
  return parts.join("/");
}

function resolveVirtualPath(baseDir: string, href: string): string {
  const cleanHref = href.split(/[?#]/, 1)[0];
  const parts = [...baseDir.split("/"), ...cleanHref.split("/")];
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  return normalized.join("/");
}

function stripMarkedCommentsBlock(markdown: string): string {
  return markdown.replace(
    /<!-- confx:comments:start -->[\s\S]*?<!-- confx:comments:end -->\s*/g,
    "",
  );
}

function normalizeHost(value: string): string {
  try {
    const url = new URL(value);
    const basePath = url.pathname.startsWith("/wiki")
      ? "/wiki"
      : url.pathname.startsWith("/confluence")
        ? "/confluence"
        : "";
    return `${url.origin}${basePath}`.replace(/\/$/, "");
  } catch {
    return value.replace(/\/$/, "");
  }
}

function readRelativePath(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

function dirname(path: string): string {
  return path.split("/").slice(0, -1).join("/");
}

function stem(path: string): string {
  const name = path.split("/").at(-1) ?? path;
  return name.replace(/\.[^.]+$/, "");
}

function unquoteScalar(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}

function isExternalUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isImagePath(path: string, mediaType: string): boolean {
  return mediaType.startsWith("image/") || /\.(png|jpe?g|gif|svg|webp)$/i.test(path);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  return a.every((byte, index) => byte === b[index]);
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeXml(value).replace(/"/g, "&quot;");
}

function escapeCdata(value: string): string {
  return value.replace(/]]>/g, "]]]]><![CDATA[>");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
