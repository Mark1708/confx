import { inflateSync } from "fflate";

import type {
  ArchivedPlantUmlFile,
  ExportFailure,
  ExtractedPlantUmlAsset,
  PlantUmlExtractionOutcome,
} from "@/types";
import { AssetRegistry, type PageAssetRegistry } from "./export/asset-registry";
import { isAbortError } from "./http-client";

const ALLOWED_HOSTS = new Set(["plantuml.com", "www.plantuml.com"]);
const CANONICAL_HOST = "www.plantuml.com";
const ENCODED_PATTERN = /^[0-9A-Za-z_-]+$/;
const UML_PATH_PATTERN = /^\/plantuml\/uml\/([0-9A-Za-z_-]+)$/;
const MAX_ENCODED_LENGTH = 32_768;
const MAX_DIAGRAMS_PER_PAGE = 20;
const MAX_PROVIDER_ASSET_BYTES = 50 * 1024 * 1024;
const MAX_SOURCE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const LINKED_ASSET_FOLDER = "attachments/linked/plantuml";

export type PlantUmlUrlClassification =
  | {
      kind: "accepted";
      rawHref: string;
      canonicalUrl: string;
      encoded: string;
    }
  | { kind: "unsupported"; rawHref: string }
  | { kind: "ignored"; rawHref: string };

export interface FetchPlantUmlAssetsOptions {
  pageId: string;
  folder?: string;
  assets?: PageAssetRegistry;
  maxAssetBytes: number;
  signal?: AbortSignal;
}

export interface FetchPlantUmlAssetsResult {
  assets: ExtractedPlantUmlAsset[];
  hrefToPng: Map<string, string>;
  outcome: PlantUmlExtractionOutcome;
  failures: ExportFailure[];
}

class PlantUmlFetchError extends Error {
  constructor(readonly status?: number) {
    super("PlantUML PNG fetch failed");
  }
}

export function classifyPlantUmlUrl(href: string): PlantUmlUrlClassification {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { kind: "ignored", rawHref: href };
  }

  if (!ALLOWED_HOSTS.has(url.hostname)) {
    return { kind: "ignored", rawHref: href };
  }

  const isPlantUmlPath = url.pathname.startsWith("/plantuml/");
  if (!isPlantUmlPath) {
    return { kind: "ignored", rawHref: href };
  }

  const pathMatch = url.pathname.match(UML_PATH_PATTERN);
  const encoded = pathMatch?.[1];
  const hasExplicitPort = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?(?:www\.)?plantuml\.com:/i.test(
    href,
  );
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    hasExplicitPort ||
    url.search !== "" ||
    url.hash !== "" ||
    !encoded ||
    encoded.length > MAX_ENCODED_LENGTH ||
    !ENCODED_PATTERN.test(encoded)
  ) {
    return { kind: "unsupported", rawHref: href };
  }

  return {
    kind: "accepted",
    rawHref: href,
    canonicalUrl: `https://${CANONICAL_HOST}/plantuml/uml/${encoded}`,
    encoded,
  };
}

export function decodePlantUmlSource(encoded: string, maxSourceBytes: number): string {
  if (!ENCODED_PATTERN.test(encoded) || encoded.length % 4 === 1) {
    throw new Error("Invalid PlantUML encoding");
  }
  if (!Number.isFinite(maxSourceBytes) || maxSourceBytes <= 0) {
    throw new Error("Invalid PlantUML source size limit");
  }

  const compressed = decodePlantUmlBytes(encoded);
  const limit = Math.floor(maxSourceBytes);
  const inflated = inflateSync(compressed, { out: new Uint8Array(limit + 1) });
  if (inflated.length > limit) {
    throw new Error("PlantUML source exceeds size limit");
  }

  return new TextDecoder("utf-8", { fatal: true }).decode(inflated);
}

