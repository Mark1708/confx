import type { JiraIssueMeta } from "@/types";
import { htmlToMarkdown } from "./html-to-md";

/**
 * Check if an HTML string is a Jira issue page.
 * Looks for the `ajs-issue-key` meta tag that Jira Server injects.
 */
export function isJiraPage(html: string): boolean {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.querySelector('meta[name="ajs-issue-key"]') !== null;
}

/**
 * Extract the issue key from a Jira page's meta tag.
 * Returns null if not found.
 */
function getIssueKey(doc: Document): string | null {
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="ajs-issue-key"]');
  return meta?.getAttribute("content") ?? null;
}

/** Get text content of a selector, trimmed. Returns empty string if not found. */
function getText(doc: Document, selector: string): string {
  return (doc.querySelector<HTMLElement>(selector)?.textContent?.trim() ?? "")
    .replace(/\s+/g, " ");
}

/** Get text from an element's img alt attribute (Jira uses icons with alt text). */
function getImgAlt(doc: Document, selector: string): string {
  const el = doc.querySelector<HTMLElement>(selector);
  if (!el) return "";
  const img = el.querySelector<HTMLImageElement>("img");
  if (img?.alt) return img.alt.trim();
  return el.textContent?.trim().replace(/\s+/g, " ") ?? "";
}

/** Get user key from a `.user-hover` element's `rel` attribute. */
function getUserKey(doc: Document, selector: string): string | null {
  const el = doc.querySelector<HTMLElement>(selector);
  if (!el) return null;
  const userHover = el.querySelector<HTMLElement>("[rel]");
  if (userHover?.getAttribute("rel")) return userHover.getAttribute("rel");
  const text = el.textContent?.trim();
  return text && text !== "Не назначен" ? text : null;
}

/** Extract link texts from a value container (components, versions, etc). */
function getLinkTexts(doc: Document, selector: string): string[] {
  const el = doc.querySelector<HTMLElement>(selector);
  if (!el) return [];
  const links = el.querySelectorAll<HTMLAnchorElement>("a");
  if (links.length === 0) {
    const text = el.textContent?.trim() ?? "";
    if (!text || text === "Нет" || text === "Не заполнено") return [];
    return [text];
  }
  return Array.from(links).map((a) => a.textContent?.trim() ?? "").filter(Boolean);
}

/** Extract labels from `span.labels[id^="labels-"]` elements. */
function getLabels(doc: Document): string[] {
  const spans = doc.querySelectorAll<HTMLSpanElement>('span.labels[id^="labels-"]');
  const labels: string[] = [];
  for (const span of spans) {
    const text = span.textContent?.trim() ?? "";
    if (text && text !== "Не заполнено" && text !== "Нет") {
      labels.push(...text.split(/\s+/));
    }
  }
  return labels;
}

/** Extract epic link from customfield_10100-val. */
function getEpicLink(doc: Document): string | null {
  const el = doc.querySelector<HTMLElement>("#customfield_10100-val");
  if (!el) return null;
  const link = el.querySelector<HTMLAnchorElement>("a");
  if (link) {
    const href = link.getAttribute("href") ?? "";
    const match = href.match(/\/browse\/([A-Z]+-\d+)/);
    if (match) return match[1];
  }
  const text = el.textContent?.trim() ?? "";
  return text && text !== "Нет" ? text : null;
}

/** Extract date from a datetime element. */
function getDate(doc: Document, selector: string): string {
  const el = doc.querySelector<HTMLElement>(selector);
  if (!el) return "";
  const dt = el.getAttribute("datetime") ?? el.getAttribute("data-date") ?? "";
  if (dt) return dt;
  return el.textContent?.trim() ?? "";
}

/** Parse resolution: class "unresolved" means null. */
function getResolution(doc: Document): string | null {
  const el = doc.querySelector<HTMLElement>("#resolution-val");
  if (!el) return null;
  if (el.classList.contains("unresolved")) return null;
  const text = el.textContent?.trim().replace(/\s+/g, " ") ?? "";
  return text || null;
}

/**
 * Parse Jira issue metadata from a saved HTML page.
 * Returns null if the page is not a Jira issue.
 */
export function parseJiraIssueFromHtml(
  html: string,
  baseUrl: string,
): JiraIssueMeta | null {
  const doc = new DOMParser().parseFromString(html, "text/html");

  const key = getIssueKey(doc);
  if (!key) return null;

  const project = key.split("-")[0];
  const summary = getText(doc, "#summary-val");
  const type = getImgAlt(doc, "#type-val") || getText(doc, "#type-val");
  const status =
    getText(doc, "#status-val .jira-issue-status-lozenge") ||
    getText(doc, "#status-val");
  const priority = getImgAlt(doc, "#priority-val") || getText(doc, "#priority-val");
  const resolution = getResolution(doc);
  const assignee = getUserKey(doc, "#assignee-val");
  const reporter = getUserKey(doc, "#reporter-val");
  const labels = getLabels(doc);
  const components = getLinkTexts(doc, "#components-val");
  const versions = getLinkTexts(doc, "#versions-val");
  const fixVersions = getLinkTexts(doc, "#fixfor-val");
  const epicLink = getEpicLink(doc);
  const created = getDate(doc, "#created-val");
  const updated = getDate(doc, "#updated-val");
  const dueDate = getDate(doc, "#due-date");

  return {
    key,
    project,
    type: type || "Unknown",
    status: status || "Unknown",
    priority: priority || "Unset",
    resolution,
    summary,
    assignee,
    reporter,
    labels,
    components,
    versions,
    fixVersions,
    epicLink,
    created,
    updated,
    dueDate: dueDate || null,
    baseUrl,
    url: `${baseUrl}/browse/${key}`,
  };
}

/**
 * Parse the description HTML from a Jira issue page.
 * Returns Markdown version of the description.
 */
export function parseJiraDescription(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const descEl = doc.querySelector<HTMLElement>("#description-val");
  if (!descEl) return "";
  const descHtml = descEl.innerHTML;
  if (!descHtml.trim()) return "";
  return htmlToMarkdown(descHtml);
}
