import {
  createRoundtripPackage,
  applyRoundtripMarkdown,
  MAX_ROUNDTRIP_TEXT_BYTES,
  type RoundtripBlockKind,
  type RoundtripIssue,
  type RoundtripPackage,
  type RoundtripResult,
} from "./offline-roundtrip";
import { renderMarkdown, spliceSource, type SourceEdit } from "./offline-roundtrip/structure";
import { MAX_EDITABLE_MARKDOWN_BYTES, type EditorMarkdownTarget } from "./editor-markdown";
import {
  assertStorageText,
  closeStorageVoidTags,
  parseStorageXml,
  storageXmlIdentity,
  type StorageElement,
  type StorageNode,
} from "./storage-xml";

export interface StorageSnapshot {
  representation: "storage";
  html: string;
  title: string;
  pageId: string;
  version: number;
}

export type StorageMarkdownFormat = "confx-storage-markdown/1" | "confx-storage-markdown/2";

export interface StorageRoundtripPackage {
  format: StorageMarkdownFormat;
  snapshot: StorageSnapshot;
  sourceHash: string;
  baselineMarkdown: string;
}

interface StorageContainer {
  id: string;
  kind: "root" | "ac:layout" | "ac:layout-section" | "ac:layout-cell";
  start: number;
  end: number;
}

interface StorageBlock {
  id: string;
  kind: RoundtripBlockKind;
  start: number;
  end: number;
  markdown: string;
  container: StorageContainer;
  ordinary?: RoundtripPackage;
}

interface StorageMapping {
  package: StorageRoundtripPackage;
  blocks: StorageBlock[];
}

interface MarkdownRegions {
  blocks: Map<string, string>;
  insertions: { beforeBlock: number; markdown: string }[];
}

const FORMAT = "confx-storage-markdown/2";
const FOOTER_PREFIX = "<!-- confx:storage-markdown ";
const METADATA_ERROR =
  "Invalid or missing Confx Storage Markdown metadata footer. Keep the hidden footer at the end of the original editable.md file.";
const ORDINARY_BLOCKS: Record<string, true> = {
  p: true,
  h1: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
  table: true,
  pre: true,
};
const ORDINARY_ELEMENTS: Record<string, true> = {
  ...ORDINARY_BLOCKS,
  span: true,
  strong: true,
  b: true,
  em: true,
  i: true,
  s: true,
  del: true,
  strike: true,
  code: true,
  a: true,
  br: true,
  hr: true,
  ul: true,
  ol: true,
  li: true,
  blockquote: true,
  thead: true,
  tbody: true,
  tfoot: true,
  tr: true,
  th: true,
  td: true,
  colgroup: true,
  col: true,
};

function assertSnapshot(snapshot: StorageSnapshot): void {
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot) ||
    snapshot.representation !== "storage"
  ) {
    throw new Error("Only a Storage source representation is supported");
  }
  if (typeof snapshot.pageId !== "string" || !/^[1-9]\d*$/.test(snapshot.pageId)) {
    throw new Error("Storage snapshot page identity must be a positive decimal pageId");
  }
  if (!Number.isSafeInteger(snapshot.version) || snapshot.version <= 0) {
    throw new Error("Storage snapshot version must be a positive safe integer");
  }
  assertStorageText(snapshot.title, "Storage snapshot title");
  assertStorageText(snapshot.html, "Storage source");
}

