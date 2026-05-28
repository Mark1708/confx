/**
 * Internal Confluence links → relative ZIP paths.
 * External links are kept as-is.
 */

export interface LinkRewriterContext {
  host: string;
  /** Map pageId → folder path inside the ZIP, e.g. "components/menu" */
  pageIdToFolder: Map<string, string>;
  /** Current page's folder path in the ZIP */
  currentFolder: string;
  /** Map of attachment download paths to zip paths */
  attachmentLinks?: Map<string, string>;
}

export function makeLinkRewriter(ctx: LinkRewriterContext): (href: string, text: string) => string {
  return (href: string): string => {
    if (!href) return href;
    if (href.startsWith("#")) return href; // anchor on same page
    if (href.startsWith("mailto:") || href.startsWith("tel:")) return href;

    let url: URL;
    try {
      url = new URL(href, ctx.host);
    } catch {
      return href;
    }

    const sameHost = url.origin === new URL(ctx.host).origin;
    if (!sameHost) return href;

    const pageId = url.searchParams.get("pageId");
    const target = pageId ? ctx.pageIdToFolder.get(pageId) : undefined;
    if (target) {
      const rel = relativePath(ctx.currentFolder, `${target}/index.md`);
      return `${rel}${url.hash || ""}`;
    }

    const attachmentPath = findAttachmentPath(href, url, ctx.attachmentLinks);
    if (attachmentPath) return relativePath(ctx.currentFolder, attachmentPath);

    return href; // kept absolute if not in export set
  };
}

function findAttachmentPath(
  href: string,
  url: URL,
  attachmentLinks?: Map<string, string>,
): string | undefined {
  if (!attachmentLinks) return undefined;

  const pathWithoutParams = url.pathname + url.search;
  for (const [downloadPath, zipPath] of attachmentLinks) {
    if (href.includes(downloadPath) || pathWithoutParams.includes(downloadPath)) return zipPath;
  }

  const attachMatch = url.pathname.match(/\/download\/attachments\/\d+\/(.+)$/);
  if (!attachMatch) return undefined;

  const fileName = decodeURIComponent(attachMatch[1]);
  for (const [downloadPath, zipPath] of attachmentLinks) {
    if (downloadPath.includes(fileName)) return zipPath;
  }

  return undefined;
}

export function relativePath(from: string, to: string): string {
  const fromParts = from.split("/").filter(Boolean);
  const toParts = to.split("/").filter(Boolean);
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common++;
  }
  const up = fromParts.length - common;
  const down = toParts.slice(common);
  const rel = [...Array(up).fill(".."), ...down].join("/");
  return rel || `./${to.split("/").pop()}`;
}
