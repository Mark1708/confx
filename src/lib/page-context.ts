import { extractHostFromUrl, extractPageIdFromUrl } from "@/lib/confluence-api";

const ISSUE_KEY_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/;

export type PageContext =
  | {
      kind: "confluence";
      host: string;
      pageId: string;
      title?: string;
    }
  | {
      kind: "jira";
      host: string;
      issueKey: string;
      title?: string;
    }
  | {
      kind: "unknown";
      host?: string;
      title?: string;
    };

export interface PageContextInput {
  url?: string;
  title?: string;
  meta?: {
    confluencePageId?: string | null;
    confluenceTitle?: string | null;
    jiraIssueKey?: string | null;
  };
}

export function detectPageContext(input: PageContextInput): PageContext {
  const host = input.url ? safeHost(input.url) : undefined;
  const issueKey = normalizeIssueKey(input.meta?.jiraIssueKey) ?? extractJiraIssueKey(input.url);

  if (issueKey && host) {
    return { kind: "jira", host, issueKey, title: input.title };
  }

  const pageId = normalizePageId(input.meta?.confluencePageId) ?? extractConfluencePageId(input.url);

  if (pageId && host) {
    return {
      kind: "confluence",
      host,
      pageId,
      title: input.meta?.confluenceTitle ?? input.title,
    };
  }

  return { kind: "unknown", host, title: input.title };
}

export function readDocumentPageContext(document: Document, url: string, title: string): PageContext {
  return detectPageContext({
    url,
    title,
    meta: {
      confluencePageId: readMeta(document, "ajs-page-id"),
      confluenceTitle: readMeta(document, "ajs-page-title"),
      jiraIssueKey: readMeta(document, "ajs-issue-key"),
    },
  });
}

export function extractJiraIssueKey(url?: string): string | null {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    const selectedIssue = normalizeIssueKey(parsed.searchParams.get("selectedIssue"));
    if (selectedIssue) return selectedIssue;

    const segments = parsed.pathname.split("/").filter(Boolean);
    const browseIndex = segments.indexOf("browse");
    const browseIssue = browseIndex >= 0 ? normalizeIssueKey(segments[browseIndex + 1]) : null;
    if (browseIssue) return browseIssue;

    const segmentIssue = segments.map(normalizeIssueKey).find((key): key is string => Boolean(key));
    if (segmentIssue) return segmentIssue;

    return normalizeIssueKey(decodeURIComponent(parsed.pathname));
  } catch {
    return null;
  }
}

function extractConfluencePageId(url?: string): string | null {
  return url ? extractPageIdFromUrl(url) : null;
}

function normalizeIssueKey(value?: string | null): string | null {
  const match = value?.toUpperCase().match(ISSUE_KEY_PATTERN);
  return match?.[0] ?? null;
}

function normalizePageId(value?: string | null): string | null {
  return value && /^\d+$/.test(value) ? value : null;
}

function readMeta(document: Document, name: string): string | null {
  return document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? null;
}

function safeHost(url: string): string | undefined {
  try {
    return extractHostFromUrl(url);
  } catch {
    return undefined;
  }
}
