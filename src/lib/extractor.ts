import type {
  ConfluencePageMeta,
  ExportFailure,
  ExtractedAttachment,
  ExtractedPage,
  ExtractionRule,
} from "@/types";
import { fetchAttachments, type FetchAttachmentsResult } from "./attachment-fetcher";
import { fetchCommentAttachments, fetchComments, fetchInlineComments } from "./comment-fetcher";
import type { ConfluenceApi, ConfluencePageRaw } from "./confluence-api";
import { AssetRegistry, type PageAssetRegistry } from "./export/asset-registry";
import { buildFrontMatter } from "./front-matter";
import { fetchHistory } from "./history-fetcher";
import { isAbortError } from "./http-client";
import { fetchImagesFromHtml } from "./image-fetcher";
import { makeLinkRewriter, relativePath } from "./link-rewriter";
import { encodeMarkdownDestination, encodeMarkdownLabel } from "./markdown-literals";
import { htmlToMarkdownWithLayout } from "./html-to-md";
import { fetchPlantUmlAssetsFromHtml, type FetchPlantUmlAssetsResult } from "./plantuml-assets";
import { applyRules } from "./rule-engine";
import { createStorageMarkdownExport, type StorageSnapshot } from "./storage-roundtrip";
import { slugify } from "./table-to-csv";

export interface ExtractPageOptions {
  rules: readonly ExtractionRule[];
  folder?: string;
  pageIdToFolder?: ReadonlyMap<string, string>;
  assets?: PageAssetRegistry;
  includeFrontMatter?: boolean;
  rewriteLinks?: boolean;
  /** Generate a reversible full-page sidecar (default: true). */
  includeEditable?: boolean;
  signal?: AbortSignal;
  /** Enable attachment export (default: true) */
  exportAttachments?: boolean;
  exportImages?: boolean;
  exportPlantUmlAssets?: boolean;
  /** Storage representation used to validate reversible Confluence layouts. */
  storageHtml?: string;
  /** Untouched complete published source. Null means a full fetch had no usable source. */
  fullPageStorage?: StorageSnapshot | null;
  /** Max attachment size in bytes */
  maxAttachmentSize?: number;
  /** Export page comments (default: false) */
  includeComments?: boolean;
  /** Export page version history (default: false) */
  includeHistory?: boolean;
}

export async function extractOnePage(
  api: ConfluenceApi,
  pageId: string,
  opts: ExtractPageOptions,
): Promise<ExtractedPage> {
  opts.signal?.throwIfAborted();
  const raw = await api.getPage(
    pageId,
    [
      "body.view",
      "body.storage",
      "children.attachment",
      "ancestors",
      "space",
      "version",
      "metadata.labels",
    ],
    opts.signal,
  );
  opts.signal?.throwIfAborted();
  const meta = api.toPageMeta(raw);
  const html = raw.body?.view?.value ?? "";
  return await extractFromHtml(api, html, meta, {
    ...opts,
    storageHtml: raw.body?.storage?.value,
    fullPageStorage: storageSnapshotForPage(raw),
  });
}