function assertTarget(target: EditorMarkdownTarget): void {
  if (!target || typeof target.pageId !== "string" || !/^[1-9]\d*$/.test(target.pageId)) {
    throw new Error("Storage Markdown page identity must be a positive decimal pageId");
  }
  let url: URL;
  try {
    url = new URL(target.host);
  } catch {
    throw new Error("Storage Markdown host must be a canonical HTTP(S) base URL");
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
      "Storage Markdown host must be a canonical HTTP(S) base URL without credentials, query or fragment",
    );
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sourceHeader(pkg: StorageRoundtripPackage): string {
  const version = pkg.format === "confx-storage-markdown/1" ? 1 : 2;
  return `<!-- confx:storage-roundtrip version="${version}" page="${pkg.snapshot.pageId}" revision="${pkg.snapshot.version}" source="${pkg.sourceHash}" -->`;
}

function marker(block: StorageBlock): string {
  return `<!-- confx:block id="${block.id}" -->\n\n${block.markdown}\n\n<!-- confx:end id="${block.id}" -->`;
}

function ordinary(node: StorageElement): boolean {
  if (ORDINARY_BLOCKS[node.name] !== true || node.openEnd === node.end) return false;
  const supported = (current: StorageNode): boolean => {
    if (current.type !== "element") return current.type === "text";
    if (
      ORDINARY_ELEMENTS[current.name] !== true ||
      (current.namespaceURI !== null && current.namespaceURI !== "http://www.w3.org/1999/xhtml") ||
      current.attributes.some(
        (attribute) => attribute.name === "xmlns" || attribute.name.includes(":"),
      ) ||
      current.attributes.some(
        (attribute) =>
          attribute.name === "hidden" ||
          (attribute.name === "class" && attribute.value.split(/\s+/).includes("hidden")),
      ) ||
      current.attributes.some((attribute) => attribute.name.startsWith("data-macro-"))
    )
      return false;
    if (["br", "hr", "col"].includes(current.name) && current.children.length) return false;
    return current.children.every(supported);
  };
  return supported(node);
}

function renderOrdinaryMarkdown(markdown: string): string {
  const html = closeStorageVoidTags(renderMarkdown(markdown).html);
  const parsed = parseStorageXml(html);
  const supported = (node: StorageNode): boolean => {
    if (node.type !== "element") return node.type === "text";
    return (
      ORDINARY_ELEMENTS[node.name] === true &&
      node.namespaceURI === null &&
      !node.attributes.some(
        (attribute) => attribute.name === "xmlns" || attribute.name.includes(":"),
      ) &&
      node.children.every(supported)
    );
  };
  if (!parsed.children.every(supported)) {
    throw new Error("Unsupported or protected structures cannot be inserted through Markdown");
  }
  return html;
}

/** Regenerate all mapping information from the validated archived source, never from the file. */
async function createPackage(
  snapshot: StorageSnapshot,
  format: StorageMarkdownFormat = FORMAT,
): Promise<StorageMapping> {
  if (format !== "confx-storage-markdown/1" && format !== FORMAT)
    throw new Error("Unsupported Storage Markdown projection format version");
  assertSnapshot(snapshot);
  const original: StorageSnapshot = {
    representation: "storage",
    html: snapshot.html,
    title: snapshot.title,
    pageId: snapshot.pageId,
    version: snapshot.version,
  };
  const document = parseStorageXml(original.html);
  const blocks: StorageBlock[] = [];
  const add = async (node: StorageNode, container: StorageContainer): Promise<void> => {
    const id = `b${String(blocks.length).padStart(4, "0")}`;
    let editor: RoundtripPackage | undefined;
    if (node.type === "element" && ordinary(node)) {
      editor = await createRoundtripPackage(
        {
          representation: "editor",
          html: original.html.slice(node.start, node.end),
          title: "",
        },
        format === "confx-storage-markdown/1" ? "confx-roundtrip/1" : "confx-roundtrip/2",
      );
      if (
        editor.blocks.length !== 1 ||
        editor.blocks[0].kind === "opaque" ||
        (editor.blocks[0].kind !== "code" &&
          /(?:^|\n)[ \t]*<!-- confx:/.test(editor.blocks[0].markdown))
      )
        editor = undefined;
    }
    const label = node.type === "element" ? node.name : node.type;
    const block: StorageBlock = {
      id,
      kind: editor?.blocks[0].kind ?? "opaque",
      start: node.start,
      end: node.end,
      markdown: editor?.blocks[0].markdown ?? `[Confx protected ${label}: ${id}]`,
      container,
      ...(editor ? { ordinary: editor } : {}),
    };
    blocks.push(block);
  };
  const expose = async (nodes: StorageNode[], container: StorageContainer): Promise<void> => {
    for (const node of nodes) {
      if (node.type === "comment" || (node.type === "text" && !node.value.trim())) continue;
      const layout =
        node.type === "element" &&
        node.namespaceURI === "http://atlassian.com/content" &&
        ((node.name === "ac:layout" && container.kind === "root") ||
          (node.name === "ac:layout-section" && container.kind === "ac:layout") ||
          (node.name === "ac:layout-cell" && container.kind === "ac:layout-section"));
      if (layout && node.type === "element") {
        const before = blocks.length;
        await expose(node.children, {
          id: `container-${node.start}`,
          kind: node.name as StorageContainer["kind"],
          start: node.openEnd,
          end: node.closeStart,
        });
        if (blocks.length === before) await add(node, container);
      } else await add(node, container);
    }
  };
  await expose(document.children, {
    id: "root",
    kind: "root",
    start: 0,
    end: original.html.length,
  });
  const pkg: StorageRoundtripPackage = {
    format,
    snapshot: original,
    sourceHash: await sha256(original.html),
    baselineMarkdown: "",
  };
  pkg.baselineMarkdown = `${sourceHeader(pkg)}\n\n${blocks.map(marker).join("\n\n")}\n`;
  assertStorageText(pkg.baselineMarkdown, "Editable Storage Markdown");
  return { package: pkg, blocks };
}

/** Recognize mapping and footer comments only outside CommonMark fenced code. */
function fenceDelimiter(line: string): RegExpExecArray | null {
  return /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
}

function readRegions(
  markdown: string,
  pkg: StorageRoundtripPackage,
  expected: StorageBlock[],
): MarkdownRegions {
  assertStorageText(markdown, "Editable Storage Markdown");
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  if (lines.shift() !== sourceHeader(pkg))
    throw new Error("The Storage Markdown source/page/version identity does not match its package");
  const blocks = new Map<string, string>();
  const insertions: MarkdownRegions["insertions"] = [];
  let gap: string[] = [];
  let current: string | undefined;
  let content: string[] = [];
  let fence: { character: string; length: number } | undefined;
  const flush = (): void => {
    const value = gap.join("\n").replace(/^\n+|\n+$/g, "");
    if (value) insertions.push({ beforeBlock: blocks.size, markdown: value });
    gap = [];
  };
  for (const line of lines) {
    const delimiter = fenceDelimiter(line);
    if (fence) {
      (current === undefined ? gap : content).push(line);
      if (
        delimiter &&
        delimiter[1][0] === fence.character &&
        delimiter[1].length >= fence.length &&
        !delimiter[2].trim()
      )
        fence = undefined;
      continue;
    }
    const open = /^<!-- confx:block id="([\w-]+)" -->$/.exec(line);
    const close = /^<!-- confx:end id="([\w-]+)" -->$/.exec(line);
    if (open) {
      if (current !== undefined || blocks.has(open[1]))
        throw new Error("Duplicate or nested Storage source block identity");
      flush();
      current = open[1];
      content = [];
      continue;
    }
    if (close) {
      if (current !== close[1])
        throw new Error("Missing or mismatched Storage source block identity");
      if (content.length < 3 || content[0] !== "" || content[content.length - 1] !== "")
        throw new Error("Storage source block framing newlines were removed or changed");
      blocks.set(current, content.slice(1, -1).join("\n"));
      current = undefined;
      content = [];
      continue;
    }
    if (line.trimStart().startsWith("<!-- confx:"))
      throw new Error("Malformed or unexpected Storage mapping identity marker");
    (current === undefined ? gap : content).push(line);
    if (delimiter && !(delimiter[1][0] === "`" && delimiter[2].includes("`"))) {
      fence = { character: delimiter[1][0], length: delimiter[1].length };
    }
  }
  if (current !== undefined || fence)
    throw new Error("Unclosed Storage source block or code fence");
  flush();
  if (JSON.stringify([...blocks.keys()]) !== JSON.stringify(expected.map((block) => block.id))) {
    throw new Error("Storage source identities were removed, duplicated, inserted or reordered");
  }
  for (const block of expected) {
    if (block.kind === "opaque" && blocks.get(block.id) !== block.markdown) {
      throw new Error("Protected macros and unsupported Storage structures must remain unchanged");
    }
  }
  return { blocks, insertions };
}

function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  return btoa(chunks.join(""));
}

