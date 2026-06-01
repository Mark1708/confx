import { strToU8, Zip, ZipDeflate } from "fflate";
import type { ExtractedPage } from "@/types";

export interface BundleOptions {
  rootName: string;
  readme?: string;
  manifestJson?: string;
  extraTextFiles?: Record<string, string>;
}

const ZIP_MIME_TYPE = "application/zip";
const DEFLATE_LEVEL = 6;

function createZip(): { zip: Zip; chunks: Uint8Array[] } {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((err, data) => {
    if (err) throw err;
    chunks.push(data);
  });

  return { zip, chunks };
}

function addFile(zip: Zip, path: string, data: Uint8Array): void {
  const file = new ZipDeflate(path, { level: DEFLATE_LEVEL });
  zip.add(file);
  file.push(data, true);
}

function addStringFile(zip: Zip, path: string, content: string): void {
  addFile(zip, path, strToU8(content));
}

function getZipPath(rootName: string, path: string): string {
  return `${rootName}/${path}`;
}

async function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const archive = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.length;
  }

  return archive;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export async function bundleExtractedPages(
  pages: ExtractedPage[],
  opts: BundleOptions,
): Promise<Blob> {
  const { zip, chunks } = createZip();

  if (opts.readme) addStringFile(zip, getZipPath(opts.rootName, "README.md"), opts.readme);
  if (opts.manifestJson)
    addStringFile(zip, getZipPath(opts.rootName, "manifest.json"), opts.manifestJson);
  for (const [path, content] of Object.entries(opts.extraTextFiles ?? {})) {
    addStringFile(zip, getZipPath(opts.rootName, path), content);
  }

  const seenBinaryHashes = new Set<string>();

  for (const page of pages) {
    const pagePrefix = page.folder ? `${page.folder}/` : "";
    addStringFile(zip, getZipPath(opts.rootName, `${pagePrefix}index.md`), page.markdown);

    if (page.tables.length) {
      for (const t of page.tables) {
        addStringFile(zip, getZipPath(opts.rootName, `${pagePrefix}tables/${t.name}`), t.csv);
      }
    }

    if (page.images.length) {
      for (const img of page.images) {
        if (seenBinaryHashes.has(img.hash)) continue;
        seenBinaryHashes.add(img.hash);
        // zipPath is relative to page folder
        const path = `${pagePrefix}${img.zipPath}`;
        addFile(zip, getZipPath(opts.rootName, path), await blobToUint8Array(img.blob));
      }
    }

    if (page.attachments.length) {
      for (const att of page.attachments) {
        if (att.skipped) continue;
        if (seenBinaryHashes.has(att.hash)) continue;
        seenBinaryHashes.add(att.hash);
        const path = `${pagePrefix}${att.zipPath}`;
        addFile(zip, getZipPath(opts.rootName, path), await blobToUint8Array(att.blob));
      }
    }

    if (page.comments.length > 0) {
      const commentsJson = JSON.stringify(
        page.comments.map((c) => ({
          id: c.id,
          author: c.author,
          createdAt: c.createdAt,
          body: c.markdown,
        })),
        null,
        2,
      );
      addStringFile(zip, getZipPath(opts.rootName, `${pagePrefix}comments.json`), commentsJson);
    }

    if (page.history.length > 0) {
      const historyJson = JSON.stringify(page.history, null, 2);
      addStringFile(zip, getZipPath(opts.rootName, `${pagePrefix}history.json`), historyJson);
    }
  }

  zip.end();
  const archive = concatChunks(chunks);
  return new Blob([toArrayBuffer(archive)], { type: ZIP_MIME_TYPE });
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBlob(b64: string, mime = "application/zip"): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
