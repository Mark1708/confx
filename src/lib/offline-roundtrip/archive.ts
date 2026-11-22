import { strToU8, Unzip, UnzipInflate, zipSync } from "fflate";
import {
  MAX_ROUNDTRIP_TEXT_BYTES,
  ROUNDTRIP_FORMAT,
  type EditorSnapshot,
  type RoundtripBlock,
  type RoundtripPackage,
} from "./contracts";
import { createRoundtripPackage } from "./roundtrip";
import { assertSafeEditorSnapshot } from "./snapshot";

const ARCHIVE_MEMBERS = [
  "index.md",
  "manifest.json",
  ".confx/source.html",
  ".confx/baseline.md",
  ".confx/mapping.json",
] as const;
const MAX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = MAX_UNCOMPRESSED_BYTES + 64 * 1024;
const INFLATE_INPUT_CHUNK_BYTES = 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[index] = value >>> 0;
}

interface ZipMember {
  name: string;
  flags: number;
  compression: number;
  compressedSize: number;
  originalSize: number;
  crc: number;
  localOffset: number;
}

function encodeText(text: string, name: string): Uint8Array {
  if (typeof text !== "string") throw new Error(`${name} must contain text`);
  if (text.length > MAX_ROUNDTRIP_TEXT_BYTES) {
    throw new Error(`${name} exceeds the 5 MiB UTF-8 text limit`);
  }
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) {
    throw new Error(`${name} contains non-lossless Unicode`);
  }
  const bytes = strToU8(text);
  if (bytes.length > MAX_ROUNDTRIP_TEXT_BYTES) {
    throw new Error(`${name} exceeds the 5 MiB UTF-8 text limit`);
  }
  return bytes;
}

/** Create the fixed, self-contained offline package; index.md may contain local edits. */
export function writeRoundtripArchive(
  pkg: RoundtripPackage,
  markdown = pkg.baselineMarkdown,
): Uint8Array {
  if (pkg.format !== "confx-roundtrip/1" && pkg.format !== ROUNDTRIP_FORMAT)
    throw new Error("Unsupported roundtrip archive format version");
  assertSafeEditorSnapshot(pkg.snapshot);
  if (typeof pkg.sourceHash !== "string" || !/^[a-f\d]{64}$/.test(pkg.sourceHash)) {
    throw new Error("Invalid roundtrip source hash");
  }
  if (!Array.isArray(pkg.blocks)) throw new Error("Invalid roundtrip mapping blocks");
  const { representation, title, pageId, capturedAt } = pkg.snapshot;
  const manifest = {
    format: pkg.format,
    snapshot: {
      representation,
      title,
      ...(pageId !== undefined ? { pageId } : {}),
      ...(capturedAt !== undefined ? { capturedAt } : {}),
    },
    sourceHash: pkg.sourceHash,
  };
  const files: Record<string, Uint8Array> = {
    "index.md": encodeText(markdown, "index.md"),
    "manifest.json": encodeText(JSON.stringify(manifest, null, 2), "manifest.json"),
    ".confx/source.html": encodeText(pkg.snapshot.html, ".confx/source.html"),
    ".confx/baseline.md": encodeText(pkg.baselineMarkdown, ".confx/baseline.md"),
    ".confx/mapping.json": encodeText(JSON.stringify(pkg.blocks, null, 2), ".confx/mapping.json"),
  };
  if (Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0) > MAX_UNCOMPRESSED_BYTES) {
    throw new Error("Roundtrip archive exceeds the total 20 MiB uncompressed budget");
  }
  return zipSync(files, { level: 6, mtime: new Date(2020, 0, 1) });
}

function requireBytes(bytes: Uint8Array, offset: number, length: number): void {
  if (offset < 0 || length < 0 || offset + length > bytes.length) {
    throw new Error("Invalid or truncated ZIP structure");
  }
}

function decodeText(bytes: Uint8Array, name: string): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new Error(`Invalid UTF-8 encoding in ZIP member ${name}`);
  }
}