export async function fetchPlantUmlAssetsFromHtml(
  html: string,
  options: FetchPlantUmlAssetsOptions,
): Promise<FetchPlantUmlAssetsResult> {
  options.signal?.throwIfAborted();
  const folder = options.folder ?? "";
  const reservations = options.assets ?? new AssetRegistry(false).beginPage(folder);

  const effectiveAssetLimit = normalizeAssetLimit(options.maxAssetBytes);
  const maxSourceBytes = Math.min(effectiveAssetLimit, MAX_SOURCE_BYTES);
  const doc = new DOMParser().parseFromString(html, "text/html");
  const canonicalDiagrams = new Map<string, { encoded: string; rawHrefs: Set<string> }>();
  const unsupportedRawHrefs = new Set<string>();

  for (const anchor of doc.querySelectorAll("a[href]")) {
    const rawHref = anchor.getAttribute("href");
    if (rawHref === null) continue;
    const classification = classifyPlantUmlUrl(rawHref);
    if (classification.kind === "ignored") continue;
    if (classification.kind === "unsupported") {
      unsupportedRawHrefs.add(classification.rawHref);
      continue;
    }

    const existing = canonicalDiagrams.get(classification.canonicalUrl);
    if (existing) {
      existing.rawHrefs.add(classification.rawHref);
    } else {
      canonicalDiagrams.set(classification.canonicalUrl, {
        encoded: classification.encoded,
        rawHrefs: new Set([classification.rawHref]),
      });
    }
  }

  options.signal?.throwIfAborted();

  const assets: ExtractedPlantUmlAsset[] = [];
  const hrefToPng = new Map<string, string>();
  const failures: ExportFailure[] = [];
  const discovered = canonicalDiagrams.size;
  const skippedLimit = Math.max(discovered - MAX_DIAGRAMS_PER_PAGE, 0);
  let failedDownloads = 0;
  let unsupported = 0;

  for (const rawHref of unsupportedRawHrefs) {
    options.signal?.throwIfAborted();
    unsupported += 1;
    failures.push(linkedAssetFailure(options.pageId, "unsupported-link"));
    await warnFailure(rawHref, "unsupported-link");
  }

  if (skippedLimit > 0) {
    failures.push(linkedAssetFailure(options.pageId, "linked-asset-limit"));
  }

  const candidates = Array.from(canonicalDiagrams.entries()).slice(0, MAX_DIAGRAMS_PER_PAGE);
  for (const [canonicalUrl, diagram] of candidates) {
    options.signal?.throwIfAborted();

    const canonicalHash = await sha256Text(canonicalUrl);
    options.signal?.throwIfAborted();

    let source: string;
    try {
      source = decodePlantUmlSource(diagram.encoded, maxSourceBytes);
    } catch {
      unsupported += 1;
      failures.push(linkedAssetFailure(options.pageId, "unsupported-link"));
      warnFailureWithId(canonicalHash, "unsupported-link");
      continue;
    }

    let png: ArchivedPlantUmlFile;
    let sourceFile: ArchivedPlantUmlFile;
    try {
      const pngBytes = await fetchPng(diagram.encoded, effectiveAssetLimit, options.signal);
      options.signal?.throwIfAborted();

      const baseName = `plantuml-${canonicalHash}`;
      png = await makeArchivedFile(
        `${folder ? `${folder}/` : ""}${LINKED_ASSET_FOLDER}/${baseName}.png`,
        `${baseName}.png`,
        "image/png",
        pngBytes,
      );
      options.signal?.throwIfAborted();
      const sourceBytes = new TextEncoder().encode(source);
      sourceFile = await makeArchivedFile(
        `${folder ? `${folder}/` : ""}${LINKED_ASSET_FOLDER}/${baseName}.puml`,
        `${baseName}.puml`,
        "text/plain",
        sourceBytes,
      );
      options.signal?.throwIfAborted();
    } catch (error) {
      options.signal?.throwIfAborted();
      if (isAbortError(error)) throw error;
      failedDownloads += 1;
      const status = error instanceof PlantUmlFetchError ? error.status : undefined;
      failures.push(linkedAssetFailure(options.pageId, "fetch-failed", status));
      warnFailureWithId(canonicalHash, "fetch-failed", status);
      continue;
    }

    const ownershipKey = JSON.stringify(["plantuml", options.pageId, folder, canonicalHash]);
    const pngReservation = reservations.reserve(png.hash, "png", png.archivePath, ownershipKey);
    const sourceReservation = reservations.reserve(
      sourceFile.hash,
      "puml",
      sourceFile.archivePath,
      ownershipKey,
    );
    if (pngReservation.isNew && sourceReservation.isNew) {
      assets.push({
        png: { ...png, archivePath: pngReservation.archivePath },
        source: { ...sourceFile, archivePath: sourceReservation.archivePath },
      });
    } else if (pngReservation.isNew || sourceReservation.isNew) {
      throw new Error("Incomplete PlantUML asset pair reservation");
    }
    for (const rawHref of diagram.rawHrefs) {
      hrefToPng.set(rawHref, pngReservation.archivePath);
    }
  }

  options.signal?.throwIfAborted();

  return {
    assets,
    hrefToPng,
    outcome: {
      discovered,
      archived: assets.length,
      skippedLimit,
      failedDownloads,
      unsupported,
    },
    failures,
  };
}