export async function extractFromHtml(
  api: ConfluenceApi,
  html: string,
  meta: ConfluencePageMeta,
  opts: ExtractPageOptions,
): Promise<ExtractedPage> {
  opts.signal?.throwIfAborted();
  const folder = opts.folder ?? "";
  const assets = opts.assets ?? new AssetRegistry(false).beginPage(folder);
  const editable =
    opts.includeEditable === false ? undefined : await createEditableExport(api, opts);
  opts.signal?.throwIfAborted();
  const { mainHtml, tables } = applyRules(html, opts.rules);

  const imageResult =
    opts.exportImages === false
      ? { images: [], srcToArchive: new Map<string, string>(), failures: [] }
      : await fetchImagesFromHtml(
          mainHtml,
          api,
          `${folder ? `${folder}/` : ""}images`,
          assets,
          opts.signal,
          meta.id,
        );
  opts.signal?.throwIfAborted();
  const plantUmlResult =
    opts.exportPlantUmlAssets === true
      ? await fetchPlantUmlAssetsFromHtml(mainHtml, {
          pageId: meta.id,
          folder,
          assets,
          maxAssetBytes: opts.maxAttachmentSize ?? 50 * 1024 * 1024,
          signal: opts.signal,
        })
      : emptyPlantUmlResult();
  opts.signal?.throwIfAborted();
  const { images, srcToArchive } = imageResult;

  let attachments: ExtractedAttachment[] = [];
  let attachmentLinkToArchive = new Map<string, string>();
  let attachmentOutcome = emptyAttachmentOutcome();
  let attachmentFailures: ExportFailure[] = [];

  if (opts.exportAttachments !== false) {
    const attachResult = await fetchAttachments(meta.id, api, {
      folder: `${folder ? `${folder}/` : ""}attachments`,
      assets,
      maxSize: opts.maxAttachmentSize,
      includeImages: opts.exportImages !== false,
      signal: opts.signal,
    });
    attachments = attachResult.attachments;
    attachmentLinkToArchive = attachResult.linkToArchive;
    attachmentOutcome = attachResult.outcome;
    attachmentFailures = attachResult.failures;
  }

  const linkRewriter = makeLinkRewriter({
    host: api.host,
    pageIdToFolder: opts.rewriteLinks ? opts.pageIdToFolder : undefined,
    currentFolder: folder,
    attachmentLinks: attachmentLinkToArchive,
  });

  const conversion = htmlToMarkdownWithLayout(mainHtml, {
    storageHtml: opts.storageHtml,
    spoilersAsDetails: true,
    imageReplacer: (img) => {
      const src = img.getAttribute("data-image-src") || img.getAttribute("src") || "";
      const alt = encodeMarkdownLabel(img.getAttribute("alt") || "");
      if (/^data:/i.test(src)) return `![${alt}](${encodeMarkdownDestination(src)})`;
      const mapped = srcToArchive.get(src);
      if (mapped) {
        return `![${alt}](${encodeMarkdownDestination(relativePath(folder, mapped))})`;
      }
      if (!src) return "";
      let onlineSource = src;
      try {
        onlineSource = new URL(src, meta.url || `${api.host}/`).href;
      } catch {
        // Preserve authored URLs that cannot be resolved instead of inventing a local archive path.
      }
      return `![${alt}](${encodeMarkdownDestination(onlineSource)})`;
    },
    linkRewriter,
    linkRenderer: (href, text) => {
      const pngPath = plantUmlResult.hrefToPng.get(href);
      return pngPath
        ? `![${text || "PlantUML diagram"}](${encodeMarkdownDestination(
            relativePath(folder, pngPath),
          )})`
        : undefined;
    },
  });
  const md = conversion.markdown;

  opts.signal?.throwIfAborted();
  const fetchedComments = opts.includeComments
    ? await fetchComments(meta.id, api, opts.signal)
    : [];
  opts.signal?.throwIfAborted();
  const fetchedInlineComments = opts.includeComments
    ? await fetchInlineComments(meta.id, api, opts.signal)
    : [];
  opts.signal?.throwIfAborted();
  const history = opts.includeHistory ? await fetchHistory(meta.id, api, opts.signal) : [];
  opts.signal?.throwIfAborted();

  let comments = fetchedComments;
  let inlineComments = fetchedInlineComments;
  let commentAttachments: ExtractedAttachment[] = [];
  let commentAttachmentOutcome = emptyAttachmentOutcome();
  let commentAttachmentFailures: ExportFailure[] = [];

  if (opts.includeComments && opts.exportAttachments !== false) {
    const commentResult = await fetchCommentAttachments(comments, inlineComments, api, {
      pageId: meta.id,
      folder,
      assets,
      maxSize: opts.maxAttachmentSize,
      signal: opts.signal,
    });
    comments = commentResult.comments;
    inlineComments = commentResult.inlineComments;
    commentAttachments = commentResult.attachments;
    commentAttachmentOutcome = commentResult.outcome;
    commentAttachmentFailures = commentResult.failures;
  }
  opts.signal?.throwIfAborted();

  const frontMatter =
    opts.includeFrontMatter !== false
      ? buildFrontMatter(meta, {
          versionCount: history.length,
          layoutStatus: conversion.layout.status === "none" ? undefined : conversion.layout.status,
        })
      : "";
  const title = `# ${meta.title}\n\n`;

  return {
    meta,
    markdown: frontMatter + title + md,
    editable,
    tables,
    images,
    attachments,
    plantUmlAssets: plantUmlResult.assets,
    commentAttachments,
    comments,
    inlineComments,
    history,
    folder,
    outcome: {
      attachments: {
        declared: meta.attachmentCount ?? null,
        listed: attachmentOutcome.listed + commentAttachmentOutcome.listed,
        eligible: attachmentOutcome.eligible + commentAttachmentOutcome.eligible,
        archived: attachments.length + commentAttachments.length,
        skippedSize: attachmentOutcome.skippedSize + commentAttachmentOutcome.skippedSize,
        failedDownloads:
          attachmentOutcome.failedDownloads + commentAttachmentOutcome.failedDownloads,
      },
      plantUml: plantUmlResult.outcome,
      layout: conversion.layout,
      failures: [
        ...imageResult.failures,
        ...attachmentFailures,
        ...commentAttachmentFailures,
        ...plantUmlResult.failures,
        ...(conversion.layout.status === "flattened"
          ? [
              {
                scope: "page" as const,
                page_id: meta.id,
                reason: "layout-unsupported" as const,
              },
            ]
          : []),
      ],
    },
  };
}

