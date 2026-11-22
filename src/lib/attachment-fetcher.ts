import {
  ApiError,
  type AttachmentInfo,
  type AttachmentReference,
  type ExportFailure,
  type ExtractedAttachment,
} from "@/types";
import type { ConfluenceApi } from "./confluence-api";
import { AssetRegistry, type PageAssetRegistry } from "./export/asset-registry";
import { isAbortError } from "./http-client";
import { slugify } from "./table-to-csv";

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new Uint8Array(buf));
  return Array.from(new Uint8Array(h))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function stripExt(s: string): string {
  return s.replace(/\.[a-z0-9]{2,5}$/i, "");
}

function extFromMedia(mediaType: string): string | undefined {
  const map: Record<string, string> = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/msword": "doc",
    "application/vnd.ms-excel": "xls",
    "application/vnd.ms-powerpoint": "ppt",
    "application/zip": "zip",
    "text/plain": "txt",
    "text/csv": "csv",
    "application/json": "json",
    "application/xml": "xml",
    "text/html": "html",
  };
  return map[mediaType.toLowerCase()];
}

function extFromName(name: string): string | undefined {
  const m = name.match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : undefined;
}

const IMAGE_MEDIA_PREFIXES = ["image/"];

function isImageType(mediaType: string): boolean {
  return IMAGE_MEDIA_PREFIXES.some((p) => mediaType.toLowerCase().startsWith(p));
}

function attachmentArchivePath(att: AttachmentInfo, folder: string): string {
  const base = slugify(stripExt(att.title)) || slugify(att.id) || "attachment";
  const ext = extFromMedia(att.mediaType) || extFromName(att.title) || "bin";
  return `${folder ? `${folder}/` : ""}${base}.${ext}`;
}

export interface FetchAttachmentsOptions {
  folder: string;
  assets?: PageAssetRegistry;
  ownershipKey?: string;
  maxSize?: number;
  signal?: AbortSignal;
  includeImages?: boolean;
  /** Treat a missing attachment owner (for example, an optional comment) as empty. */
  optionalOwnerNotFound?: boolean;
  /** Owning page for manifest failures when contentId identifies a comment. */
  pageId?: string;
}

export interface FetchAttachmentsResult {
  attachments: ExtractedAttachment[];
  references: AttachmentReference[];
  linkToArchive: Map<string, string>;
  outcome: {
    listed: number;
    eligible: number;
    archived: number;
    skippedSize: number;
    failedDownloads: number;
  };
  failures: ExportFailure[];
}

export async function fetchAttachments(
  contentId: string,
  api: ConfluenceApi,
  options: FetchAttachmentsOptions,
): Promise<FetchAttachmentsResult> {
  const {
    folder,
    assets,
    ownershipKey,
    maxSize,
    signal,
    includeImages = false,
    optionalOwnerNotFound = false,
    pageId = contentId,
  } = options;
  signal?.throwIfAborted();
  const reservations = assets ?? new AssetRegistry(false).beginPage("");

  let attachmentInfos: AttachmentInfo[];
  try {
    attachmentInfos = await api.getAttachments(contentId, signal);
  } catch (error) {
    signal?.throwIfAborted();
    if (isAbortError(error)) throw error;
    if (optionalOwnerNotFound && error instanceof ApiError && error.status === 404) {
      return emptyAttachmentResult();
    }
    if (!signal?.aborted) {
      console.warn("Attachment list fetch failed:", contentId, error);
    }
    return {
      ...emptyAttachmentResult(),
      failures: [
        {
          scope: "attachment",
          page_id: pageId,
          reason: "attachment-list-failed",
          ...statusFields(error),
        },
      ],
    };
  }

  const attachments: ExtractedAttachment[] = [];
  const references: AttachmentReference[] = [];
  const linkToArchive = new Map<string, string>();
  const candidates = includeImages
    ? attachmentInfos
    : attachmentInfos.filter((attachment) => !isImageType(attachment.mediaType));
  let skippedSize = 0;
  let failedDownloads = 0;
  const seen = new Set<string>();
  const failures: ExportFailure[] = [];

  for (const attachment of candidates) {
    signal?.throwIfAborted();
    if (seen.has(attachment.downloadPath)) continue;
    seen.add(attachment.downloadPath);

    const reference = {
      sourceUrl: attachment.downloadPath,
      fileName: attachment.title,
      mediaType: attachment.mediaType,
      fileSize: attachment.fileSize,
    } satisfies AttachmentReference;

    if (maxSize !== undefined && attachment.fileSize > maxSize) {
      skippedSize += 1;

      references.push({
        ...reference,
        skipped: true,
        skipReason: "exceeds size limit",
      });
      continue;
    }

    let blob: Blob;
    let hash: string;
    try {
      blob = await api.fetchBlob(attachment.downloadPath, signal);
      signal?.throwIfAborted();
      const bytes = await blob.arrayBuffer();
      signal?.throwIfAborted();
      hash = await sha256Hex(bytes);
      signal?.throwIfAborted();
    } catch (error) {
      signal?.throwIfAborted();
      if (isAbortError(error)) throw error;
      failedDownloads += 1;
      failures.push({
        scope: "attachment",
        page_id: pageId,
        href: attachment.downloadPath,
        reason: "attachment-download-failed",
        ...statusFields(error),
      });
      // The package manifest keeps the href; console output must stay safe to copy into support logs.
      console.warn("Attachment fetch failed", {
        reason: "attachment-download-failed",
        ...statusFields(error),
      });
      continue;
    }

    const proposed = attachmentArchivePath(attachment, folder);
    const { archivePath, isNew } = reservations.reserve(
      hash,
      extFromName(proposed) ?? "bin",
      proposed,
      ownershipKey,
    );
    const canonicalReference = { ...reference, archivePath };
    references.push(canonicalReference);
    linkToArchive.set(attachment.downloadPath, archivePath);

    if (isNew) attachments.push({ ...canonicalReference, blob, hash });
  }

  signal?.throwIfAborted();
  return {
    attachments,
    references,
    linkToArchive,
    outcome: {
      listed: attachmentInfos.length,
      eligible: candidates.length,
      archived: attachments.length,
      skippedSize,
      failedDownloads,
    },
    failures,
  };
}

function emptyAttachmentResult(): FetchAttachmentsResult {
  return {
    attachments: [],
    references: [],
    linkToArchive: new Map(),
    outcome: {
      listed: 0,
      eligible: 0,
      archived: 0,
      skippedSize: 0,
      failedDownloads: 0,
    },
    failures: [],
  };
}

function statusFields(error: unknown): { status?: number } {
  return error instanceof ApiError ? { status: error.status } : {};
}
