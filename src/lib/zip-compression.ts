import { Zip, ZipDeflate, ZipPassThrough } from "fflate";

export const DEFLATE_LEVEL = 6;

// File formats already compressed internally. Re-deflating them wastes CPU and
// blocks the main thread for ~0% size reduction, and the long synchronous
// deflate over a large pre-compressed file is the most likely trigger for
// environment-dependent archive corruption (observed as an invalid deflate
// stream in produced archives). These are stored uncompressed instead.
const STORE_EXTENSIONS = new Set<string>([
  // raster / vector images (internal codecs)
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "heic",
  "tiff",
  // Office Open XML / OpenDocument (ZIP containers)
  "docx",
  "xlsx",
  "pptx",
  "odt",
  "ods",
  "odp",
  // archives
  "zip",
  "gz",
  "bz2",
  "7z",
  "rar",
  "zst",
  "xz",
  // audio / video (internal codecs)
  "mp3",
  "mp4",
  "mov",
  "avi",
  "mkv",
  "webm",
  "ogg",
  "flac",
  // PDF (internal deflate streams)
  "pdf",
  // zip-based app packages
  "jar",
  "war",
  "apk",
  "ipa",
  "epub",
]);

function extOf(path: string): string {
  const match = path.toLowerCase().match(/\.([a-z0-9]{2,5})$/);
  return match ? match[1] : "";
}

export function isPrecompressedPath(path: string): boolean {
  return STORE_EXTENSIONS.has(extOf(path));
}

// Adds a file to the archive, picking DEFLATE for compressible content and
// STORE (no compression) for already-compressed binary formats.
export function addZipEntry(zip: Zip, path: string, data: Uint8Array): void {
  const file = isPrecompressedPath(path)
    ? new ZipPassThrough(path)
    : new ZipDeflate(path, { level: DEFLATE_LEVEL });
  zip.add(file);
  file.push(data, true);
}