function decodeSource(value: string): string {
  if (
    value.length > 4 * Math.ceil(MAX_ROUNDTRIP_TEXT_BYTES / 3) ||
    value.length % 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    throw new Error("Invalid or oversized base64 Storage source metadata");
  const binary = atob(value);
  if (binary.length > MAX_ROUNDTRIP_TEXT_BYTES || btoa(binary) !== value)
    throw new Error("Invalid canonical base64 Storage source metadata");
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("Storage source metadata is not valid lossless UTF-8");
  }
}

/** One-pass bulk export helper: no inner ZIP or redundant archived baseline/mapping copies. */
export async function createStorageMarkdownExport(
  snapshot: StorageSnapshot,
  target: EditorMarkdownTarget,
): Promise<{ markdown: string; sourceHash: string }> {
  assertTarget(target);
  assertSnapshot(snapshot);
  if (snapshot.pageId !== target.pageId)
    throw new Error("Storage snapshot pageId does not match its target page identity");
  const { package: pkg, blocks } = await createPackage(snapshot);
  const baseline = readRegions(pkg.baselineMarkdown, pkg, blocks);
  if (
    baseline.insertions.length ||
    blocks.some((block) => baseline.blocks.get(block.id) !== block.markdown)
  )
    throw new Error("Generated Storage Markdown baseline does not match its source mapping");
  const metadata = JSON.stringify({
    format: FORMAT,
    host: target.host,
    pageId: pkg.snapshot.pageId,
    version: pkg.snapshot.version,
    title: pkg.snapshot.title,
    sourceHash: pkg.sourceHash,
    source: encodeBase64(new TextEncoder().encode(pkg.snapshot.html)),
  })
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  const markdown = `${pkg.baselineMarkdown}\n\n${FOOTER_PREFIX}${metadata} -->\n`;
  assertStorageText(markdown, "Storage Markdown file", MAX_EDITABLE_MARKDOWN_BYTES);
  return { markdown, sourceHash: pkg.sourceHash };
}

