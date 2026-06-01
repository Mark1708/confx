import {
  extractConfluenceBaseUrlFromUrl,
  extractHostFromUrl,
  extractPageIdFromUrl,
} from "@/lib/confluence-api";

const ISSUE_KEY_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/;
const JIRA_CONTEXT_PATH = "jira";

export type PageContextDetectionSource = "meta" | "url" | "none";

export interface PageContextButtonVisibilityState {
  showConfluenceButton: boolean;
  showJiraButton: boolean;
}

export interface PageContextDiagnostics {
  detectedKind: PageContext["kind"];
  host?: string;
  pageId?: string;
  issueKey?: string;
  detectionSource: PageContextDetectionSource;
  detectionReason: string;
  buttonVisibility: {
    confluence: {
      enabled: boolean;
      visible: boolean;
    };
    jira: {
      enabled: boolean;
      visible: boolean;
    };
  };
}

export interface PageContextAnalysis {
  context: PageContext;
  diagnostics: PageContextDiagnostics;
}

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
  return detectPageContextWithDiagnostics(input).context;
}

export function detectPageContextWithDiagnostics(
  input: PageContextInput,
  buttonVisibility: PageContextButtonVisibilityState = {
    showConfluenceButton: true,
    showJiraButton: true,
  },
): PageContextAnalysis {
  const originHost = input.url ? safeHost(input.url) : undefined;
  const jiraBaseUrl = input.url ? safeJiraBaseUrl(input.url) : undefined;
  const issueKeyFromMeta = normalizeIssueKey(input.meta?.jiraIssueKey);
  const issueKeyFromUrl = issueKeyFromMeta ? null : extractJiraIssueKey(input.url);
  const pageIdFromMeta = normalizePageId(input.meta?.confluencePageId);
  const pageIdFromUrl = pageIdFromMeta ? null : extractConfluencePageId(input.url);
  const confluenceBaseUrl = input.url ? safeConfluenceBaseUrl(input.url) : undefined;

  if (issueKeyFromMeta && jiraBaseUrl) {
    const context: PageContext = {
      kind: "jira",
      host: jiraBaseUrl,
      issueKey: issueKeyFromMeta,
      title: input.title,
    };

    return {
      context,
      diagnostics: buildDiagnostics(context, {
        detectionSource: "meta",
        detectionReason: "Detected Jira issue key from page metadata.",
        buttonVisibility,
      }),
    };
  }

  if (issueKeyFromUrl && jiraBaseUrl) {
    const context: PageContext = {
      kind: "jira",
      host: jiraBaseUrl,
      issueKey: issueKeyFromUrl,
      title: input.title,
    };

    return {
      context,
      diagnostics: buildDiagnostics(context, {
        detectionSource: "url",
        detectionReason: "Detected Jira issue key from the current URL.",
        buttonVisibility,
      }),
    };
  }

  if (pageIdFromMeta && confluenceBaseUrl) {
    const context: PageContext = {
      kind: "confluence",
      host: confluenceBaseUrl,
      pageId: pageIdFromMeta,
      title: input.meta?.confluenceTitle ?? input.title,
    };

    return {
      context,
      diagnostics: buildDiagnostics(context, {
        detectionSource: "meta",
        detectionReason: "Detected Confluence page id from page metadata.",
        buttonVisibility,
      }),
    };
  }

  if (pageIdFromUrl && confluenceBaseUrl) {
    const context: PageContext = {
      kind: "confluence",
      host: confluenceBaseUrl,
      pageId: pageIdFromUrl,
      title: input.meta?.confluenceTitle ?? input.title,
    };

    return {
      context,
      diagnostics: buildDiagnostics(context, {
        detectionSource: "url",
        detectionReason: "Detected Confluence page id from the current URL.",
        buttonVisibility,
      }),
    };
  }

  const context: PageContext = { kind: "unknown", host: originHost, title: input.title };

  return {
    context,
    diagnostics: buildDiagnostics(context, {
      detectionSource: "none",
      detectionReason: getUnknownDetectionReason(input.url, originHost),
      buttonVisibility,
    }),
  };
}

export function readDocumentPageContext(
  document: Document,
  url: string,
  title: string,
): PageContext {
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
    const segments = parsed.pathname.split("/").filter(Boolean);
    const browseIndex = segments.indexOf("browse");
    const browseIssue = browseIndex >= 0 ? normalizeIssueKey(segments[browseIndex + 1]) : null;
    if (browseIssue) return browseIssue;

    const selectedIssue = normalizeIssueKey(parsed.searchParams.get("selectedIssue"));
    if (selectedIssue && isSafeSelectedIssueRoute(segments)) return selectedIssue;

    return extractIssueFromKnownRoute(segments);
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

function isSafeSelectedIssueRoute(segments: string[]): boolean {
  return segments[0] === JIRA_CONTEXT_PATH || segments[0] === "secure";
}

function extractIssueFromKnownRoute(segments: string[]): string | null {
  const issuesIndex = segments.indexOf("issues");
  const hasProjectsRoute = issuesIndex > 0 && segments.includes("projects");
  return hasProjectsRoute ? normalizeIssueKey(segments[issuesIndex + 1]) : null;
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

function safeConfluenceBaseUrl(url: string): string | undefined {
  try {
    return extractConfluenceBaseUrlFromUrl(url);
  } catch {
    return undefined;
  }
}

function safeJiraBaseUrl(url: string): string | undefined {
  try {
    return extractJiraBaseUrlFromUrl(url);
  } catch {
    return undefined;
  }
}

function buildDiagnostics(
  context: PageContext,
  details: {
    detectionSource: PageContextDetectionSource;
    detectionReason: string;
    buttonVisibility: PageContextButtonVisibilityState;
  },
): PageContextDiagnostics {
  const confluenceEnabled = details.buttonVisibility.showConfluenceButton;
  const jiraEnabled = details.buttonVisibility.showJiraButton;

  return {
    detectedKind: context.kind,
    host: context.host,
    pageId: context.kind === "confluence" ? context.pageId : undefined,
    issueKey: context.kind === "jira" ? context.issueKey : undefined,
    detectionSource: details.detectionSource,
    detectionReason: details.detectionReason,
    buttonVisibility: {
      confluence: {
        enabled: confluenceEnabled,
        visible: confluenceEnabled && context.kind === "confluence",
      },
      jira: {
        enabled: jiraEnabled,
        visible: jiraEnabled && context.kind === "jira",
      },
    },
  };
}

function getUnknownDetectionReason(
  url: string | undefined,
  originHost: string | undefined,
): string {
  if (!url) return "No tab URL was provided.";
  if (!originHost) return "The URL could not be parsed.";
  return "The tab URL did not match supported Confluence or Jira patterns.";
}

function extractJiraBaseUrlFromUrl(url: string): string {
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean);
  const browseIndex = segments.indexOf("browse");

  if (browseIndex > 0) {
    return `${parsed.origin}/${segments.slice(0, browseIndex).join("/")}`;
  }

  if (segments[0] === JIRA_CONTEXT_PATH) {
    return `${parsed.origin}/${JIRA_CONTEXT_PATH}`;
  }

  return parsed.origin;
}
