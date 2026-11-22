import { ApiError, type ExportFailure, type ExtractedImage } from "@/types";
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

export function extractImageUrl(img: HTMLImageElement): string {
  const dataSrc = img.getAttribute("data-image-src");
  if (dataSrc) return dataSrc;
  return img.getAttribute("src") ?? "";
}

export function guessExt(mediaType: string | undefined, fallbackUrl: string): string {
  if (mediaType) {
    if (/png/i.test(mediaType)) return "png";
    if (/jpe?g/i.test(mediaType)) return "jpg";
    if (/gif/i.test(mediaType)) return "gif";
    if (/svg/i.test(mediaType)) return "svg";
    if (/webp/i.test(mediaType)) return "webp";
  }
  const m = fallbackUrl.match(/\.([a-z0-9]{2,5})(?:\?|$)/i);
  return m ? m[1].toLowerCase() : "bin";
}

export async function fetchImagesFromHtml(
  html: string,
  api: ConfluenceApi,
  folder: string,
  assets?: PageAssetRegistry,
  signal?: AbortSignal,
  pageId?: string,
): Promise<{
  images: ExtractedImage[];
  srcToArchive: Map<string, string>;
  failures: ExportFailure[];
}> {
  signal?.throwIfAborted();
  const reservations = assets ?? new AssetRegistry(false).beginPage("");
  const doc = new DOMParser().parseFromString(html, "text/html");
  const imgs = Array.from(doc.querySelectorAll("img")) as HTMLImageElement[];
  const images: ExtractedImage[] = [];
  const srcToArchive = new Map<string, string>();
  const failures: ExportFailure[] = [];
  const seen = new Set<string>();

  for (const img of imgs) {
    signal?.throwIfAborted();
    const origSrc = extractImageUrl(img);
    if (!origSrc || seen.has(origSrc)) continue;
    seen.add(origSrc);
    // Inline data is already self-contained, not a physical archive entry.
    if (/^data:/i.test(origSrc)) continue;

    let blob: Blob;
    let hash: string;
    try {
      blob = await api.fetchBlob(origSrc, signal);
      signal?.throwIfAborted();
      const buf = await blob.arrayBuffer();
      signal?.throwIfAborted();
      hash = await sha256Hex(buf);
      signal?.throwIfAborted();
    } catch (error) {
      signal?.throwIfAborted();
      if (isAbortError(error)) throw error;
      failures.push({
        scope: "attachment",
        ...(pageId === undefined ? {} : { page_id: pageId }),
        href: origSrc,
        reason: "fetch-failed",
        ...(error instanceof ApiError ? { status: error.status } : {}),
      });
      // Signed URLs and page-owned names stay in the package manifest, never in copied console logs.
      console.warn("Image fetch failed", {
        reason: "fetch-failed",
        ...(error instanceof ApiError ? { status: error.status } : {}),
      });
      continue;
    }

    const alias =
      img.getAttribute("data-linked-resource-default-alias") ||
      extractFilenameFromPath(origSrc) ||
      "image";
    const ext = guessExt(blob.type, alias);
    const base = slugify(stripExt(alias)) || `img-${hash.slice(0, 8)}`;
    const { archivePath, isNew } = reservations.reserve(
      hash,
      ext,
      `${folder ? `${folder}/` : ""}${base}.${ext}`,
    );
    if (isNew) images.push({ sourceUrl: origSrc, archivePath, blob, hash });
    srcToArchive.set(origSrc, archivePath);
  }

  signal?.throwIfAborted();
  return { images, srcToArchive, failures };
}

function stripExt(s: string): string {
  return s.replace(/\.[a-z0-9]{2,5}$/i, "");
}

function extractFilenameFromPath(path: string): string | null {
  const m = path.match(/\/([^/?#]+?)(?:\?|$)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}
