export interface SourceContext {
  tabId: number;
  windowId: number;
  product: "confluence" | "jira" | "other";
  baseUrl: string;
  pageUrl: string;
  pageId?: string;
  spaceKey?: string;
  issueKey?: string;
}

export type BaseOverrideDiagnostic = "invalid-url" | "cross-origin" | "path-mismatch";

function httpUrl(input: string): URL {
  const url = new URL(input);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new Error("Source base must be an HTTP(S) URL without credentials");
  }
  return url;
}

export function canonicalBaseUrl(input: string): string {
  const url = httpUrl(input);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function containsPath(source: URL, base: URL): boolean {
  const prefix = base.pathname.replace(/\/+$/, "");
  return !prefix || source.pathname === prefix || source.pathname.startsWith(`${prefix}/`);
}

export function resolveSourceBase(
  sourceUrl: string,
  detectedBase: string,
  override?: string,
): { baseUrl: string; overrideDiagnostic?: BaseOverrideDiagnostic } {
  const source = httpUrl(sourceUrl);
  const baseUrl = canonicalBaseUrl(detectedBase);
  const detected = new URL(baseUrl);
  if (source.origin !== detected.origin || !containsPath(source, detected)) {
    throw new Error("Detected base does not match the source URL");
  }
  if (!override?.trim()) return { baseUrl };

  let configured: URL;
  try {
    configured = httpUrl(override);
  } catch {
    return { baseUrl, overrideDiagnostic: "invalid-url" };
  }
  if (configured.origin !== source.origin) return { baseUrl, overrideDiagnostic: "cross-origin" };
  if (!containsPath(source, configured)) return { baseUrl, overrideDiagnostic: "path-mismatch" };
  return { baseUrl: canonicalBaseUrl(configured.href) };
}

export function sourceKey(
  source: Pick<SourceContext, "tabId" | "product" | "baseUrl"> & Partial<SourceContext>,
): string {
  return `${source.tabId}:${source.product}:${canonicalBaseUrl(source.baseUrl)}`;
}
