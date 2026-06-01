import { type FetchOptions, HttpClient, normalizePath } from "@/lib/http-client";
import type { JiraAttachment, JiraComment, JiraIssueMeta } from "@/types";

export type { FetchOptions } from "@/lib/http-client";

function isAbsoluteUrl(path: string): boolean {
  try {
    const url = new URL(path);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  const child = isRecord(value) ? value[key] : undefined;
  return isRecord(child) ? child : undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getNullableNamedValue(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return getString(value.name) ?? null;
}

function getUserKey(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return getString(value.key) ?? getString(value.name) ?? getString(value.accountId) ?? null;
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function getNamedArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (isRecord(item) ? getString(item.name) : undefined))
    .filter((item): item is string => typeof item === "string");
}

function fallbackProjectKey(issueKey: string): string {
  const separatorIndex = issueKey.indexOf("-");
  return separatorIndex > 0 ? issueKey.slice(0, separatorIndex) : "";
}

export function toIssueMeta(raw: unknown, baseUrl = ""): JiraIssueMeta {
  const issue = isRecord(raw) ? raw : {};
  const fields = getRecord(issue, "fields") ?? {};
  const key = getString(issue.key) ?? "";
  const project = getRecord(fields, "project");

  return {
    key,
    project: getString(project?.key) ?? getString(project?.name) ?? fallbackProjectKey(key),
    type: getNullableNamedValue(fields.issuetype) ?? "",
    status: getNullableNamedValue(fields.status) ?? "",
    priority: getNullableNamedValue(fields.priority) ?? "",
    resolution: getNullableNamedValue(fields.resolution),
    summary: getString(fields.summary) ?? "",
    assignee: getUserKey(fields.assignee),
    reporter: getUserKey(fields.reporter),
    labels: getStringArray(fields.labels),
    components: getNamedArray(fields.components),
    versions: getNamedArray(fields.versions),
    fixVersions: getNamedArray(fields.fixVersions),
    epicLink: getString(fields.customfield_10100) ?? null,
    created: getString(fields.created) ?? "",
    updated: getString(fields.updated) ?? "",
    dueDate: getString(fields.duedate) ?? null,
    baseUrl,
    url: `${baseUrl}/browse/${encodeURIComponent(key)}`,
  };
}

function toComment(raw: unknown): JiraComment {
  const comment = isRecord(raw) ? raw : {};
  return {
    id: getString(comment.id) ?? "",
    author: getUserKey(comment.author) ?? "",
    createdAt: getString(comment.created) ?? "",
    body: getString(comment.body) ?? "",
    markdown: getString(comment.body) ?? "",
  };
}

function toAttachment(raw: unknown): JiraAttachment {
  const attachment = isRecord(raw) ? raw : {};
  return {
    id: getString(attachment.id) ?? "",
    fileName: getString(attachment.filename) ?? "",
    mediaType: getString(attachment.mimeType) ?? "application/octet-stream",
    fileSize: typeof attachment.size === "number" ? attachment.size : 0,
    contentUrl: getString(attachment.content) ?? "",
  };
}

export class JiraApi extends HttpClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string, options: FetchOptions = {}) {
    super("Jira API", options);
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  get host(): string {
    return this.baseUrl;
  }

  url(path: string): string {
    return isAbsoluteUrl(path) ? path : `${this.baseUrl}${normalizePath(path)}`;
  }

  async getIssue(issueKey: string, signal?: AbortSignal): Promise<JiraIssueMeta> {
    const raw = await this.fetchJson<unknown>(
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}`,
      signal,
    );
    return toIssueMeta(raw, this.baseUrl);
  }

  async searchIssues(jql: string, maxResults = 50, signal?: AbortSignal): Promise<JiraIssueMeta[]> {
    const params = new URLSearchParams({ jql, maxResults: String(maxResults) });
    const raw = await this.fetchJson<unknown>(`/rest/api/2/search?${params.toString()}`, signal);
    const issues = isRecord(raw) && Array.isArray(raw.issues) ? raw.issues : [];
    return issues.map((issue) => toIssueMeta(issue, this.baseUrl));
  }

  async getComments(issueKey: string, signal?: AbortSignal): Promise<JiraComment[]> {
    const raw = await this.fetchJson<unknown>(
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment`,
      signal,
    );
    const comments = isRecord(raw) && Array.isArray(raw.comments) ? raw.comments : [];
    return comments.map(toComment);
  }

  async getAttachments(issueKey: string, signal?: AbortSignal): Promise<JiraAttachment[]> {
    const raw = await this.fetchJson<unknown>(
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}`,
      signal,
    );
    const fields = getRecord(raw, "fields") ?? {};
    const attachments = Array.isArray(fields.attachment) ? fields.attachment : [];
    return attachments.map(toAttachment);
  }

}
