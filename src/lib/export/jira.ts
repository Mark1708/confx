import { createTranslator } from "@/i18n";
import { createJiraApi } from "@/lib/create-api";
import { isAbortError } from "@/lib/http-client";
import { allWithSiblingAbort } from "@/lib/parallel-batch";
import type { JiraApi } from "@/lib/jira-api";
import { extractJiraIssue, jiraIssuesToCsv } from "@/lib/jira-extractor";
import type { ExtractedJiraIssue, JiraIssueMeta } from "@/types";
import { AssetRegistry, type PageAssetRegistry } from "./asset-registry";
import type {
  EmitEntry,
  ExportContext,
  ExportOutcome,
  ExportPackageInfo,
  ExportSummary,
  PreparedExport,
} from "./contracts";
import { csvIndexMarkdown } from "./package-writer";
import { safeZipSegment } from "./paths";
import { effectivePackage } from "./prepare";
import { outcomeCounts, p } from "./progress";

/** Aggregate text/JSON may accumulate; each binary is written before reading the next issue. */
export async function produceJiraExport(
  prepared: PreparedExport,
  context: ExportContext,
  emit: EmitEntry,
): Promise<ExportSummary> {
  const request = prepared.request;
  if (request.kind !== "extract-jira-issue" && request.kind !== "extract-jira-search") {
    throw new Error(`Unsupported Jira export request: ${request.kind}`);
  }
  const { signal, onProgress } = context;
  signal.throwIfAborted();
  const t = createTranslator(prepared.locale);
  const api = createJiraApi(prepared.source.baseUrl, prepared.network);
  const search = request.kind === "extract-jira-search";
  p(
    onProgress,
    0,
    1,
    t(search ? "export.progress.searchingJiraIssues" : "export.progress.fetchingJiraIssue"),
    {
      phase: search ? "discovering" : "reading",
      counts: { processed: 0, total: search ? null : 1 },
    },
  );
  // Keep the established one-request/50-result search cap, not a new pagination contract.
  const keys =
    request.kind === "extract-jira-search"
      ? (await api.searchIssues(request.jql, 50, signal)).map((meta) => meta.key)
      : [request.issueKey];
  signal.throwIfAborted();
  let packageInfo: ExportPackageInfo | undefined = search
    ? { rootName: "issues", fileName: "jira-search.zip" }
    : undefined;
  if (packageInfo) context.onPackage(packageInfo);
  const registry = new AssetRegistry(prepared.defaults.conversion.deduplicateAssets);
  registry.protectPage("");
  const outcome: ExportOutcome = {
    partial: false,
    successfulPages: 0,
    failedPages: 0,
    successfulResources: 0,
    failedResources: 0,
    entriesWritten: 0,
  };
  const write: EmitEntry = async (entry) => {
    signal.throwIfAborted();
    await emit(entry);
    outcome.entriesWritten! += 1;
    signal.throwIfAborted();
  };
  const metadata: JiraIssueMeta[] = [];
  const markdown: string[] = [];
  const json: Record<string, unknown>[] = [];
  const tablesOnly = prepared.defaults.presetId === "tables-only";

  for (const [index, key] of keys.entries()) {
    signal.throwIfAborted();
    if (search) {
      p(
        onProgress,
        index,
        keys.length,
        t("export.progress.extractingJiraIssue", { issueKey: key }),
        {
          phase: "reading",
          counts: { processed: index, total: keys.length, ...outcomeCounts(outcome) },
        },
      );
    }
    const loaded = await loadJiraIssue(api, key, prepared, signal);
    signal.throwIfAborted();
    if (!packageInfo) {
      const rootName = safeZipSegment(loaded.issue.meta.key) || "jira-issue";
      packageInfo = { rootName, fileName: `${rootName}.zip` };
      context.onPackage(packageInfo);
    }
    p(onProgress, index, keys.length, t("export.progress.buildingArchive"), {
      phase: "writing",
      counts: { processed: index, total: keys.length, ...outcomeCounts(outcome) },
    });
    const assets = registry.beginPage("");
    try {
      if (!search) {
        if (tablesOnly) {
          await write({ path: "issue.csv", body: jiraIssuesToCsv([loaded.issue.meta]) });
          await write({
            path: "index.md",
            body: csvIndexMarkdown(`${loaded.issue.meta.key} — ${loaded.issue.meta.summary}`, [
              "issue.csv",
            ]),
          });
        } else {
          await write({ path: "index.md", body: loaded.issue.markdown });
          await write({ path: "issue.json", body: JSON.stringify(loaded.issue.json, null, 2) });
        }
      }
      const resources = await writeJiraAttachments(
        api,
        loaded.issue,
        search ? `attachments/${safeZipSegment(key) || "issue"}` : "attachments",
        prepared,
        assets,
        write,
        signal,
      );
      signal.throwIfAborted();
      assets.commit();
      outcome.successfulResources! += resources.written;
      outcome.partial ||= loaded.partial || resources.failed > 0;
      if (loaded.failedResources === null) outcome.failedResources = null;
      else if (outcome.failedResources !== null) {
        outcome.failedResources += loaded.failedResources + resources.failed;
      }
    } catch (error) {
      assets.discard();
      throw error;
    }
    outcome.successfulPages += 1;
    if (search) {
      metadata.push(loaded.issue.meta);
      if (!tablesOnly) {
        markdown.push(loaded.issue.markdown);
        json.push(loaded.issue.json);
      }
    }
    p(onProgress, index + 1, keys.length, t("export.progress.buildingArchive"), {
      phase: "writing",
      counts: { processed: index + 1, total: keys.length, ...outcomeCounts(outcome) },
    });
  }
  if (search) {
    if (!tablesOnly) {
      await write({ path: "index.md", body: markdown.join("\n\n---\n\n") });
      await write({ path: "issues.json", body: JSON.stringify(json, null, 2) });
    }
    await write({ path: "issues.csv", body: jiraIssuesToCsv(metadata) });
    if (tablesOnly) {
      await write({ path: "index.md", body: csvIndexMarkdown("Jira issues", ["issues.csv"]) });
    }
  }
  signal.throwIfAborted();
  p(onProgress, keys.length, keys.length, t("export.progress.buildingArchive"), {
    phase: "finalizing",
    counts: { processed: keys.length, total: keys.length, ...outcomeCounts(outcome) },
  });
  if (!packageInfo) throw new Error("Export package metadata is unavailable");
  return { ...packageInfo, outcome };
}