/** Export validated native Storage to a single self-contained editable Markdown file. */
export async function createStorageMarkdown(
  snapshot: StorageSnapshot,
  target: EditorMarkdownTarget,
): Promise<string> {
  return (await createStorageMarkdownExport(snapshot, target)).markdown;
}

/** Read declared Storage projection versions; ordinary Markdown and editor files are not fallbacks. */
export async function readStorageMarkdown(
  text: string,
): Promise<{ target: EditorMarkdownTarget; package: StorageRoundtripPackage; markdown: string }> {
  assertStorageText(text, "Storage Markdown file", MAX_EDITABLE_MARKDOWN_BYTES);
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  let footerOffset = -1;
  let fence: { character: string; length: number } | undefined;
  for (let offset = 0; offset < normalized.length; ) {
    const newline = normalized.indexOf("\n", offset);
    const end = newline === -1 ? normalized.length : newline;
    const line = normalized.slice(offset, end);
    const delimiter = fenceDelimiter(line);
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
    } else if (line.trimStart().startsWith("<!-- confx:storage-markdown")) {
      if (footerOffset !== -1) throw new Error(`Duplicate metadata footer. ${METADATA_ERROR}`);
      footerOffset = offset;
    }
    offset = end + 1;
  }
  if (footerOffset < 2 || normalized.slice(footerOffset - 2, footerOffset) !== "\n\n")
    throw new Error(METADATA_ERROR);
  const footer = normalized.slice(footerOffset);
  if (
    !footer.startsWith(FOOTER_PREFIX) ||
    !/ -->\n?$/.test(footer) ||
    footer.slice(0, footer.endsWith("\n") ? -1 : undefined).includes("\n")
  )
    throw new Error(METADATA_ERROR);
  const markdown = normalized.slice(0, footerOffset - 2);
  assertStorageText(markdown, "Editable Storage Markdown");
  const json = footer.slice(FOOTER_PREFIX.length).replace(/ -->\n?$/, "");
  if (json.includes("<!--") || json.includes("-->")) throw new Error(METADATA_ERROR);
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error(`Invalid metadata JSON. ${METADATA_ERROR}`);
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 7 ||
    !("format" in value) ||
    (value.format !== "confx-storage-markdown/1" && value.format !== FORMAT) ||
    !("host" in value) ||
    typeof value.host !== "string" ||
    !("pageId" in value) ||
    typeof value.pageId !== "string" ||
    !("version" in value) ||
    typeof value.version !== "number" ||
    !("title" in value) ||
    typeof value.title !== "string" ||
    !("sourceHash" in value) ||
    typeof value.sourceHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sourceHash) ||
    !("source" in value) ||
    typeof value.source !== "string"
  )
    throw new Error(METADATA_ERROR);
  const target = { host: value.host, pageId: value.pageId };
  assertTarget(target);
  const snapshot: StorageSnapshot = {
    representation: "storage",
    html: decodeSource(value.source),
    title: value.title,
    pageId: value.pageId,
    version: value.version,
  };
  assertSnapshot(snapshot);
  if ((await sha256(snapshot.html)) !== value.sourceHash)
    throw new Error("Storage source hash integrity check failed");
  const trusted = await createPackage(snapshot, value.format);
  readRegions(markdown, trusted.package, trusted.blocks);
  return { target, package: trusted.package, markdown };
}

