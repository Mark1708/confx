import {
  createRoundtripPackage,
  readRoundtripArchive,
  writeRoundtripArchive,
  MAX_ROUNDTRIP_TEXT_BYTES,
  type EditorSnapshot,
  type RoundtripPackage,
} from "./offline-roundtrip";

export interface EditorMarkdownTarget {
  host: string;
  pageId: string;
}

// 20 MiB ZIP plus headers, base64 expansion, 5 MiB editable text and metadata.
export const MAX_EDITABLE_MARKDOWN_BYTES = 35 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024 + 64 * 1024;
const FORMAT = "confx-editor-markdown/2";
const FOOTER_PREFIX = "<!-- confx:editor-markdown ";
const METADATA_ERROR =
  "Invalid or missing Confx editor Markdown metadata footer. Export this page from its open editor again and keep the hidden footer at the end of the file.";

function assertBoundedText(text: string, limit: number): void {
  if (typeof text !== "string") throw new Error("Editor Markdown must contain text");
  if (text.length > limit)
    throw new Error(
      "Editor Markdown exceeds its file size limit (35 MiB total, 5 MiB editable text)",
    );
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error("Editor Markdown contains non-lossless Unicode (an unpaired surrogate)");
      }
      index += 1;
      bytes += 4;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("Editor Markdown contains non-lossless Unicode (an unpaired surrogate)");
    } else bytes += 3;
    if (bytes > limit)
      throw new Error(
        "Editor Markdown exceeds its file size limit (35 MiB total, 5 MiB editable text)",
      );
  }
}

function assertTarget(target: EditorMarkdownTarget): void {
  if (typeof target.pageId !== "string" || !/^\d+$/.test(target.pageId)) {
    throw new Error("Editor Markdown page identity must be a numeric pageId");
  }
  let url: URL;
  try {
    url = new URL(target.host);
  } catch {
    throw new Error("Editor Markdown host must be a canonical HTTP(S) base URL");
  }
  if (
    typeof target.host !== "string" ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    target.host.includes("?") ||
    target.host.includes("#") ||
    url.href.replace(/\/$/, "") !== target.host
  ) {
    throw new Error(
      "Editor Markdown host must be a canonical HTTP(S) base URL without credentials, query or fragment",
    );
  }
}

function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}

function decodeArchive(value: string): Uint8Array {
  if (
    !value.length ||
    value.length > 4 * Math.ceil(MAX_ARCHIVE_BYTES / 3) ||
    value.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(value) ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new Error("Invalid or oversized base64 archive in Confx editor Markdown metadata");
  }
  const binary = atob(value);
  // atob accepts noncanonical padding bits; require the exact RFC 4648 encoding.
  if (binary.length > MAX_ARCHIVE_BYTES || btoa(binary) !== value) {
    throw new Error("Invalid base64 archive in Confx editor Markdown metadata");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** Export the original, validated source package inside one locally editable Markdown file. */
export async function createEditorMarkdown(
  snapshot: EditorSnapshot,
  target: EditorMarkdownTarget,
): Promise<string> {
  assertTarget(target);
  if (snapshot.pageId !== target.pageId) {
    throw new Error("Editor snapshot pageId does not match the target page identity");
  }
  // The core validates snapshot safety and lossless Unicode before hashing or archiving it.
  const pkg = await createRoundtripPackage(snapshot);
  const metadata = JSON.stringify({
    format: FORMAT,
    host: target.host,
    pageId: target.pageId,
    archive: encodeBase64(writeRoundtripArchive(pkg)),
  })
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  const file = `${pkg.baselineMarkdown}\n\n${FOOTER_PREFIX}${metadata} -->\n`;
  assertBoundedText(file, MAX_EDITABLE_MARKDOWN_BYTES);
  return file;
}

/** Read only the lossless editor format; ordinary Markdown is never a fallback. */
export async function readEditorMarkdown(text: string): Promise<{
  target: EditorMarkdownTarget;
  package: RoundtripPackage;
  markdown: string;
}> {
  assertBoundedText(text, MAX_EDITABLE_MARKDOWN_BYTES);
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  let footerOffset = -1;
  let fence: { character: string; length: number } | undefined;
  for (let offset = 0; offset < normalized.length; ) {
    const newline = normalized.indexOf("\n", offset);
    const end = newline === -1 ? normalized.length : newline;
    const line = normalized.slice(offset, end);
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (
        delimiter &&
        delimiter[1][0] === fence.character &&
        delimiter[1].length >= fence.length &&
        !delimiter[2].trim()
      )
        fence = undefined;
    } else if (delimiter && !(delimiter[1][0] === "`" && delimiter[2].includes("`"))) {
      fence = { character: delimiter[1][0], length: delimiter[1].length };
    } else if (line.trimStart().startsWith("<!-- confx:editor-markdown")) {
      if (footerOffset !== -1) throw new Error(`Duplicate metadata footer. ${METADATA_ERROR}`);
      footerOffset = offset;
    }
    offset = end + 1;
  }
  if (footerOffset < 2 || normalized.slice(footerOffset - 2, footerOffset) !== "\n\n") {
    throw new Error(METADATA_ERROR);
  }
  const footer = normalized.slice(footerOffset);
  if (
    !footer.startsWith(FOOTER_PREFIX) ||
    !/ -->\n?$/.test(footer) ||
    footer.slice(0, footer.endsWith("\n") ? -1 : undefined).includes("\n")
  ) {
    throw new Error(METADATA_ERROR);
  }
  const json = footer.slice(FOOTER_PREFIX.length).replace(/ -->\n?$/, "");
  if (json.includes("<!--") || json.includes("-->")) throw new Error(METADATA_ERROR);
  let metadata: unknown;
  try {
    metadata = JSON.parse(json);
  } catch {
    throw new Error(`Invalid metadata JSON. ${METADATA_ERROR}`);
  }
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    Object.keys(metadata).length !== 4 ||
    !("format" in metadata) ||
    (metadata.format !== "confx-editor-markdown/1" && metadata.format !== FORMAT) ||
    !("host" in metadata) ||
    typeof metadata.host !== "string" ||
    !("pageId" in metadata) ||
    typeof metadata.pageId !== "string" ||
    !("archive" in metadata) ||
    typeof metadata.archive !== "string"
  ) {
    throw new Error(METADATA_ERROR);
  }
  const target = { host: metadata.host, pageId: metadata.pageId };
  assertTarget(target);
  const markdown = normalized.slice(0, footerOffset - 2);
  assertBoundedText(markdown, MAX_ROUNDTRIP_TEXT_BYTES);
  const loaded = await readRoundtripArchive(decodeArchive(metadata.archive));
  const expectedFormat =
    metadata.format === "confx-editor-markdown/1" ? "confx-roundtrip/1" : "confx-roundtrip/2";
  if (loaded.package.format !== expectedFormat) {
    throw new Error("Editor Markdown and embedded archive projection versions do not match");
  }
  if (loaded.package.snapshot.pageId !== target.pageId) {
    throw new Error(
      "Editor Markdown metadata pageId does not match the archived snapshot page identity",
    );
  }
  if (loaded.markdown !== loaded.package.baselineMarkdown) {
    throw new Error(
      "Embedded archive index.md must remain the original baseline; edit only the outer Markdown",
    );
  }
  return { target, package: loaded.package, markdown };
}
