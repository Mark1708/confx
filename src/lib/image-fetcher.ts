import type { ExtractedImage } from "@/types";
import type { ConfluenceApi } from "./confluence-api";
import { slugify } from "./table-to-csv";

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", buf);
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

export class ImageDedup {
  private byHash = new Map<string, string>();

  register(hash: string, zipPath: string): string {
    const existing = this.byHash.get(hash);
    if (existing) return existing;
    this.byHash.set(hash, zipPath);
    return zipPath;
  }
}

export async function fetchImagesFromHtml(
  html: string,
  api: ConfluenceApi,
  folder: string,
  dedup?: ImageDedup,
  signal?: AbortSignal,
): Promise<{ images: ExtractedImage[]; srcToZip: Map<string, string> }> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const imgs = Array.from(doc.querySelectorAll("img")) as HTMLImageElement[];
  const images: ExtractedImage[] = [];
  const srcToZip = new Map<string, string>();
  const seen = new Set<string>();

  for (const img of imgs) {
    if (signal?.aborted) break;

    const origSrc = img.getAttribute("data-image-src") || img.getAttribute("src") || "";
    if (!origSrc || seen.has(origSrc)) continue;
    seen.add(origSrc);

    // Skip data URIs — they already are inline
    if (origSrc.startsWith("data:")) {
      srcToZip.set(origSrc, origSrc);
      continue;
    }

    try {
      const blob = await api.fetchBlob(origSrc, signal);
      const buf = await blob.arrayBuffer();
      const hash = await sha256Hex(buf);

      const alias =
        img.getAttribute("data-linked-resource-default-alias") ||
        extractFilenameFromPath(origSrc) ||
        "image";
      const ext = guessExt(blob.type, alias);
      const base = slugify(stripExt(alias)) || `img-${hash.slice(0, 8)}`;
      const zipPath = `${folder}/${base}.${ext}`;

      if (dedup) {
        const reused = dedup.register(hash, zipPath);
        if (reused !== zipPath) {
          srcToZip.set(origSrc, reused);
          continue;
        }
      }

      images.push({ sourceUrl: origSrc, zipPath, blob, hash });
      srcToZip.set(origSrc, zipPath);
    } catch (e) {
      console.warn("Image fetch failed:", origSrc, e);
    }
  }

  return { images, srcToZip };
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
