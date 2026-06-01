import { useCallback, useEffect, useRef, useState } from "react";
import { createExportJob, type ExportJob } from "@/lib/export-job";
import { clearJobState, loadLastJobState, saveJobState } from "@/lib/export-state";
import type { ExportJobConfig, ExportJobState, ExtensionRequest } from "@/types";
import {
  downloadBlob,
  extractBlock,
  extractJiraIssue,
  extractJiraSearch,
  extractPage,
  extractSpace,
  extractSubtree,
  extractWatchChanged,
  type ProgressEvent,
} from "../extraction";

type ExtractRequest = Extract<
  ExtensionRequest,
  {
    kind:
      | "extract-page"
      | "extract-watch-changed"
      | "extract-subtree"
      | "extract-block"
      | "extract-space"
      | "extract-jira-issue"
      | "extract-jira-search";
  }
>;

export function useExtractJob() {
  const [state, setState] = useState<ExportJobState | null>(null);
  const [restoredState, setRestoredState] = useState<ExportJobState | null>(null);
  const jobRef = useRef<ExportJob | null>(null);

  useEffect(() => {
    let isMounted = true;

    const restoreRunningJob = async (): Promise<void> => {
      try {
        const savedState = await loadLastJobState();
        if (!isMounted || savedState?.status !== "running") return;

        setState(savedState);
        setRestoredState(savedState);
        await clearJobState(savedState.id);
      } catch (_error: unknown) {
        return;
      }
    };

    restoreRunningJob();

    return () => {
      isMounted = false;
    };
  }, []);

  const run = useCallback(async (req: ExtensionRequest) => {
    if (!isExtractRequest(req)) return;

    const config = buildConfig(req);
    const job = createExportJob(config);
    jobRef.current = job;

    job.start();
    setState(job.toState());
    saveJobState(job.toState()).catch(() => undefined);

    const onProgress = (progress: ProgressEvent): void => {
      job.updateProgress(progress.current, progress.total, progress.message);
      setState(job.toState());
      saveJobState(job.toState()).catch(() => undefined);
    };

    try {
      const signal = job.signal;
      const result = await runExtraction(req, onProgress, signal);
      await downloadBlob(result.zipBlob, result.fileName);
      job.complete(result.fileName);
    } catch (error: unknown) {
      if (job.status !== "cancelled") {
        job.fail(getErrorMessage(error));
      }
    } finally {
      setState(job.toState());
      clearJobState(job.id).catch(() => undefined);
      jobRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    const job = jobRef.current;
    if (!job) return;

    job.cancel();
    setState(job.toState());
  }, []);

  const reset = useCallback(() => {
    jobRef.current?.cancel();
    jobRef.current = null;
    setState(null);
    setRestoredState(null);
  }, []);

  return { state, restoredState, run, cancel, reset };
}

function isExtractRequest(req: ExtensionRequest): req is ExtractRequest {
  return (
    req.kind === "extract-page" ||
    req.kind === "extract-watch-changed" ||
    req.kind === "extract-subtree" ||
    req.kind === "extract-block" ||
    req.kind === "extract-space" ||
    req.kind === "extract-jira-issue" ||
    req.kind === "extract-jira-search"
  );
}

function buildConfig(req: ExtractRequest): ExportJobConfig {
  if (req.kind === "extract-page") {
    return { kind: "extract-page", host: req.host, presetId: req.presetId, pageId: req.pageId };
  }

  if (req.kind === "extract-watch-changed") {
    return { kind: "extract-watch-changed", host: req.host, presetId: req.presetId };
  }

  if (req.kind === "extract-subtree") {
    return {
      kind: "extract-subtree",
      host: req.host,
      presetId: req.presetId,
      rootPageId: req.rootPageId,
      maxDepth: req.maxDepth,
    };
  }

  if (req.kind === "extract-block") {
    return {
      kind: "extract-block",
      host: req.pageMeta.baseUrl,
      presetId: req.presetId,
      html: req.html,
      pageMeta: req.pageMeta,
    };
  }

  if (req.kind === "extract-space") {
    return {
      kind: "extract-space",
      host: req.host,
      presetId: req.presetId,
      spaceKey: req.spaceKey,
      spaceOptions: req.options,
      maxDepth: req.maxDepth,
    };
  }

  if (req.kind === "extract-jira-issue") {
    return { kind: "extract-jira-issue", host: req.host, issueKey: req.issueKey };
  }

  if (req.kind === "extract-jira-search") {
    return { kind: "extract-jira-search", host: req.host, jql: req.jql };
  }

  throw new Error("Unknown extraction request kind");
}

async function runExtraction(
  req: ExtractRequest,
  onProgress: (progress: ProgressEvent) => void,
  signal?: AbortSignal,
) {
  if (req.kind === "extract-page") return extractPage(req, onProgress, signal);
  if (req.kind === "extract-watch-changed") return extractWatchChanged(req, onProgress, signal);
  if (req.kind === "extract-subtree") return extractSubtree(req, onProgress, signal);
  if (req.kind === "extract-space") return extractSpace(req, onProgress, signal);
  if (req.kind === "extract-jira-issue") return extractJiraIssue(req, onProgress, signal);
  if (req.kind === "extract-jira-search") return extractJiraSearch(req, onProgress, signal);
  return extractBlock(req, onProgress, signal);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
