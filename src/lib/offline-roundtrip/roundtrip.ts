import { marked, type Tokens } from "marked";
import { parseFragment, serialize, type DefaultTreeAdapterTypes as Tree } from "parse5";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { escapeMarkdownText } from "../markdown-literals";
import {
  MAX_ROUNDTRIP_TEXT_BYTES,
  ROUNDTRIP_FORMAT,
  type EditorSnapshot,
  type RoundtripBlock,
  type RoundtripBlockKind,
  type RoundtripIssue,
  type RoundtripPackage,
  type RoundtripFormat,
  type RoundtripResult,
} from "./contracts";
import { assertSafeEditorSnapshot } from "./snapshot";
import {
  attributeEdits,
  markdownSignature,
  renderChangedStructure,
  renderMarkdown,
  renderSourceElement,
  spliceSource,
  type SourceEdit,
} from "./structure";

type Node = Tree.Node;
type Element = Tree.Element;
interface TextRun {
  node: Tree.TextNode;
  start: number;
  end: number;
  marks: string;
}

function element(node: Node): node is Element {
  return "tagName" in node;
}
function textNode(node: Node): node is Tree.TextNode {
  return node.nodeName === "#text";
}
function children(node: Node): Tree.ChildNode[] {
  return "childNodes" in node ? node.childNodes : [];
}
function attribute(node: Element, name: string): string | undefined {
  return node.attrs.find((a) => a.name === name)?.value;
}
function descendants(node: Node, predicate: (node: Element) => boolean): Element[] {
  const result: Element[] = [];
  const visit = (current: Node): void => {
    if (element(current) && predicate(current)) result.push(current);
    children(current).forEach(visit);
  };
  visit(node);
  return result;
}
function visual(node: Node): string {
  if (textNode(node)) return node.value;
  if (element(node) && node.tagName === "br") return "\n";
  return children(node).map(visual).join("");
}
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function parseSource(html: string): Tree.DocumentFragment {
  return parseFragment(html, { sourceCodeLocationInfo: true });
}
function inlineConverter(format: RoundtripFormat): TurndownService {
  const converter = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  converter.use(gfm);
  converter.addRule("roundtrip-line-break", { filter: "br", replacement: () => "<br>" });
  if (format === "confx-roundtrip/2") {
    const escape = converter.escape.bind(converter);
    converter.escape = (text) => escapeMarkdownText(text, escape);
  }
  return converter;
}
function codeMarkdown(node: Element): string {
  const code = descendants(node, (el) => el.tagName === "code")[0];
  const language = code
    ? (/(?:^|\s)language-([\w-]+)/.exec(attribute(code, "class") ?? "")?.[1] ?? "")
    : "";
  const value = visual(node);
  let fenceLength = 3;
  for (const match of value.matchAll(/`+/g))
    fenceLength = Math.max(fenceLength, match[0].length + 1);
  const fence = "`".repeat(fenceLength);
  return `${fence}${language}\n${value}${value.endsWith("\n") ? "" : "\n"}${fence}`;
}
function tableMarkdown(
  node: Element,
  converter: TurndownService,
  format: RoundtripFormat,
): string | null {
  const rows = descendants(node, (el) => el.tagName === "tr");
  const cells = rows.map((row) =>
    row.childNodes.filter((n): n is Element => element(n) && ["th", "td"].includes(n.tagName)),
  );
  if (!cells.length || !cells[0].length) return null;
  const nativeHeader = cells[0].every((cell) => cell.tagName === "th");
  const emphasizedHeader =
    format === "confx-roundtrip/2" &&
    cells[0].every((cell) => {
      if (cell.tagName !== "td") return false;
      const content = cell.childNodes.filter(
        (child) => !textNode(child) || /[^ \t\r\n]/.test(child.value),
      );
      return (
        content.length === 1 &&
        element(content[0]) &&
        ["strong", "b"].includes(content[0].tagName) &&
        visual(content[0]).trim() !== ""
      );
    });
  if (!nativeHeader && !emphasizedHeader) return null;
  if (cells.some((row) => row.length !== cells[0].length)) return null;
  if (
    descendants(
      node,
      (el) =>
        attribute(el, "colspan") !== undefined ||
        attribute(el, "rowspan") !== undefined ||
        (el !== node && el.tagName === "table") ||
        el.tagName === "pre",
    ).length
  )
    return null;
  const lines = cells.map(
    (row) =>
      `| ${row.map((cell) => converter.turndown(serialize(cell)).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>").trim()).join(" | ")} |`,
  );
  lines.splice(1, 0, `| ${cells[0].map(() => "---").join(" | ")} |`);
  return lines.join("\n");
}
function hidden(node: Element): boolean {
  return (
    attribute(node, "hidden") !== undefined ||
    (attribute(node, "class") ?? "").split(/\s+/).includes("hidden")
  );
}
function classify(node: Element): RoundtripBlockKind {
  if (descendants(node, (el) => attribute(el, "data-macro-name") !== undefined).length)
    return "opaque";
  if (node.tagName === "p") return "paragraph";
  if (/^h[1-6]$/.test(node.tagName)) return "heading";
  if (node.tagName === "table") return "table";
  if (node.tagName === "pre") return "code";
  return "opaque";
}
function blockMarker(block: RoundtripBlock): string {
  return `<!-- confx:block id="${block.id}" -->\n\n${block.markdown}\n\n<!-- confx:end id="${block.id}" -->`;
}

export async function createRoundtripPackage(
  snapshot: EditorSnapshot,
  format: RoundtripFormat = ROUNDTRIP_FORMAT,
): Promise<RoundtripPackage> {
  if (format !== "confx-roundtrip/1" && format !== ROUNDTRIP_FORMAT)
    throw new Error("Unsupported roundtrip projection format version.");
  assertSafeEditorSnapshot(snapshot);
  const sourceHash = await sha256(snapshot.html);
  const fragment = parseSource(snapshot.html);
  const converter = inlineConverter(format);
  const blocks: RoundtripBlock[] = [];
  for (const node of fragment.childNodes) {
    if (!element(node) || hidden(node)) continue;
    if (
      node.tagName === "p" &&
      !visual(node).trim() &&
      !descendants(node, (el) => el.tagName === "img").length
    )
      continue;
    const location = node.sourceCodeLocation;
    if (!location) throw new Error("The snapshot has a top-level node without a source location.");
    const id = `b${String(blocks.length).padStart(4, "0")}`;
    let kind = classify(node);
    let markdown: string | null = null;
    if (kind === "table") markdown = tableMarkdown(node, converter, format);
    else if (kind === "code") markdown = codeMarkdown(node);
    else if (kind !== "opaque")
      markdown = converter.turndown(snapshot.html.slice(location.startOffset, location.endOffset));
    if (markdown === null) {
      kind = "opaque";
      const macro = descendants(node, (el) => attribute(el, "data-macro-name") !== undefined)[0];
      const label = macro ? (attribute(macro, "data-macro-name") ?? node.tagName) : node.tagName;
      markdown = `[Confx protected ${label.replace(/[\r\n]+/g, " ")}: ${id}]`;
    }
    blocks.push({
      id,
      kind,
      start: location.startOffset,
      end: location.endOffset,
      markdown,
      ...(kind === "code" ? { codeEndsWithNewline: visual(node).endsWith("\n") } : {}),
    });
  }
  const version = format === "confx-roundtrip/1" ? 1 : 2;
  const header = `<!-- confx:roundtrip version="${version}" source="${sourceHash}" -->`;
  return {
    format,
    snapshot: { ...snapshot },
    sourceHash,
    blocks,
    baselineMarkdown: `${header}\n\n${blocks.map(blockMarker).join("\n\n")}\n`,
  };
}

interface MarkdownInsertion {
  beforeBlock: number;
  markdown: string;
}
interface MarkdownRegions {
  blocks: Map<string, string>;
  insertions: MarkdownInsertion[];
}

/** Mapping comments are recognized only outside fenced code, never by a global regex. */
function readMarkdownBlocks(markdown: string, pkg: RoundtripPackage): MarkdownRegions {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const version = pkg.format === "confx-roundtrip/1" ? 1 : 2;
  const header = `<!-- confx:roundtrip version="${version}" source="${pkg.sourceHash}" -->`;
  if (lines.shift() !== header)
    throw new Error("The Markdown source identity/version does not match this package.");
  const result = new Map<string, string>();
  const insertions: MarkdownInsertion[] = [];
  let gap: string[] = [];
  const flushGap = (): void => {
    const markdown = gap.join("\n").replace(/^\n+|\n+$/g, "");
    if (markdown) insertions.push({ beforeBlock: result.size, markdown });
    gap = [];
  };
  let current: string | undefined;
  let content: string[] = [];
  let fence: { character: string; length: number } | undefined;
  for (const line of lines) {
    const fenced = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      (current === undefined ? gap : content).push(line);
      if (
        fenced &&
        fenced[1][0] === fence.character &&
        fenced[1].length >= fence.length &&
        !fenced[2].trim()
      )
        fence = undefined;
      continue;
    }
    const open = /^<!-- confx:block id="([\w-]+)" -->$/.exec(line);
    const close = /^<!-- confx:end id="([\w-]+)" -->$/.exec(line);
    if (open) {
      if (current !== undefined || result.has(open[1]))
        throw new Error("Duplicate or nested source block identity.");
      flushGap();
      current = open[1];
      content = [];
      continue;
    }
    if (close) {
      if (current !== close[1]) throw new Error("Missing or mismatched source block identity.");
      if (content.length < 3 || content[0] !== "" || content[content.length - 1] !== "")
        throw new Error("Source block framing newlines were removed or changed.");
      result.set(current, content.slice(1, -1).join("\n"));
      current = undefined;
      content = [];
      continue;
    }
    if (/^<!-- confx:(?:block|end|roundtrip)/.test(line))
      throw new Error("Malformed roundtrip identity marker.");
    if (current === undefined) gap.push(line);
    else content.push(line);
    if (fenced && !(fenced[1][0] === "`" && fenced[2].includes("`")))
      fence = { character: fenced[1][0], length: fenced[1].length };
  }
  if (current !== undefined || fence) throw new Error("Unclosed source block or code fence.");
  flushGap();
  if (JSON.stringify([...result.keys()]) !== JSON.stringify(pkg.blocks.map((block) => block.id)))
    throw new Error("Source block identities were removed, duplicated, inserted or reordered.");
  return { blocks: result, insertions };
}
function shape(node: Node): unknown {
  if (textNode(node) || node.nodeName === "#comment") return null;
  const nested = children(node)
    .filter((child) => !textNode(child) && child.nodeName !== "#comment")
    .map(shape);
  return element(node)
    ? [node.tagName, node.attrs.map((a) => [a.name, a.value]).sort(), nested]
    : nested;
}
function codeValue(markdown: string, block: RoundtripBlock): { text: string; language: string } {
  const tokens = marked.lexer(markdown).filter((token) => token.type !== "space");
  if (tokens.length !== 1 || tokens[0].type !== "code")
    throw new Error("Code blocks cannot be replaced with a different structure.");
  const code = tokens[0] as Tokens.Code;
  return { text: code.text + (block.codeEndsWithNewline ? "\n" : ""), language: code.lang ?? "" };
}
function changeRange(
  before: string,
  after: string,
): { start: number; end: number; inserted: string } {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++;
  return {
    start: prefix,
    end: before.length - suffix,
    inserted: after.slice(prefix, after.length - suffix),
  };
}
function textRuns(node: Node): { text: string; runs: TextRun[] } {
  let text = "";
  const runs: TextRun[] = [];
  function visit(current: Node, marks: string): void {
    if (textNode(current)) {
      const start = text.length;
      text += current.value;
      runs.push({ node: current, start, end: text.length, marks });
    } else if (element(current) && current.tagName === "br") text += "\n";
    else {
      const formatted =
        element(current) &&
        (["code", "a", "strong", "em", "b", "i", "del"].includes(current.tagName) ||
          (current.tagName === "span" && current.attrs.length > 0));
      const next =
        formatted && element(current)
          ? `${marks}/${current.tagName}:${JSON.stringify(current.attrs.map((attr) => [attr.name, attr.value]).sort())}`
          : marks;
      children(current).forEach((child) => visit(child, next));
    }
  }
  visit(node, "");
  return { text, runs };
}
function textEdits(node: Node, before: string, after: string, exact = false): SourceEdit[] {
  if (before === after) return [];
  const { text, runs } = textRuns(node);
  const normalize = exact
    ? (value: string): string => value
    : (value: string): string => value.trim();
  if (normalize(text) !== normalize(before))
    throw new Error(
      "This Markdown projection normalizes source text; editing it would lose information.",
    );
  const change = changeRange(normalize(before), normalize(after));
  const leading = exact ? 0 : text.length - text.trimStart().length;
  change.start += leading;
  change.end += leading;
  if (change.start === change.end && !change.inserted) return [];
  const touched = runs.filter((run) =>
    change.start === change.end
      ? run.start <= change.start && run.end >= change.start
      : run.start < change.end && run.end > change.start,
  );
  if (!touched.length || new Set(touched.map((run) => run.marks)).size !== 1)
    throw new Error("The edit crosses an ambiguous inline-formatting boundary.");
  if (touched.some((run, index) => index > 0 && run.start !== touched[index - 1].end))
    throw new Error("The edit crosses a structural line break.");
  return touched.map((run, index) => {
    const location = run.node.sourceCodeLocation;
    if (!location) throw new Error("A text node has no stable source location.");
    const from = Math.max(0, change.start - run.start);
    const to = Math.min(run.node.value.length, change.end - run.start);
    const value =
      run.node.value.slice(0, from) +
      (index === 0 ? change.inserted : "") +
      run.node.value.slice(to);
    return { start: location.startOffset, end: location.endOffset, value: escapeHtml(value) };
  });
}
function codeEdits(
  source: string,
  node: Element,
  block: RoundtripBlock,
  markdown: string,
): SourceEdit[] {
  const before = codeValue(block.markdown, block),
    after = codeValue(markdown, block);
  if (visual(node) !== before.text)
    throw new Error("The code projection does not match the original whitespace.");
  const code = descendants(node, (el) => el.tagName === "code")[0];
  const payload = code ?? node;
  const location = payload.sourceCodeLocation;
  if (!location?.startTag || !location.endTag)
    throw new Error("Code payload boundaries are not explicit.");
  const edits: SourceEdit[] = [];
  if (before.language !== after.language) {
    if (!/^[\w+-]*$/.test(after.language)) throw new Error("Unsupported code language identifier.");
    if (code) {
      const original = attribute(code, "class") ?? "";
      const language = after.language ? `language-${after.language}` : "";
      const value = /(?:^|\s)language-[^\s]+/.test(original)
        ? original.replace(/(^|\s)language-[^\s]+/g, (_, prefix: string) => `${prefix}${language}`)
        : `${original}${original && language ? " " : ""}${language}`;
      edits.push(...attributeEdits(source, code, new Map([["class", value || undefined]])));
    } else if (after.language) {
      edits.push(
        {
          start: location.startTag.endOffset,
          end: location.startTag.endOffset,
          value: `<code class="language-${after.language}">`,
        },
        { start: location.endTag.startOffset, end: location.endTag.startOffset, value: "</code>" },
      );
    }
  }
  if (before.text === after.text) return edits;
  const change = changeRange(before.text, after.text);
  if (
    !change.inserted.includes("\n") &&
    !before.text.slice(change.start, change.end).includes("\n")
  )
    return [...edits, ...textEdits(node, before.text, after.text, true)];
  if (
    descendants(
      payload,
      (el) =>
        el !== payload && ((el.tagName !== "span" && el.tagName !== "br") || el.attrs.length > 0),
    ).length
  )
    throw new Error("A multiline edit would discard nested code formatting.");
  const escaped = escapeHtml(after.text);
  edits.push({
    start: location.startTag.endOffset,
    end: location.endTag.startOffset,
    value: descendants(payload, (el) => el.tagName === "br").length
      ? escaped.replace(/\n/g, "<br>")
      : escaped,
  });
  return edits;
}

function editsForBlock(
  source: string,
  node: Element,
  block: RoundtripBlock,
  markdown: string,
): SourceEdit[] {
  if (block.kind === "opaque")
    throw new Error("Protected macros and unsupported structures must remain unchanged.");
  if (!markdown) return [{ start: block.start, end: block.end, value: "" }];
  const before = renderMarkdown(block.markdown).tree;
  const after = renderMarkdown(markdown).tree;
  if (block.kind === "code") {
    const tokens = marked.lexer(markdown).filter((token) => token.type !== "space");
    if (tokens.length === 1 && tokens[0].type === "code")
      return codeEdits(source, node, block, markdown);
  }
  if (markdownSignature(before) === markdownSignature(after)) return [];
  if (JSON.stringify(shape(before)) !== JSON.stringify(shape(after))) {
    const value = renderChangedStructure(
      source,
      node,
      before,
      after,
      (cell, beforeCell, afterCell) => {
        const location = cell.sourceCodeLocation;
        if (!location) throw new Error("A table cell has no source location.");
        if (markdownSignature(beforeCell) === markdownSignature(afterCell))
          return source.slice(location.startOffset, location.endOffset);
        if (JSON.stringify(shape(beforeCell)) === JSON.stringify(shape(afterCell))) {
          return spliceSource(
            source,
            textEdits(cell, visual(beforeCell), visual(afterCell)),
            location.startOffset,
            location.endOffset,
          );
        }
        // A declared emphasized TD header projects as TH in GFM, not a source tag change.
        const target =
          cell.tagName === "td" && beforeCell.tagName === "th"
            ? { ...afterCell, tagName: "td" }
            : afterCell;
        return renderSourceElement(source, cell, target);
      },
    );
    return [{ start: block.start, end: block.end, value }];
  }
  if (block.kind === "table") {
    const originalCells = descendants(node, (el) => ["th", "td"].includes(el.tagName));
    const beforeCells = descendants(before, (el) => ["th", "td"].includes(el.tagName));
    const afterCells = descendants(after, (el) => ["th", "td"].includes(el.tagName));
    if (originalCells.length !== beforeCells.length || beforeCells.length !== afterCells.length)
      throw new Error("Table shape does not match its source.");
    return originalCells.flatMap((cell, index) =>
      markdownSignature(beforeCells[index]) === markdownSignature(afterCells[index])
        ? []
        : textEdits(cell, visual(beforeCells[index]), visual(afterCells[index])),
    );
  }
  const beforeNode = children(before).find(element),
    afterNode = children(after).find(element);
  if (!beforeNode || !afterNode) throw new Error("The edited region has no renderable content.");
  return textEdits(node, visual(beforeNode), visual(afterNode));
}
function issue(error: unknown, code: string, blockId?: string): RoundtripIssue {
  return {
    code,
    message: error instanceof Error ? error.message : "The offline operation failed.",
    ...(blockId ? { blockId } : {}),
  };
}

export async function applyRoundtripMarkdown(
  pkg: RoundtripPackage,
  markdown: string,
): Promise<RoundtripResult> {
  const result: RoundtripResult = { status: "blocked", changes: [], issues: [] };
  let trusted: RoundtripPackage;
  let edited: MarkdownRegions;
  try {
    if (new TextEncoder().encode(markdown).length > MAX_ROUNDTRIP_TEXT_BYTES)
      throw new Error("The Markdown file exceeds the 5 MiB limit.");
    trusted = await createRoundtripPackage(pkg.snapshot, pkg.format);
    if (
      pkg.format !== trusted.format ||
      pkg.sourceHash !== trusted.sourceHash ||
      pkg.baselineMarkdown !== trusted.baselineMarkdown ||
      JSON.stringify(pkg.blocks) !== JSON.stringify(trusted.blocks)
    )
      throw new Error(
        "Source, baseline or mapping integrity check failed; load the original package again.",
      );
    edited = readMarkdownBlocks(markdown, trusted);
  } catch (error) {
    result.issues.push(issue(error, "package-or-mapping"));
    return result;
  }
  const fragment = parseSource(trusted.snapshot.html);
  const nodes = new Map(
    fragment.childNodes.filter(element).map((node) => [node.sourceCodeLocation?.startOffset, node]),
  );
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
      const node = nodes.get(block.start);
      if (!node) throw new Error("Source block is missing.");
      edits.push(...editsForBlock(trusted.snapshot.html, node, block, after));
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
      const { html } = renderMarkdown(insertion.markdown);
      const offset =
        trusted.blocks[insertion.beforeBlock]?.start ??
        trusted.blocks[trusted.blocks.length - 1]?.end ??
        0;
      edits.push({ start: offset, end: offset, value: html });
    } catch (error) {
      change.supported = false;
      result.issues.push(issue(error, "unsupported-edit", blockId));
    }
    result.changes.push(change);
  }
  if (result.issues.length) return result;
  try {
    const html = spliceSource(trusted.snapshot.html, edits);
    assertSafeEditorSnapshot({ ...trusted.snapshot, html });
    result.html = html;
    result.status = html === trusted.snapshot.html ? "unchanged" : "ready";
  } catch (error) {
    result.issues.push(issue(error, "invalid-result"));
  }
  return result;
}
