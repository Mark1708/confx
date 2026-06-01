import type {
  ConfluencePageMeta,
  ExtractedAttachment,
  ExtractedPage,
  ExtractionRule,
} from "@/types";
import { fetchAttachments } from "./attachment-fetcher";
import { commentsToMarkdown, fetchComments } from "./comment-fetcher";
import type { ConfluenceApi } from "./confluence-api";
import { buildFrontMatter } from "./front-matter";
import { fetchHistory } from "./history-fetcher";
import { htmlToMarkdown } from "./html-to-md";
import { fetchImagesFromHtml, type ImageDedup } from "./image-fetcher";
import { makeLinkRewriter } from "./link-rewriter";
import { applyRules } from "./rule-engine";
import { slugify } from "./table-to-csv";

export interface ExtractPageOptions {
  rules: ExtractionRule[];
  folder?: string;
  pageIdToFolder?: Map<string, string>;
  dedup?: ImageDedup;
  includeFrontMatter?: boolean;
  rewriteLinks?: boolean;
  signal?: AbortSignal;
  /** Enable attachment export (default: true) */
  exportAttachments?: boolean;
  exportImages?: boolean;
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
  const raw = await api.getPage(
    pageId,
    ["body.view", "children.attachment", "ancestors", "space", "version", "metadata.labels"],
    opts.signal,
  );
  const meta = api.toPageMeta(raw);
  const html = raw.body?.view?.value ?? "";
  return await extractFromHtml(api, html, meta, opts);
}

export async function extractFromHtml(
  api: ConfluenceApi,
  html: string,
  meta: ConfluencePageMeta,
  opts: ExtractPageOptions,
): Promise<ExtractedPage> {
  const folder = opts.folder ?? "";
  const imagesSubfolder = "images";

  const { mainHtml, tables } = applyRules(html, opts.rules);

  // Fetch images first to know their zip paths for link rewriting in MD
  const imageResult =
    opts.exportImages === false
      ? { images: [], srcToZip: new Map<string, string>() }
      : await fetchImagesFromHtml(mainHtml, api, imagesSubfolder, opts.dedup, opts.signal);
  const { images, srcToZip } = imageResult;

  let attachments: ExtractedAttachment[] = [];
  let attachmentLinkToZip = new Map<string, string>();

  if (opts.exportAttachments !== false) {
    const attachResult = await fetchAttachments(
      meta.id,
      api,
      "attachments",
      opts.dedup,
      opts.maxAttachmentSize,
      opts.signal,
    );
    attachments = attachResult.attachments;
    attachmentLinkToZip = attachResult.linkToZip;
  }

  const linkRewriter =
    opts.rewriteLinks && opts.pageIdToFolder
      ? makeLinkRewriter({
          host: api.host,
          pageIdToFolder: opts.pageIdToFolder,
          currentFolder: folder,
          attachmentLinks: attachmentLinkToZip,
        })
      : undefined;

  const md = htmlToMarkdown(mainHtml, {
    spoilersAsDetails: true,
    imageReplacer: (img) => {
      const src = img.getAttribute("data-image-src") || img.getAttribute("src") || "";
      const alt = img.getAttribute("alt") || "";
      const mapped = srcToZip.get(src);
      if (mapped) {
        // mapped path is relative to page folder
        return `![${alt}](${mapped})`;
      }
      return src ? `![${alt}](${src})` : "";
    },
    linkRewriter,
  });

  const fm =
    opts.includeFrontMatter !== false
      ? buildFrontMatter(meta, { commentCount: 0, versionCount: 0 })
      : "";
  const title = `# ${meta.title}\n\n`;
  const markdown = fm + title + md;

  // Fetch comments if enabled
  const comments = opts.includeComments ? await fetchComments(meta.id, api, opts.signal) : [];

  // Fetch history if enabled
  const history = opts.includeHistory ? await fetchHistory(meta.id, api, opts.signal) : [];

  // Append comments to markdown if present
  const fullMarkdown = comments.length > 0 ? markdown + commentsToMarkdown(comments) : markdown;

  // Rebuild front matter with actual counts
  const finalMarkdown =
    opts.includeFrontMatter !== false
      ? buildFrontMatter(meta, { commentCount: comments.length, versionCount: history.length }) +
        title +
        md +
        (comments.length > 0 ? commentsToMarkdown(comments) : "")
      : fullMarkdown;

  return {
    meta,
    markdown: finalMarkdown,
    tables,
    images,
    attachments,
    comments,
    history,
    folder,
  };
}

export function folderForPage(meta: ConfluencePageMeta): string {
  return slugify(meta.title) || `page-${meta.id}`;
}