async function loadJiraIssue(
  api: JiraApi,
  issueKey: string,
  prepared: PreparedExport,
  signal: AbortSignal,
): Promise<{ issue: ExtractedJiraIssue; partial: boolean; failedResources: number | null }> {
  const policy = effectivePackage(prepared);
  // One fatal read cancels its in-flight siblings; the batch still settles
  // (cleanup tails included) before the original failure propagates.
  const [meta, description, comments, resources] = await allWithSiblingAbort(signal, [
    (read) => api.getIssue(issueKey, read),
    (read) =>
      prepared.defaults.presetId === "tables-only"
        ? Promise.resolve("")
        : fetchJiraDescription(api, issueKey, read),
    (read) => (policy.comments ? api.getComments(issueKey, read) : Promise.resolve([])),
    (read) =>
      policy.attachments
        ? api.getAttachments(issueKey, read).then(
            (attachments) => ({ attachments, failed: false }),
            (error: unknown) => {
              if (read.aborted || isAbortError(error)) throw error;
              return { attachments: [], failed: true };
            },
          )
        : Promise.resolve({ attachments: [], failed: false }),
  ]);
  signal.throwIfAborted();
  const eligible = resources.attachments.filter(
    (attachment) => attachment.fileSize <= prepared.maxAttachmentSize,
  );
  const issue = extractJiraIssue(meta, description, comments, eligible);
  if (!prepared.defaults.conversion.includeFrontMatter) {
    const end = issue.markdown.indexOf("\n---\n");
    issue.markdown = issue.markdown.slice(end + "\n---\n".length).trimStart();
  }
  return {
    issue,
    partial:
      resources.failed ||
      resources.attachments.some(
        (attachment) => attachment.fileSize > prepared.maxAttachmentSize || !attachment.contentUrl,
      ),
    failedResources: resources.failed
      ? null
      : eligible.filter((attachment) => !attachment.contentUrl).length,
  };
}

async function fetchJiraDescription(
  api: JiraApi,
  issueKey: string,
  signal: AbortSignal,
): Promise<string> {
  const raw = await api.fetchJson<unknown>(
    `/rest/api/2/issue/${encodeURIComponent(issueKey)}?fields=description`,
    signal,
  );
  const fields = getRecord(raw, "fields");
  const description = fields?.description;
  if (typeof description === "string") return description;
  return description === null || description === undefined
    ? ""
    : JSON.stringify(description, null, 2);
}

async function writeJiraAttachments(
  api: JiraApi,
  issue: ExtractedJiraIssue,
  folder: string,
  prepared: PreparedExport,
  assets: PageAssetRegistry,
  emit: EmitEntry,
  signal: AbortSignal,
): Promise<{ written: number; failed: number }> {
  let written = 0;
  let failed = 0;
  for (const attachment of issue.attachments) {
    signal.throwIfAborted();
    if (!attachment.contentUrl) continue;
    let blob: Blob;
    try {
      blob = await api.fetchBlob(attachment.contentUrl, signal);
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error;
      failed += 1;
      continue;
    }
    signal.throwIfAborted();
    const fileName = safeZipSegment(attachment.fileName) || `attachment-${attachment.id}`;
    const hash = prepared.defaults.conversion.deduplicateAssets
      ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())))
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("")
      : attachment.id;
    signal.throwIfAborted();
    const reserved = assets.reserve(
      hash,
      fileName.match(/\.([^.]+)$/)?.[1].toLowerCase() ?? "",
      `${folder}/${fileName}`,
    );
    if (reserved.isNew) {
      await emit({ path: reserved.archivePath, body: blob });
      written += 1;
    }
    signal.throwIfAborted();
  }
  return { written, failed };
}

function getRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const child = (value as Record<string, unknown>)[key];
  return typeof child === "object" && child !== null
    ? (child as Record<string, unknown>)
    : undefined;
}