function decodePlantUmlBytes(encoded: string): Uint8Array {
  const outputLength = Math.floor((encoded.length * 6) / 8);
  const bytes = new Uint8Array(outputLength);
  let outputIndex = 0;

  for (let index = 0; index < encoded.length; index += 4) {
    const first = decode6Bit(encoded[index]);
    const second = decode6Bit(encoded[index + 1]);
    const third = index + 2 < encoded.length ? decode6Bit(encoded[index + 2]) : 0;
    const fourth = index + 3 < encoded.length ? decode6Bit(encoded[index + 3]) : 0;

    bytes[outputIndex++] = (first << 2) | (second >> 4);
    if (outputIndex < outputLength) bytes[outputIndex++] = ((second & 0x0f) << 4) | (third >> 2);
    if (outputIndex < outputLength) bytes[outputIndex++] = ((third & 0x03) << 6) | fourth;
  }

  return bytes;
}

function decode6Bit(char: string): number {
  const code = char.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 90) return code - 65 + 10;
  if (code >= 97 && code <= 122) return code - 97 + 36;
  if (char === "-") return 62;
  if (char === "_") return 63;
  throw new Error("Invalid PlantUML alphabet");
}

function normalizeAssetLimit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return MAX_PROVIDER_ASSET_BYTES;
  return Math.min(Math.floor(value), MAX_PROVIDER_ASSET_BYTES);
}

async function fetchPng(
  encoded: string,
  maxAssetBytes: number,
  callerSignal?: AbortSignal,
): Promise<Uint8Array> {
  callerSignal?.throwIfAborted();
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = (): void => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Timed out", "TimeoutError"));
  }, REQUEST_TIMEOUT_MS);

  let response: Response | undefined;
  try {
    response = await fetch(`https://${CANONICAL_HOST}/plantuml/png/${encoded}`, {
      credentials: "omit",
      redirect: "error",
      headers: { Accept: "image/png" },
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    if (response.redirected || !response.ok) throw new PlantUmlFetchError(response.status);

    const mediaType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "image/png" || !response.body) {
      throw new PlantUmlFetchError(response.status);
    }

    const declaredLength = response.headers.get("Content-Length");
    if (declaredLength !== null) {
      const parsedLength = Number(declaredLength);
      if (Number.isFinite(parsedLength) && parsedLength > maxAssetBytes) {
        throw new PlantUmlFetchError(response.status);
      }
    }

    return await readBoundedBody(response.body, maxAssetBytes, controller.signal, response.status);
  } catch (error) {
    if (response?.body && !response.body.locked) {
      void response.body.cancel().catch(() => undefined);
    }
    callerSignal?.throwIfAborted();
    if (timedOut) throw new PlantUmlFetchError();
    throw error;
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array>,
  maxAssetBytes: number,
  signal: AbortSignal,
  status: number,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  const reader = body.getReader();
  let rejectAborted!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = reject;
  });
  const cancel = (): void => {
    rejectAborted(signal.reason);
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      signal.throwIfAborted();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxAssetBytes) {
        void reader.cancel().catch(() => undefined);
        throw new PlantUmlFetchError(status);
      }
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function makeArchivedFile(
  archivePath: string,
  fileName: string,
  mediaType: string,
  bytes: Uint8Array,
): Promise<ArchivedPlantUmlFile> {
  const ownedBytes = Uint8Array.from(bytes);
  return {
    archivePath,
    fileName,
    mediaType,
    fileSize: ownedBytes.byteLength,
    blob: new Blob([ownedBytes], { type: mediaType }),
    hash: await sha256Bytes(ownedBytes),
  };
}

function linkedAssetFailure(
  pageId: string,
  reason: "unsupported-link" | "linked-asset-limit" | "fetch-failed",
  status?: number,
): ExportFailure {
  return {
    scope: "linked-asset",
    page_id: pageId,
    reason,
    ...(status === undefined ? {} : { status }),
  };
}

async function warnFailure(rawValue: string, reason: ExportFailure["reason"]): Promise<void> {
  warnFailureWithId(await sha256Text(rawValue), reason);
}

function warnFailureWithId(
  fullHash: string,
  reason: ExportFailure["reason"],
  status?: number,
): void {
  console.warn("PlantUML asset failure", {
    id: fullHash.slice(0, 12),
    reason,
    ...(status === undefined ? {} : { status }),
  });
}

async function sha256Text(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const ownedBytes = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest("SHA-256", ownedBytes.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
