import type { Zip } from "fflate";
import { createTranslator } from "@/i18n";
import { createJiraApi } from "@/lib/create-api";
import type { JiraApi } from "@/lib/jira-api";
import { extractJiraIssue as extractIssueLib, jiraIssuesToCsv } from "@/lib/jira-extractor";
import { loadSettings } from "@/lib/settings";
import type {
  ExtractedJiraIssue,
  ExtractJiraIssueRequest,
  ExtractJiraSearchRequest,
  JiraAttachment,
} from "@/types";
import type { ExtractJobResult } from "./extraction-shared";
import { p, type ProgressHandler } from "./progress";
import {
  addFile,
  addStringFile,
  blobToUint8Array,
  chunksToZipBlob,
  createZip,
  safeZipSegment,
} from "./zip-utils";

export async function extractJiraIssue(
  req: ExtractJiraIssueRequest,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<ExtractJobResult> {
  const settings = await loadSettings();
  const t = createTranslator(settings.locale);
  const api = await createJiraApi(req.host);

  p(onProgress, 0, 1, t("export.progress.fetchingJiraIssue"));
  const issue = await loadJiraIssue(api, req.issueKey, signal);

  p(onProgress, 1, 1, t("export.progress.buildingArchive"));
  const zipBlob = await bundleJiraIssue(api, issue, signal);
  return {
    fileName: `${safeZipSegment(issue.meta.key) || "jira-issue"}.zip`,
    zipBlob,
  };
}

export async function extractJiraSearch(
  req: ExtractJiraSearchRequest,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<ExtractJobResult> {
  const settings = await loadSettings();
  const t = createTranslator(settings.locale);
  const api = await createJiraApi(req.host);

  p(onProgress, 0, 1, t("export.progress.searchingJiraIssues"));
  const metas = await api.searchIssues(req.jql, 50, signal);
  const issues: ExtractedJiraIssue[] = [];

  for (let i = 0; i < metas.length; i += 1) {
    p(
      onProgress,
      i,
      metas.length,
      t("export.progress.extractingJiraIssue", { issueKey: metas[i].key }),
    );
    issues.push(await loadJiraIssue(api, metas[i].key, signal));
  }

  p(onProgress, metas.length, metas.length, t("export.progress.buildingArchive"));
  const zipBlob = await bundleJiraSearch(api, issues, signal);
  return { fileName: "jira-search.zip", zipBlob };
}

export async function loadJiraIssue(
  api: JiraApi,
  issueKey: string,
  signal?: AbortSignal,
): Promise<ExtractedJiraIssue> {
  const [meta, description, comments, attachments] = await Promise.all([
    api.getIssue(issueKey, signal),
    fetchJiraDescription(api, issueKey, signal),
    api.getComments(issueKey, signal),
    api.getAttachments(issueKey, signal),
  ]);

  return extractIssueLib(meta, description, comments, attachments);
}

export async function fetchJiraDescription(
  api: JiraApi,
  issueKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const raw = await api.fetchJson<unknown>(
    `/rest/api/2/issue/${encodeURIComponent(issueKey)}?fields=description`,
    signal,
  );
  const fields = getRecord(raw, "fields");
  return jiraText(fields?.description);
}

export async function bundleJiraIssue(
  api: JiraApi,
  issue: ExtractedJiraIssue,
  signal?: AbortSignal,
): Promise<Blob> {
  const { zip, chunks } = createZip();
  const root = safeZipSegment(issue.meta.key) || "jira-issue";

  addStringFile(zip, `${root}/index.md`, issue.markdown);
  addStringFile(zip, `${root}/issue.json`, JSON.stringify(issue.json, null, 2));

  for (const attachment of issue.attachments) {
    await addJiraAttachment(zip, api, `${root}/attachments`, attachment, signal);
  }

  zip.end();
  return chunksToZipBlob(chunks);
}

export async function bundleJiraSearch(
  api: JiraApi,
  issues: ExtractedJiraIssue[],
  signal?: AbortSignal,
): Promise<Blob> {
  const { zip, chunks } = createZip();
  const root = "issues";
  const markdown = issues.map((issue) => issue.markdown).join("\n\n---\n\n");

  addStringFile(zip, `${root}/index.md`, markdown);
  addStringFile(
    zip,
    `${root}/issues.json`,
    JSON.stringify(
      issues.map((issue) => issue.json),
      null,
      2,
    ),
  );
  addStringFile(zip, `${root}/issues.csv`, jiraIssuesToCsv(issues.map((issue) => issue.meta)));

  for (const issue of issues) {
    const folder = `${root}/attachments/${safeZipSegment(issue.meta.key) || "issue"}`;
    for (const attachment of issue.attachments)
      await addJiraAttachment(zip, api, folder, attachment, signal);
  }

  zip.end();
  return chunksToZipBlob(chunks);
}

export async function addJiraAttachment(
  zip: Zip,
  api: JiraApi,
  folder: string,
  attachment: JiraAttachment,
  signal?: AbortSignal,
): Promise<void> {
  if (!attachment.contentUrl) return;

  const blob = await api.fetchBlob(attachment.contentUrl, signal);
  const path = `${folder}/${safeZipSegment(attachment.fileName) || `attachment-${attachment.id}`}`;
  addFile(zip, path, await blobToUint8Array(blob));
}

export function getRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  const child = isRecord(value) ? value[key] : undefined;
  return isRecord(child) ? child : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function jiraText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value, null, 2);
}
