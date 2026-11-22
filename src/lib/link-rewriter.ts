/**
 * Internal Confluence links → relative ZIP paths.
 * External links are kept as-is.
 */

export interface LinkRewriterContext {
  host: string;
  /** Map pageId → folder path inside the ZIP, e.g. "components/menu" */
  pageIdToFolder?: ReadonlyMap<string, string>;
  /** Current page's folder path in the ZIP */
  currentFolder: string;
  /** Exact resource URLs to package-content-root-relative paths of archived files. */
  attachmentLinks?: ReadonlyMap<string, string>;
}

export function makeLinkRewriter(ctx: LinkRewriterContext): (href: string, text: string) => string {
  const base = `${ctx.host.replace(/\/+$/, "")}/`;
  const origin = new URL(base).origin;
  const attachments = new Map<string, string | null>();
  for (const [href, archivePath] of ctx.attachmentLinks ?? []) {
    const key = resourceKey(href, base);
    if (key === undefined) continue;
    const previous = attachments.get(key);
    attachments.set(key, previous === undefined || previous === archivePath ? archivePath : null);
  }
  return (href: string): string => {
    if (!href) return href;
    if (href.startsWith("#")) return href; // anchor on same page
    if (/^(?:mailto:|tel:|data:)/i.test(href)) return href;

    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      return href;
    }

    if (url.origin !== origin || url.username || url.password) return href;

    const pageId = url.searchParams.get("pageId");
    const target = pageId ? ctx.pageIdToFolder?.get(pageId) : undefined;
    if (target !== undefined) {
      const rel = relativePath(ctx.currentFolder, `${target ? `${target}/` : ""}index.md`);
      return `${rel}${url.hash || ""}`;
    }

    const key = resourceKey(url.href, base);
    const attachmentPath = key === undefined ? undefined : attachments.get(key);
    if (attachmentPath) return `${relativePath(ctx.currentFolder, attachmentPath)}${url.hash}`;

    return url.href;
  };
}

function resourceKey(href: string, base: string): string | undefined {
  try {
    const url = new URL(href, base);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return undefined;
    const path = url.pathname
      .split("/")
      .map((segment) => encodeURIComponent(decodeURIComponent(segment).normalize("NFC")))
      .join("/");
    const parameters = new URLSearchParams(url.search);
    parameters.sort();
    return `${url.origin}${path}${parameters.size ? `?${parameters}` : ""}`;
  } catch {
    return undefined;
  }
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