function issue(error: unknown, code: string, blockId?: string): RoundtripIssue {
  return {
    code,
    message: error instanceof Error ? error.message : "Storage operation failed",
    ...(blockId ? { blockId } : {}),
  };
}

/** Patch only mapped native source ranges. result.html is Storage XML, never TinyMCE HTML. */
export async function applyStorageMarkdown(
  pkg: StorageRoundtripPackage,
  markdown: string,
): Promise<RoundtripResult> {
  const result: RoundtripResult = { status: "blocked", changes: [], issues: [] };
  let trusted: StorageMapping;
  let edited: MarkdownRegions;
  try {
    assertStorageText(markdown, "Editable Storage Markdown");
    trusted = await createPackage(pkg.snapshot, pkg.format);
    if (
      pkg.format !== trusted.package.format ||
      pkg.sourceHash !== trusted.package.sourceHash ||
      pkg.baselineMarkdown !== trusted.package.baselineMarkdown
    ) {
      throw new Error("Storage source, baseline or mapping integrity check failed");
    }
    edited = readRegions(markdown, trusted.package, trusted.blocks);
  } catch (error) {
    result.issues.push(issue(error, "package-or-mapping"));
    return result;
  }
  const edits: SourceEdit[] = [];
  for (const block of trusted.blocks) {
    const after = edited.blocks.get(block.id)!;
    if (after === block.markdown) continue;
    const change = {
      blockId: block.id,
      kind: block.kind,
      before: block.markdown,
      after,
      supported: true,
    };
    try {
      if (!block.ordinary) throw new Error("Protected Storage source cannot be edited or deleted");
      renderOrdinaryMarkdown(after);
      const local = block.ordinary.blocks[0];
      const suffix = `\n\n<!-- confx:end id="${local.id}" -->`;
      const localMarkdown = block.ordinary.baselineMarkdown.replace(
        local.markdown + suffix,
        after + suffix,
      );
      const patched = await applyRoundtripMarkdown(block.ordinary, localMarkdown);
      if (patched.status === "blocked" || patched.html === undefined)
        throw new Error(patched.issues.map((item) => item.message).join("; "));
      const replacement = closeStorageVoidTags(patched.html);
      parseStorageXml(replacement);
      edits.push({ start: block.start, end: block.end, value: replacement });
    } catch (error) {
      change.supported = false;
      result.issues.push(issue(error, "unsupported-edit", block.id));
    }
    result.changes.push(change);
  }
  for (const insertion of edited.insertions) {
    const blockId = `gap-${insertion.beforeBlock}`;
    const change = {
      blockId,
      kind: "paragraph" as const,
      before: "",
      after: insertion.markdown,
      supported: true,
    };
    try {
      const next = trusted.blocks[insertion.beforeBlock];
      const previous = trusted.blocks[insertion.beforeBlock - 1];
      const container = next?.container ?? previous?.container;
      if (container && container.kind !== "root" && container.kind !== "ac:layout-cell") {
        throw new Error("This protected layout boundary cannot contain inserted ordinary content");
      }
      if (next && previous && next.container.id !== previous.container.id) {
        throw new Error("Ambiguous insertion between different source containers");
      }
      if ((!next || !previous) && container && container.kind !== "root") {
        throw new Error("Ambiguous layout-cell insertion at the file boundary");
      }
      const offset = next?.start ?? previous?.end ?? 0;
      if (container && (offset < container.start || offset > container.end)) {
        throw new Error("Insertion falls outside its source container boundary");
      }
      const html = renderOrdinaryMarkdown(insertion.markdown);
      edits.push({ start: offset, end: offset, value: html });
    } catch (error) {
      change.supported = false;
      result.issues.push(issue(error, "unsupported-edit", blockId));
    }
    result.changes.push(change);
  }
  if (result.issues.length) return result;
  if (!edits.length) {
    result.html = trusted.package.snapshot.html;
    result.status = "unchanged";
    return result;
  }
  try {
    const html = spliceSource(trusted.package.snapshot.html, edits);
    parseStorageXml(html);
    result.html = html;
    result.status = html === trusted.package.snapshot.html ? "unchanged" : "ready";
  } catch (error) {
    result.issues.push(issue(error, "invalid-result"));
  }
  return result;
}

/** Validated, lossless structural identity for Storage↔live-editor conversion guards. */
export function storageIdentity(storage: string): string {
  return storageXmlIdentity(storage);
}