function assertSafePath(name: string): void {
  let unsafeCharacter = false;
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    if (code < 32 || code === 127 || name[index] === "\\") {
      unsafeCharacter = true;
      break;
    }
  }
  if (
    /^(?:[a-z]:|\/)/i.test(name) ||
    unsafeCharacter ||
    name.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe ZIP member path: ${name}`);
  }
}

function inspectZip(bytes: Uint8Array): Map<string, ZipMember> {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_ARCHIVE_BYTES) {
    throw new Error("ZIP exceeds the 20 MiB archive size limit and header allowance");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let endOffset = -1;
  for (
    let offset = bytes.length - 22;
    offset >= Math.max(0, bytes.length - 22 - 65535);
    offset -= 1
  ) {
    if (
      view.getUint32(offset, true) === 0x06054b50 &&
      offset + 22 + view.getUint16(offset + 20, true) === bytes.length
    ) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("Invalid ZIP: end of central directory is missing");
  const count = view.getUint16(endOffset + 10, true);
  const directorySize = view.getUint32(endOffset + 12, true);
  const directoryOffset = view.getUint32(endOffset + 16, true);
  if (
    view.getUint16(endOffset + 4, true) !== 0 ||
    view.getUint16(endOffset + 6, true) !== 0 ||
    view.getUint16(endOffset + 8, true) !== count ||
    count === 0xffff ||
    directoryOffset === 0xffffffff ||
    directorySize === 0xffffffff
  ) {
    throw new Error("Unsupported ZIP: multi-disk and ZIP64 archives are not supported");
  }
  if (count > ARCHIVE_MEMBERS.length) {
    throw new Error(
      "Roundtrip ZIP must contain exactly five members, including its canonical source",
    );
  }
  if (directoryOffset + directorySize !== endOffset)
    throw new Error("Invalid ZIP central directory");
  requireBytes(bytes, directoryOffset, directorySize);
  const members = new Map<string, ZipMember>();
  let cursor = directoryOffset;
  let totalBytes = 0;
  for (let index = 0; index < count; index += 1) {
    requireBytes(bytes, cursor, 46);
    if (view.getUint32(cursor, true) !== 0x02014b50)
      throw new Error("Invalid ZIP member directory");
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    requireBytes(bytes, cursor + 46, nameLength + extraLength + commentLength);
    const name = decodeText(bytes.subarray(cursor + 46, cursor + 46 + nameLength), "path");
    assertSafePath(name);
    if (members.has(name)) throw new Error(`Duplicate ZIP member path: ${name}`);
    const member: ZipMember = {
      name,
      flags: view.getUint16(cursor + 8, true),
      compression: view.getUint16(cursor + 10, true),
      crc: view.getUint32(cursor + 16, true),
      compressedSize: view.getUint32(cursor + 20, true),
      originalSize: view.getUint32(cursor + 24, true),
      localOffset: view.getUint32(cursor + 42, true),
    };
    const fileType = (view.getUint32(cursor + 38, true) >>> 16) & 0xf000;
    if (
      (member.flags & 0x41) !== 0 ||
      ![0, 8].includes(member.compression) ||
      view.getUint16(cursor + 34, true) !== 0 ||
      (fileType !== 0 && fileType !== 0x8000)
    ) {
      throw new Error(`Unsupported encrypted, special-file, or compressed ZIP member: ${name}`);
    }
    if (member.originalSize > MAX_ROUNDTRIP_TEXT_BYTES) {
      throw new Error(`ZIP member ${name} exceeds the 5 MiB declared uncompressed size limit`);
    }
    totalBytes += member.originalSize;
    if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
      throw new Error("ZIP exceeds the total 20 MiB declared uncompressed budget");
    }
    if (member.compressedSize > MAX_ARCHIVE_BYTES || member.localOffset === 0xffffffff) {
      throw new Error(`Invalid ZIP size or ZIP64 offset for ${name}`);
    }
    members.set(name, member);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== endOffset) throw new Error("Invalid ZIP central directory size");
  if (!members.has(".confx/source.html")) {
    throw new Error(
      "This ZIP has no canonical .confx/source.html; ordinary legacy exports are not reversible packages",
    );
  }
  if (
    members.size !== ARCHIVE_MEMBERS.length ||
    ARCHIVE_MEMBERS.some((name) => !members.has(name))
  ) {
    throw new Error(
      "Roundtrip ZIP has missing or extra members; exactly five fixed members are required",
    );
  }

  // Check every local declaration against the directory before allocating output
  // or starting any inflater. Contiguous ranges also exclude hidden local members.
  let expectedOffset = 0;
  for (const member of [...members.values()].sort(
    (left, right) => left.localOffset - right.localOffset,
  )) {
    const offset = member.localOffset;
    requireBytes(bytes, offset, 30);
    if (offset !== expectedOffset || view.getUint32(offset, true) !== 0x04034b50) {
      throw new Error("Invalid ZIP local member ranges or extra hidden members");
    }
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    requireBytes(bytes, offset + 30, nameLength + extraLength + member.compressedSize);
    const name = decodeText(bytes.subarray(offset + 30, offset + 30 + nameLength), "local path");
    assertSafePath(name);
    if (
      name !== member.name ||
      view.getUint16(offset + 6, true) !== member.flags ||
      view.getUint16(offset + 8, true) !== member.compression
    ) {
      throw new Error("ZIP local member does not match its declared directory entry");
    }
    expectedOffset = offset + 30 + nameLength + extraLength + member.compressedSize;
    if ((member.flags & 8) !== 0) {
      requireBytes(bytes, expectedOffset, 12);
      const descriptorOffset =
        expectedOffset + (view.getUint32(expectedOffset, true) === 0x08074b50 ? 4 : 0);
      requireBytes(bytes, descriptorOffset, 12);
      if (
        view.getUint32(descriptorOffset, true) !== member.crc ||
        view.getUint32(descriptorOffset + 4, true) !== member.compressedSize ||
        view.getUint32(descriptorOffset + 8, true) !== member.originalSize
      ) {
        throw new Error("ZIP data descriptor does not match declared member sizes");
      }
      expectedOffset = descriptorOffset + 12;
    } else if (
      view.getUint32(offset + 14, true) !== member.crc ||
      view.getUint32(offset + 18, true) !== member.compressedSize ||
      view.getUint32(offset + 22, true) !== member.originalSize
    ) {
      throw new Error("ZIP local declared size or checksum does not match its directory entry");
    }
    if (member.compression === 0 && member.compressedSize !== member.originalSize) {
      throw new Error("Stored ZIP member has inconsistent declared sizes");
    }
  }
  if (expectedOffset !== directoryOffset) throw new Error("Invalid ZIP member data boundaries");
  return members;
}

function unzipText(
  bytes: Uint8Array,
  members: ReadonlyMap<string, ZipMember>,
): Map<string, string> {
  const files = new Map<string, string>();
  const seen = new Set<string>();
  let failure: Error | undefined;
  const unzip = new Unzip((entry) => {
    if (failure) throw failure;
    const declared = members.get(entry.name);
    if (
      !declared ||
      seen.has(entry.name) ||
      entry.compression !== declared.compression ||
      (entry.originalSize !== undefined && entry.originalSize !== declared.originalSize) ||
      (entry.size !== undefined && entry.size !== declared.compressedSize)
    ) {
      throw new Error("ZIP stream does not match validated member declarations");
    }
    seen.add(entry.name);
    const data = new Uint8Array(declared.originalSize);
    let written = 0;
    let crc = 0xffffffff;
    entry.ondata = (error, chunk, final) => {
      if (failure) return;
      if (error) {
        failure = new Error(`Invalid ZIP member ${entry.name}: ${error.message}`);
        return;
      }
      if (written + chunk.length > declared.originalSize) {
        failure = new Error(`ZIP member ${entry.name} exceeds its declared uncompressed size`);
        return;
      }
      data.set(chunk, written);
      written += chunk.length;
      for (const byte of chunk) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
      if (!final) return;
      if (written !== declared.originalSize || (crc ^ 0xffffffff) >>> 0 !== declared.crc) {
        failure = new Error(`ZIP member ${entry.name} has an invalid size or checksum`);
        return;
      }
      try {
        files.set(entry.name, decodeText(data, entry.name));
      } catch (error) {
        failure = error instanceof Error ? error : new Error("Invalid ZIP text encoding");
      }
    };
    entry.start();
  });
  unzip.register(UnzipInflate);
  // A lying declared size must not make fflate inflate a whole bomb into one
  // temporary buffer: each input chunk bounds work before the output size check.
  for (let offset = 0; offset < bytes.length; offset += INFLATE_INPUT_CHUNK_BYTES) {
    const end = Math.min(offset + INFLATE_INPUT_CHUNK_BYTES, bytes.length);
    unzip.push(bytes.subarray(offset, end), end === bytes.length);
    if (failure) throw failure;
  }
  if (files.size !== ARCHIVE_MEMBERS.length)
    throw new Error("ZIP stream has missing or incomplete members");
  return files;
}

function parseJson(text: string, name: string): unknown {
  try {
    return JSON.parse(text.trimStart());
  } catch {
    throw new Error(`Invalid JSON in ${name}`);
  }
}

function mappingMatches(mapping: unknown, blocks: readonly RoundtripBlock[]): boolean {
  if (!Array.isArray(mapping) || mapping.length !== blocks.length) return false;
  return mapping.every((block: unknown, index) => {
    if (block === null || typeof block !== "object" || Array.isArray(block)) return false;
    const expected = blocks[index];
    if (Object.keys(block).length !== Object.keys(expected).length) return false;
    return Object.entries(block).every(([key, value]: [string, unknown]) => {
      if (!Object.hasOwn(expected, key)) return false;
      // This key was checked against the canonical engine-created block above.
      const field = key as keyof RoundtripBlock;
      return value === expected[field];
    });
  });
}

/** Reload untrusted local files by recreating their mapping from canonical source. */
export async function readRoundtripArchive(
  bytes: Uint8Array,
): Promise<{ package: RoundtripPackage; markdown: string }> {
  const members = inspectZip(bytes);
  const files = unzipText(bytes, members);
  const manifest = parseJson(files.get("manifest.json")!, "manifest.json");
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    !("format" in manifest) ||
    (manifest.format !== "confx-roundtrip/1" && manifest.format !== ROUNDTRIP_FORMAT)
  ) {
    throw new Error(
      "Unsupported roundtrip archive format version; ordinary legacy exports have no canonical source",
    );
  }
  if (
    Object.keys(manifest).some((key) => !["format", "snapshot", "sourceHash"].includes(key)) ||
    !("snapshot" in manifest) ||
    manifest.snapshot === null ||
    typeof manifest.snapshot !== "object" ||
    Array.isArray(manifest.snapshot)
  ) {
    throw new Error("Invalid roundtrip snapshot metadata in manifest.json");
  }
  if (!("sourceHash" in manifest) || typeof manifest.sourceHash !== "string") {
    throw new Error("Missing roundtrip source hash in manifest.json");
  }
  const metadata = manifest.snapshot;
  if (
    !("representation" in metadata) ||
    metadata.representation !== "editor" ||
    !("title" in metadata) ||
    typeof metadata.title !== "string" ||
    Object.keys(metadata).some(
      (key) => !["representation", "title", "pageId", "capturedAt"].includes(key),
    )
  ) {
    throw new Error("Invalid editor source representation or snapshot metadata in manifest.json");
  }
  const pageId = "pageId" in metadata ? metadata.pageId : undefined;
  const capturedAt = "capturedAt" in metadata ? metadata.capturedAt : undefined;
  if (pageId !== undefined && typeof pageId !== "string")
    throw new Error("Invalid snapshot page identity");
  if (capturedAt !== undefined && typeof capturedAt !== "string")
    throw new Error("Invalid snapshot capture timestamp");
  const snapshot: EditorSnapshot = {
    representation: "editor",
    html: files.get(".confx/source.html")!,
    title: metadata.title,
    ...(pageId !== undefined ? { pageId } : {}),
    ...(capturedAt !== undefined ? { capturedAt } : {}),
  };
  assertSafeEditorSnapshot(snapshot);
  const pkg = await createRoundtripPackage(snapshot, manifest.format);
  if (pkg.sourceHash !== manifest.sourceHash)
    throw new Error("Roundtrip canonical source hash does not match");
  if (pkg.baselineMarkdown !== files.get(".confx/baseline.md")) {
    throw new Error("Roundtrip baseline Markdown does not match the canonical source");
  }
  const mapping = parseJson(files.get(".confx/mapping.json")!, ".confx/mapping.json");
  if (!mappingMatches(mapping, pkg.blocks)) {
    throw new Error("Roundtrip mapping does not match the entire canonical source mapping");
  }
  return { package: pkg, markdown: files.get("index.md")! };
}
