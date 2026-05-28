import type { AttachmentInfo, ExtractedAttachment } from "@/types";
import type { ConfluenceApi } from "./confluence-api";
import type { ImageDedup } from "./image-fetcher";
import { slugify } from "./table-to-csv";

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", buf);
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

function attachmentZipPath(att: AttachmentInfo, folder: string): string {
  const base = slugify(stripExt(att.title)) || att.id;
  const ext = extFromMedia(att.mediaType) || extFromName(att.title) || "bin";
  return `${folder}/${base}.${ext}`;
}

export async function fetchAttachments(
  pageId: string,
  api: ConfluenceApi,
  folder: string,
  dedup?: ImageDedup,
  maxSize?: number,
  signal?: AbortSignal,
): Promise<{
  attachments: ExtractedAttachment[];
  linkToZip: Map<string, string>;
}> {
  if (signal?.aborted) return { attachments: [], linkToZip: new Map() };

  let attachmentInfos: AttachmentInfo[];
  try {
    attachmentInfos = await api.getAttachments(pageId, signal);
  } catch (e) {
    if (!signal?.aborted) {
      console.warn("Attachment list fetch failed:", pageId, e);
    }
    return { attachments: [], linkToZip: new Map() };
  }

  const attachments: ExtractedAttachment[] = [];
  const linkToZip = new Map<string, string>();
  const nonImageAttachments = attachmentInfos.filter((a) => !isImageType(a.mediaType));
  const seen = new Set<string>();

  for (const att of nonImageAttachments) {
    if (signal?.aborted) break;
    if (seen.has(att.downloadPath)) continue;
    seen.add(att.downloadPath);

    const zipPath = attachmentZipPath(att, folder);

    if (maxSize !== undefined && att.fileSize > maxSize) {
      attachments.push({
        sourceUrl: att.downloadPath,
        zipPath,
        blob: new Blob(),
        hash: "",
        fileName: att.title,
        mediaType: att.mediaType,
        fileSize: att.fileSize,
        skipped: true,
        skipReason: "exceeds size limit",
      });
      linkToZip.set(att.downloadPath, zipPath);
      continue;
    }

    try {
      const blob = await api.fetchBlob(att.downloadPath, signal);
      const buf = await blob.arrayBuffer();
      const hash = await sha256Hex(buf);

      if (dedup) {
        const reused = dedup.register(hash, zipPath);
        if (reused !== zipPath) {
          linkToZip.set(att.downloadPath, reused);
          continue;
        }
      }

      attachments.push({
        sourceUrl: att.downloadPath,
        zipPath,
        blob,
        hash,
        fileName: att.title,
        mediaType: att.mediaType,
        fileSize: att.fileSize,
      });
      linkToZip.set(att.downloadPath, zipPath);
    } catch (e) {
      console.warn("Attachment fetch failed:", att.title, e);
    }
  }

  return { attachments, linkToZip };
}
