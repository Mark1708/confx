import {
  captureEditorSnapshot,
  EditorBridgeError,
  updateEditorSnapshot,
  type EditorTabTarget,
} from "./browser/editor-bridge";
import type { ConfluenceApi } from "./confluence-api";
import { assertSafeEditorSnapshot } from "./offline-roundtrip/snapshot";
import { storageIdentity, type StorageRoundtripPackage } from "./storage-roundtrip";

export class StorageConversionError extends Error {
  constructor() {
    super(
      "Confluence conversion could not preserve the complete Storage source. Nothing was applied.",
    );
    this.name = "StorageConversionError";
  }
}

/** Apply only to the live editor: conversion requests never save or publish content. */
export async function updateEditorFromStorage(
  target: EditorTabTarget,
  pkg: StorageRoundtripPackage,
  storage: string,
  api: ConfluenceApi,
  options: { signal?: AbortSignal } = {},
): Promise<{ status: "unchanged" | "updated" }> {
  const { signal } = options;
  if (target.host !== api.host || target.pageId !== pkg.snapshot.pageId) {
    throw new EditorBridgeError(
      "wrong-page",
      "The Storage file and API must match the selected page and site.",
    );
  }
  const baselineIdentity = storageIdentity(pkg.snapshot.html);
  const desiredIdentity = storageIdentity(storage);
  if (desiredIdentity === baselineIdentity) return { status: "unchanged" };

  const conflict = () =>
    new EditorBridgeError(
      "conflict",
      "The published page or its open draft changed since export. Nothing was applied.",
    );
  const checkPublished = async (): Promise<void> => {
    signal?.throwIfAborted();
    const page = await api.getPage(target.pageId, ["body.storage", "version"], signal);
    if (
      page.id !== target.pageId ||
      page.type !== "page" ||
      page.status !== "current" ||
      page.version?.number !== pkg.snapshot.version ||
      page.body?.storage?.representation !== "storage" ||
      typeof page.body.storage.value !== "string" ||
      page.body.storage.value !== pkg.snapshot.html
    )
      throw conflict();
  };

  signal?.throwIfAborted();
  await checkPublished();
  // Capture pins the browser document that passed the trusted ISOLATED probe.
  // Every await below keeps using this exact document for the private transfer.
  const captured = await captureEditorSnapshot(target, { signal });
  assertSafeEditorSnapshot(captured.snapshot);
  const liveStorage = await api.convertBody(
    captured.snapshot.html,
    "editor",
    "storage",
    target.pageId,
    signal,
  );
  const liveIdentity = storageIdentity(liveStorage);
  if (liveIdentity === desiredIdentity) return { status: "unchanged" };
  if (liveIdentity !== baselineIdentity) throw conflict();

  const editorHtml = await api.convertBody(storage, "storage", "editor", target.pageId, signal);
  // Server conversion is not a safety or losslessness guarantee, including for plugins.
  try {
    assertSafeEditorSnapshot({ ...captured.snapshot, html: editorHtml });
    const convertedBack = await api.convertBody(
      editorHtml,
      "editor",
      "storage",
      target.pageId,
      signal,
    );
    if (storageIdentity(convertedBack) !== desiredIdentity) throw new StorageConversionError();
  } catch (error) {
    if (error instanceof StorageConversionError) throw error;
    if (signal?.aborted) signal.throwIfAborted();
    // Do not include private page source or conversion response content in the UI.
    throw new StorageConversionError();
  }
  signal?.throwIfAborted();
  await checkPublished();
  signal?.throwIfAborted();
  return updateEditorSnapshot(
    captured.target,
    { expectedHtml: captured.snapshot.html, html: editorHtml },
    { signal },
  );
}