/** Capture identity only from the same published API response as the original storage. */
export function storageSnapshotForPage(raw: ConfluencePageRaw): StorageSnapshot | null {
  const storage = raw.body?.storage;
  const version = raw.version?.number;
  if (
    raw.type !== "page" ||
    raw.status !== "current" ||
    typeof raw.id !== "string" ||
    !/^\d+$/.test(raw.id) ||
    !/[1-9]/.test(raw.id) ||
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version <= 0 ||
    storage?.representation !== "storage" ||
    typeof storage.value !== "string" ||
    typeof raw.title !== "string"
  ) {
    return null;
  }
  return {
    representation: "storage",
    html: storage.value,
    title: raw.title,
    pageId: raw.id,
    version,
  };
}

async function createEditableExport(
  api: ConfluenceApi,
  opts: ExtractPageOptions,
): Promise<NonNullable<ExtractedPage["editable"]>> {
  if (opts.fullPageStorage === undefined) {
    return { status: "unavailable", reason: "partial-export" };
  }
  // Conservative by design: source must not disclose data removed by any active rule,
  // even if its selector happens not to match the current rendered representation.
  if (
    opts.rules.some(
      (rule) =>
        rule.enabled &&
        (rule.action === "skip" ||
          (rule.action === "to-csv" && rule.options?.removeAfterCsv === true)),
    )
  ) {
    return { status: "unavailable", reason: "filtered-content" };
  }
  const snapshot = opts.fullPageStorage;
  if (!snapshot) return { status: "unavailable", reason: "source-unavailable" };
  try {
    opts.signal?.throwIfAborted();
    const exported = await createStorageMarkdownExport(snapshot, {
      host: api.host,
      pageId: snapshot.pageId,
    });
    opts.signal?.throwIfAborted();
    return {
      status: "available",
      markdown: exported.markdown,
      representation: "storage",
      version: snapshot.version,
      sourceHash: exported.sourceHash,
    };
  } catch (error) {
    if (opts.signal?.aborted || isAbortError(error)) {
      throw error;
    }
    // Never log the rejected source or include exception details in an archive.
    return { status: "unavailable", reason: "invalid-source" };
  }
}

function emptyAttachmentOutcome(): FetchAttachmentsResult["outcome"] {
  return {
    listed: 0,
    eligible: 0,
    archived: 0,
    skippedSize: 0,
    failedDownloads: 0,
  };
}

function emptyPlantUmlResult(): FetchPlantUmlAssetsResult {
  return {
    assets: [],
    hrefToPng: new Map(),
    outcome: {
      discovered: 0,
      archived: 0,
      skippedLimit: 0,
      failedDownloads: 0,
      unsupported: 0,
    },
    failures: [],
  };
}

export function folderForPage(meta: ConfluencePageMeta): string {
  return slugify(meta.title) || `page-${meta.id}`;
}
