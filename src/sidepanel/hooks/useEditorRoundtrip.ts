import { useEffect, useRef, useState } from "react";
import { BrowserApi } from "@/lib/browser/browser-api";
import {
  captureEditorSnapshot,
  EditorBridgeError,
  updateEditorSnapshot,
  type EditorTabTarget,
} from "@/lib/browser/editor-bridge";
import {
  createEditorMarkdown,
  MAX_EDITABLE_MARKDOWN_BYTES,
  readEditorMarkdown,
  type EditorMarkdownTarget,
} from "@/lib/editor-markdown";
import {
  applyRoundtripMarkdown,
  type RoundtripPackage,
  type RoundtripResult,
} from "@/lib/offline-roundtrip";
import { createConfluenceApi, toFetchOptions } from "@/lib/create-api";
import { loadSettings } from "@/lib/settings";
import { resolveSourceBase } from "@/lib/source-context";
import { StorageConversionError, updateEditorFromStorage } from "@/lib/storage-editor";
import {
  applyStorageMarkdown,
  readStorageMarkdown,
  type StorageRoundtripPackage,
} from "@/lib/storage-roundtrip";
import { safeZipSegment } from "@/lib/export/paths";
import type { CurrentTabInfo } from "./useCurrentTab";
import { useI18n } from "./useI18n";

export type LoadedEdit = {
  fileName: string;
  target: EditorMarkdownTarget;
  result: RoundtripResult;
} & (
  | { kind: "editor"; package: RoundtripPackage }
  | { kind: "storage"; package: StorageRoundtripPackage }
);

type Operation = "exporting" | "loading" | "applying";
type Notice = "exported" | "unchanged" | "updated";

export function useEditorRoundtrip(tab: CurrentTabInfo) {
  const { t } = useI18n();
  const [edit, setEdit] = useState<LoadedEdit | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);
  const applying = useRef(false);
  const applyAbort = useRef<AbortController | null>(null);
  const target: EditorTabTarget | null =
    typeof tab.tabId === "number" && tab.host && tab.pageId && tab.accessState === "available"
      ? { tabId: tab.tabId, host: tab.host, pageId: tab.pageId }
      : null;
  const matches = Boolean(
    target && edit && target.host === edit.target.host && target.pageId === edit.target.pageId,
  );

  useEffect(
    () => () => {
      revision.current += 1;
      applyAbort.current?.abort();
      applyAbort.current = null;
    },
    [],
  );

  function describeError(value: unknown): string {
    if (value instanceof StorageConversionError) return t("editorRoundtrip.conversionLoss");
    if (value instanceof EditorBridgeError) {
      switch (value.code) {
        case "editor-not-open":
          return t("editorRoundtrip.openEditor");
        case "wrong-page":
          return t("editorRoundtrip.wrongPage");
        case "conflict":
          return t("editorRoundtrip.conflict");
        case "editor-unavailable":
          return t("editorRoundtrip.unavailable");
        case "update-failed":
          return t("editorRoundtrip.failed");
      }
    }
    return value instanceof Error ? value.message : String(value);
  }

  async function exportMarkdown() {
    if (!target || operation || applying.current) return;
    const token = ++revision.current;
    setOperation("exporting");
    setNotice(null);
    setError(null);
    let url: string | undefined;
    try {
      const capture = await captureEditorSnapshot(target);
      const markdown = await createEditorMarkdown(capture.snapshot, target);
      if (token !== revision.current) return;
      url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
      await BrowserApi.download({
        url,
        filename: `${safeZipSegment(capture.snapshot.title) || target.pageId}.editable.md`,
        saveAs: true,
      });
      if (token === revision.current) setNotice("exported");
    } catch (value) {
      if (token === revision.current) setError(describeError(value));
    } finally {
      if (url) URL.revokeObjectURL(url);
      if (token === revision.current) setOperation(null);
    }
  }

  async function loadMarkdown(file: File) {
    if (applying.current) return;
    const token = ++revision.current;
    setEdit(null);
    setOperation("loading");
    setNotice(null);
    setError(null);
    try {
      if (file.size > MAX_EDITABLE_MARKDOWN_BYTES) throw new Error(t("editorRoundtrip.tooLarge"));
      const bytes = await file.arrayBuffer();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const end = text.trimEnd();
      const lastLine = end.slice(end.lastIndexOf("\n") + 1).trimStart();
      let loaded: LoadedEdit;
      if (lastLine.startsWith("<!-- confx:storage-markdown ")) {
        const document = await readStorageMarkdown(text);
        const result = await applyStorageMarkdown(document.package, document.markdown);
        loaded = {
          kind: "storage",
          fileName: file.name,
          target: document.target,
          package: document.package,
          result,
        };
      } else {
        const document = await readEditorMarkdown(text);
        const result = await applyRoundtripMarkdown(document.package, document.markdown);
        loaded = {
          kind: "editor",
          fileName: file.name,
          target: document.target,
          package: document.package,
          result,
        };
      }
      const { result } = loaded;
      if (token !== revision.current) return;
      if (result.status === "blocked") {
        throw new Error(
          `${t("editorRoundtrip.unsupported")} ${result.issues.map((issue) => issue.message).join(" ")}`,
        );
      }
      setEdit(loaded);
      if (result.status === "unchanged") setNotice("unchanged");
    } catch (value) {
      if (token === revision.current) setError(describeError(value));
    } finally {
      if (token === revision.current) setOperation(null);
    }
  }

  async function apply() {
    if (
      !target ||
      !edit ||
      !matches ||
      edit.result.status !== "ready" ||
      edit.result.html === undefined ||
      operation ||
      applying.current
    )
      return;
    applying.current = true;
    const controller = new AbortController();
    applyAbort.current = controller;
    const token = ++revision.current;
    setOperation("applying");
    setError(null);
    setNotice(null);
    try {
      let result: { status: "unchanged" | "updated" };
      if (edit.kind === "storage") {
        const settings = await loadSettings();
        const { baseUrl } = resolveSourceBase(
          tab.url ?? target.host,
          target.host,
          settings.confluenceBaseUrl,
        );
        const api = createConfluenceApi(baseUrl, toFetchOptions(settings));
        result = await updateEditorFromStorage(target, edit.package, edit.result.html, api, {
          signal: controller.signal,
        });
      } else {
        result = await updateEditorSnapshot(
          target,
          {
            expectedHtml: edit.package.snapshot.html,
            html: edit.result.html,
          },
          { signal: controller.signal },
        );
      }
      if (token !== revision.current) return;
      setEdit({ ...edit, result: { ...edit.result, status: "unchanged" } });
      setNotice(result.status === "updated" ? "updated" : "unchanged");
    } catch (value) {
      if (token === revision.current) {
        setEdit(null);
        setError(describeError(value));
      }
    } finally {
      applying.current = false;
      if (applyAbort.current === controller) applyAbort.current = null;
      if (token === revision.current) setOperation(null);
    }
  }

  return {
    edit,
    operation,
    notice,
    error: error ?? (target && edit && !matches ? t("editorRoundtrip.wrongPage") : null),
    available: Boolean(target),
    canApply: matches && edit?.result.status === "ready" && operation === null,
    exportMarkdown,
    loadMarkdown,
    apply,
  };
}
