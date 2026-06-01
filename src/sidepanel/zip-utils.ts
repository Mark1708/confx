import { strToU8, Zip, ZipDeflate } from "fflate";

export const ZIP_MIME_TYPE = "application/zip";
export const DEFLATE_LEVEL = 6;

export function createZip(): { zip: Zip; chunks: Uint8Array[] } {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((err, data) => {
    if (err) throw err;
    chunks.push(data);
  });

  return { zip, chunks };
}

export function addFile(zip: Zip, path: string, data: Uint8Array): void {
  const file = new ZipDeflate(path, { level: DEFLATE_LEVEL });
  zip.add(file);
  file.push(data, true);
}

export function addStringFile(zip: Zip, path: string, content: string): void {
  addFile(zip, path, strToU8(content));
}

export async function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

export function chunksToZipBlob(chunks: Uint8Array[]): Blob {
  const archive = concatChunks(chunks);
  return new Blob([toArrayBuffer(archive)], { type: ZIP_MIME_TYPE });
}

export function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const archive = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.length;
  }

  return archive;
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export function safeZipSegment(value: string): string {
  const sanitized = Array.from(value)
    .map((char) => (isUnsafeZipChar(char) ? "-" : char))
    .join("")
    .replace(/^\.+$/, "")
    .trim();
  return sanitized;
}

export function isUnsafeZipChar(char: string): boolean {
  return char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char);
}
