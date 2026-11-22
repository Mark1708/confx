import { marked } from "marked";
import {
  parseFragment,
  serializeOuter,
  Tokenizer,
  TokenizerMode,
  type DefaultTreeAdapterTypes as Tree,
} from "parse5";
import { assertSafeEditorSnapshot } from "./snapshot";

export interface SourceEdit {
  start: number;
  end: number;
  value: string;
}

type Node = Tree.Node;
type Element = Tree.Element;

function element(node: Node): node is Element {
  return "tagName" in node;
}
function textNode(node: Node): node is Tree.TextNode {
  return node.nodeName === "#text";
}
function children(node: Node): Tree.ChildNode[] {
  return "childNodes" in node ? node.childNodes : [];
}
function descendants(node: Node, tag: string): Element[] {
  const result: Element[] = [];
  for (const child of children(node)) {
    if (element(child) && child.tagName === tag) result.push(child);
    result.push(...descendants(child, tag));
  }
  return result;
}
function visual(node: Node): string {
  if (textNode(node)) return node.value;
  if (element(node) && node.tagName === "br") return "\n";
  return children(node).map(visual).join("");
}
function canonicalTag(tag: string): string {
  return tag === "b" ? "strong" : tag === "i" ? "em" : tag;
}
function compatible(before: Element, after: Element): boolean {
  return (
    canonicalTag(before.tagName) === canonicalTag(after.tagName) ||
    (/^(?:p|h[1-6])$/.test(before.tagName) && /^(?:p|h[1-6])$/.test(after.tagName))
  );
}
function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttribute(text: string, quote = '"'): string {
  return escapeText(text).replace(quote === '"' ? /"/g : /'/g, quote === '"' ? "&quot;" : "&#39;");
}
function rawSource(source: string, node: Node): string {
  const location = node.sourceCodeLocation;
  if (!location) throw new Error("A source node has no stable source location.");
  return source.slice(location.startOffset, location.endOffset);
}

/** Validate the unparsed renderer output too: HTML parsing can discard active tags/attributes. */
export function renderMarkdown(markdown: string): { html: string; tree: Tree.DocumentFragment } {
  const html = marked.parse(markdown, { gfm: true, breaks: false, async: false });
  assertSafeEditorSnapshot({ representation: "editor", title: "", html });
  const tokenizer = new Tokenizer(
    {},
    {
      onStartTag(token) {
        if (
          token.attrs.some((attr) => attr.name.startsWith("data-macro-")) ||
          token.attrs.some(
            (attr) =>
              attr.name === "class" && attr.value.split(/\s+/).includes("editor-inline-macro"),
          ) ||
          /^(?:ac|ri):/.test(token.tagName)
        )
          throw new Error("Protected macro HTML cannot be inserted through Markdown.");
        if (token.tagName === "title") tokenizer.state = TokenizerMode.RCDATA;
      },
      onEndTag() {},
      onNullCharacter() {},
      onComment() {},
      onDoctype() {},
      onEof() {},
      onCharacter() {},
      onWhitespaceCharacter() {},
    },
  );
  tokenizer.write(html, true);
  return { html, tree: parseFragment(html) };
}

type Semantic = string | [string, [string, string][], Semantic[]];

function semanticChildren(node: Node, projection: boolean, exact: boolean): Semantic[] {
  const result: Semantic[] = [];
  const append = (child: Node): void => {
    if (textNode(child)) {
      const value = exact ? child.value : child.value.replace(/\s+/g, " ");
      const previous = result[result.length - 1];
      if (typeof previous === "string") result[result.length - 1] = previous + value;
      else result.push(value);
    } else if (element(child)) {
      if (
        projection &&
        (child.tagName === "span" ||
          (element(node) && ["td", "th"].includes(node.tagName) && child.tagName === "p"))
      ) {
        children(child).forEach(append);
        return;
      }
      const tag = canonicalTag(child.tagName);
      const attrs = child.attrs
        .filter(
          (attr) =>
            !projection ||
            (tag === "a" && ["href", "title"].includes(attr.name)) ||
            (tag === "img" && ["src", "alt", "title"].includes(attr.name)) ||
            (tag === "ol" && attr.name === "start") ||
            (["td", "th"].includes(tag) && attr.name === "align") ||
            (tag === "code" && element(node) && node.tagName === "pre" && attr.name === "class"),
        )
        .map((attr): [string, string] => [attr.name, attr.value])
        .sort((a, b) => a[0].localeCompare(b[0]));
      result.push([
        tag,
        attrs,
        semanticChildren(child, projection, exact || tag === "pre" || tag === "code"),
      ]);
    }
  };
  children(node).forEach(append);
  if (
    !exact &&
    (node.nodeName === "#document-fragment" ||
      (element(node) &&
        /^(?:p|h[1-6]|td|th|tr|thead|tbody|tfoot|table|li|ul|ol|blockquote)$/.test(node.tagName)))
  ) {
    if (typeof result[0] === "string") result[0] = result[0].trimStart();
    if (typeof result[result.length - 1] === "string") {
      result[result.length - 1] = (result[result.length - 1] as string).trimEnd();
    }
  }
  return result.filter((value) => value !== "");
}

export function markdownSignature(node: Node): string {
  if (node.nodeName === "#document-fragment")
    return JSON.stringify(semanticChildren(node, false, false));
  const wrapper = { nodeName: "#document-fragment", childNodes: [node] } as Tree.DocumentFragment;
  return JSON.stringify(semanticChildren(wrapper, false, false));
}
function sourceSignature(node: Node): string {
  const wrapper = { nodeName: "#document-fragment", childNodes: [node] } as Tree.DocumentFragment;
  return JSON.stringify(semanticChildren(wrapper, true, false));
}

/** Ordered matches preserve duplicate rows deterministically; unmatched runs pair positionally. */
function align(before: string[], after: string[]): (number | undefined)[] {
  const result: (number | undefined)[] = Array(after.length).fill(undefined);
  const anchors: [number, number][] = [];
  if (before.length * after.length <= 250_000) {
    const width = after.length + 1;
    const lengths = new Uint32Array((before.length + 1) * width);
    for (let i = before.length - 1; i >= 0; i--) {
      for (let j = after.length - 1; j >= 0; j--) {
        lengths[i * width + j] =
          before[i] === after[j]
            ? 1 + lengths[(i + 1) * width + j + 1]
            : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
      }
    }
    let i = 0,
      j = 0;
    while (i < before.length && j < after.length) {
      if (before[i] === after[j]) {
        anchors.push([i++, j++]);
      } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) i++;
      else j++;
    }
  } else {
    // Bound memory for very large tables. Exact ordered anchors still protect unchanged cells.
    const positions = new Map<string, number[]>();
    before.forEach((key, index) => {
      const indices = positions.get(key) ?? [];
      indices.push(index);
      positions.set(key, indices);
    });
    let cursor = 0;
    after.forEach((key, index) => {
      const match = positions.get(key)?.find((position) => position >= cursor);
      if (match !== undefined) {
        anchors.push([match, index]);
        cursor = match + 1;
      }
    });
  }
  let oldStart = 0,
    newStart = 0;
  for (const [oldEnd, newEnd] of [...anchors, [before.length, after.length]]) {
    for (let offset = 0; offset < Math.min(oldEnd - oldStart, newEnd - newStart); offset++) {
      result[newStart + offset] = oldStart + offset;
    }
    if (newEnd < after.length) result[newEnd] = oldEnd;
    oldStart = oldEnd + 1;
    newStart = newEnd + 1;
  }
  return result;
}

export function spliceSource(
  source: string,
  edits: SourceEdit[],
  start = 0,
  end = source.length,
): string {
  const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  let cursor = start;
  const parts: string[] = [];
  for (const edit of ordered) {
    if (edit.start < cursor || edit.end < edit.start || edit.end > end)
      throw new Error("Overlapping or invalid source edits.");
    parts.push(source.slice(cursor, edit.start), edit.value);
    cursor = edit.end;
  }
  parts.push(source.slice(cursor, end));
  return parts.join("");
}

/** Update only the attribute token, retaining its original quoting and unrelated start-tag bytes. */
export function attributeEdits(
  source: string,
  node: Element,
  values: Map<string, string | undefined>,
): SourceEdit[] {
  const location = node.sourceCodeLocation;
  if (!location?.startTag) throw new Error("Source element has no explicit opening tag.");
  const edits: SourceEdit[] = [];
  for (const [name, value] of values) {
    const original = node.attrs.find((attr) => attr.name === name);
    if (original?.value === value) continue;
    const attrLocation = location.attrs?.[name];
    if (attrLocation) {
      const raw = source.slice(attrLocation.startOffset, attrLocation.endOffset);
      const quoted = /^([^=]+?\s*=\s*)(["'])([\s\S]*)\2$/.exec(raw);
      const replacement =
        value === undefined
          ? ""
          : quoted
            ? `${quoted[1]}${quoted[2]}${escapeAttribute(value, quoted[2])}${quoted[2]}`
            : `${name}="${escapeAttribute(value)}"`;
      edits.push({
        start: attrLocation.startOffset,
        end: attrLocation.endOffset,
        value: replacement,
      });
    } else if (value !== undefined) {
      const end =
        location.startTag.endOffset - (source[location.startTag.endOffset - 2] === "/" ? 2 : 1);
      edits.push({ start: end, end, value: ` ${name}="${escapeAttribute(value)}"` });
    }
  }
  return edits;
}
function alignedStyle(style: string, alignment: string): string {
  return /(?:^|;)\s*text-align\s*:/i.test(style)
    ? style.replace(/((?:^|;)\s*text-align\s*:)\s*[^;]*/i, `$1 ${alignment}`)
    : `${style}${style && !style.trimEnd().endsWith(";") ? ";" : ""}${style ? " " : ""}text-align: ${alignment}`;
}

function opening(source: string, original: Element, target: Element): string {
  const location = original.sourceCodeLocation;
  if (!location?.startTag) throw new Error("Source element has no explicit opening tag.");
  const values = new Map<string, string | undefined>(
    target.attrs.map((attr) => [attr.name, attr.value]),
  );
  const semantic =
    original.tagName === "a"
      ? ["href", "title"]
      : original.tagName === "img"
        ? ["src", "alt", "title"]
        : original.tagName === "ol"
          ? ["start"]
          : [];
  for (const name of semantic) if (!values.has(name)) values.set(name, undefined);
  for (const url of ["href", "src"]) {
    if (!semantic.includes(url)) continue;
    const oldValue = original.attrs.find((attr) => attr.name === url)?.value;
    const nextValue = values.get(url);
    if (oldValue === nextValue) continue;
    if (original.attrs.some((attr) => attr.name === `data-mce-${url}`))
      values.set(`data-mce-${url}`, nextValue);
    for (const attr of original.attrs) {
      if (/^data-(?:linked-resource|attachment|resource)-/.test(attr.name))
        values.set(attr.name, undefined);
    }
  }
  const alignment = values.get("align");
  if (["th", "td"].includes(original.tagName) && alignment) {
    for (const name of ["style", "data-mce-style"]) {
      const originalStyle = original.attrs.find((attr) => attr.name === name);
      if (name === "style" || originalStyle)
        values.set(name, alignedStyle(originalStyle?.value ?? "", alignment));
    }
  }
  const edits = attributeEdits(source, original, values);
  if (original.tagName !== target.tagName) {
    edits.push({
      start: location.startTag.startOffset + 1,
      end: location.startTag.startOffset + 1 + original.tagName.length,
      value: target.tagName,
    });
  }
  return spliceSource(source, edits, location.startTag.startOffset, location.startTag.endOffset);
}

interface RenderContext {
  source: string;
  used: Set<Node>;
}
function consume(node: Node, context: RenderContext): void {
  context.used.add(node);
  children(node).forEach((child) => consume(child, context));
}
function plain(node: Node): boolean {
  return (
    textNode(node) || (element(node) && node.tagName === "span" && children(node).every(plain))
  );
}
function frontier(node: Node): Node[] {
  return children(node).flatMap((child) =>
    element(child) && child.tagName === "span" && !plain(child) ? frontier(child) : [child],
  );
}
function renderText(value: string, candidates: Node[], context: RenderContext): string {
  const matches: { node: Node; value: string; index: number }[] = [];
  const visit = (node: Node): void => {
    if (context.used.has(node)) return;
    if (!plain(node)) {
      children(node).forEach(visit);
      return;
    }
    if (!node.sourceCodeLocation) return;
    const text = visual(node);
    if (!text || !text.trim()) return;
    const index = value.indexOf(text);
    if (index >= 0) matches.push({ node, value: text, index });
  };
  candidates.forEach(visit);
  matches.sort((a, b) => a.index - b.index);
  let cursor = 0;
  const parts: string[] = [];
  for (const match of matches) {
    if (match.index < cursor) continue;
    parts.push(escapeText(value.slice(cursor, match.index)), rawSource(context.source, match.node));
    cursor = match.index + match.value.length;
    consume(match.node, context);
  }
  parts.push(escapeText(value.slice(cursor)));
  return parts.join("");
}
function renderChildren(
  candidates: Node[],
  targets: Tree.ChildNode[],
  context: RenderContext,
): string {
  const originalElements = candidates.filter(
    (node): node is Element => element(node) && !plain(node) && !context.used.has(node),
  );
  const targetElements = targets.filter(element);
  const mapping = align(
    originalElements.map(sourceSignature),
    targetElements.map(markdownSignature),
  );
  const matched = new Map<Element, Element>();
  targetElements.forEach((target, index) => {
    const originalIndex = mapping[index];
    if (originalIndex !== undefined && compatible(originalElements[originalIndex], target))
      matched.set(target, originalElements[originalIndex]);
  });
  const reserved = new Set(matched.values());
  const available = candidates.filter(
    (candidate) => !element(candidate) || !reserved.has(candidate),
  );
  return targets
    .map((target) => {
      if (textNode(target)) return renderText(target.value, available, context);
      if (!element(target)) return serializeOuter(target);
      const original = matched.get(target);
      if (original) return renderElement(original, target, context);
      return renderNewContent(target, available, context);
    })
    .join("");
}
function generatedOpening(node: Element): string {
  const empty = serializeOuter({ ...node, childNodes: [] });
  const closing = `</${node.tagName}>`;
  return empty.endsWith(closing) ? empty.slice(0, -closing.length) : empty;
}
function renderNewContent(target: Element, candidates: Node[], context: RenderContext): string {
  if (!target.childNodes.length) return serializeOuter(target);
  return `${generatedOpening(target)}${renderChildren(candidates, target.childNodes, context)}</${target.tagName}>`;
}
function renderElement(original: Element, target: Element, context: RenderContext): string {
  const containsUsedSource = (node: Node): boolean => {
    if (context.used.has(node)) return true;
    return children(node).some(containsUsedSource);
  };
  if (
    !containsUsedSource(original) &&
    !target.attrs.some((attr) => attr.name === "align") &&
    sourceSignature(original) === markdownSignature(target)
  ) {
    consume(original, context);
    return rawSource(context.source, original);
  }
  context.used.add(original);
  const location = original.sourceCodeLocation;
  if (!location?.startTag) return serializeOuter(target);
  const start = opening(context.source, original, target);
  if (["area", "br", "col", "hr", "img", "wbr"].includes(target.tagName)) return start;
  const significant = original.childNodes.filter((child) => !textNode(child) || child.value.trim());
  // Transparent editor wrappers are absent from the projection, not a request to discard styling.
  const wrapper =
    significant.length === 1 &&
    element(significant[0]) &&
    (significant[0].tagName === "span" ||
      (["td", "th"].includes(original.tagName) &&
        significant[0].tagName === "p" &&
        !target.childNodes.some((child) => element(child) && child.tagName === "p")))
      ? significant[0]
      : undefined;
  if (wrapper) context.used.add(wrapper);
  const content = wrapper
    ? `${rawOpening(context.source, wrapper)}${renderChildren(frontier(wrapper), target.childNodes, context)}${rawClosing(context.source, wrapper)}`
    : renderChildren(frontier(original), target.childNodes, context);
  const end =
    original.tagName === target.tagName
      ? rawClosing(context.source, original)
      : `</${target.tagName}>`;
  return `${start}${content}${end}`;
}
function rawOpening(source: string, node: Element): string {
  const location = node.sourceCodeLocation;
  return location?.startTag
    ? source.slice(location.startTag.startOffset, location.startTag.endOffset)
    : `<${node.tagName}>`;
}
function rawClosing(source: string, node: Element): string {
  const location = node.sourceCodeLocation;
  return location?.endTag
    ? source.slice(location.endTag.startOffset, location.endTag.endOffset)
    : `</${node.tagName}>`;
}

export function renderSourceElement(source: string, original: Element, target: Element): string {
  return renderElement(original, target, { source, used: new Set() });
}

function cells(row: Element): Element[] {
  return row.childNodes.filter(
    (node): node is Element => element(node) && ["th", "td"].includes(node.tagName),
  );
}
function clonedElement(template: Element | undefined, target: Element): Element {
  const attrs = [
    ...(template?.attrs.filter((attr) => ["class", "style"].includes(attr.name)) ?? []),
    ...target.attrs.filter(
      (attr) =>
        !template?.attrs.some(
          (original) => original.name === attr.name && ["class", "style"].includes(attr.name),
        ),
    ),
  ];
  const alignment = target.attrs.find((attr) => attr.name === "align")?.value;
  if (["th", "td"].includes(target.tagName) && alignment) {
    const index = attrs.findIndex((attr) => attr.name === "style");
    const style = alignedStyle(index < 0 ? "" : attrs[index].value, alignment);
    if (index < 0) attrs.push({ name: "style", value: style });
    else attrs[index] = { ...attrs[index], value: style };
  }
  return { ...target, attrs };
}

function renderTable(
  source: string,
  original: Element,
  before: Element,
  after: Element,
  renderCell: (original: Element, before: Element, after: Element) => string,
): string {
  const originalRows = descendants(original, "tr");
  const beforeRows = descendants(before, "tr");
  const afterRows = descendants(after, "tr");
  if (!beforeRows.length || !afterRows.length || originalRows.length !== beforeRows.length)
    throw new Error("Table rows do not match their original mapping.");
  const originalCells = originalRows.map(cells);
  const beforeCells = beforeRows.map(cells);
  const afterCells = afterRows.map(cells);
  if (originalCells.some((row, index) => row.length !== beforeCells[index].length))
    throw new Error("Table cells do not match their original mapping.");
  const nativeTdHeader =
    originalCells[0].every((cell) => cell.tagName === "td") &&
    beforeCells[0].every((cell) => cell.tagName === "th");
  const columns = align(
    beforeCells[0].map(markdownSignature),
    afterCells[0].map(markdownSignature),
  );
  const sameColumns =
    columns.length === beforeCells[0].length &&
    columns.every((index, position) => index === position);
  const retainedColumns = columns.flatMap((oldIndex, newIndex) =>
    oldIndex === undefined ? [] : [{ oldIndex, newIndex }],
  );
  const oldKeys = beforeCells
    .slice(1)
    .map((row) =>
      JSON.stringify(retainedColumns.map(({ oldIndex }) => markdownSignature(row[oldIndex]))),
    );
  const newKeys = afterCells
    .slice(1)
    .map((row) =>
      JSON.stringify(retainedColumns.map(({ newIndex }) => markdownSignature(row[newIndex]))),
    );
  const rows: (number | undefined)[] = [
    0,
    ...align(oldKeys, newKeys).map((index) => (index === undefined ? undefined : index + 1)),
  ];
  const renderedRows = afterRows.map((row, rowIndex) => {
    const oldRow = rows[rowIndex];
    const cellHtml = afterCells[rowIndex].map((cell, columnIndex) => {
      const oldColumn = columns[columnIndex];
      if (oldRow !== undefined && oldColumn !== undefined) {
        return renderCell(originalCells[oldRow][oldColumn], beforeCells[oldRow][oldColumn], cell);
      }
      const templateRow = oldRow ?? (rowIndex === 0 ? 0 : Math.min(1, originalRows.length - 1));
      const templateColumn =
        oldColumn ??
        columns
          .slice(0, columnIndex)
          .reverse()
          .find((value) => value !== undefined) ??
        0;
      const template = originalCells[templateRow][templateColumn];
      const target = nativeTdHeader && rowIndex === 0 ? { ...cell, tagName: "td" } : cell;
      const newCell = clonedElement(template, target);
      // New body cells inherit layout, never the header class or source identity.
      if (cell.tagName === "td" && template?.tagName === "th") {
        newCell.attrs = newCell.attrs.map((attr) =>
          attr.name === "class"
            ? { ...attr, value: attr.value.replace(/\bconfluenceTh\b/g, "confluenceTd") }
            : attr,
        );
      }
      return serializeOuter(newCell);
    });
    if (oldRow === undefined) {
      const template = originalRows[Math.min(1, originalRows.length - 1)];
      const newRow = clonedElement(template, row);
      return `${generatedOpening(newRow)}${cellHtml.join("")}</tr>`;
    }
    const originalRow = originalRows[oldRow];
    if (sameColumns) {
      const location = originalRow.sourceCodeLocation;
      if (!location) throw new Error("A table row has no source boundaries.");
      const cellEdits = originalCells[oldRow].map((cell, index) => {
        const bounds = cell.sourceCodeLocation;
        if (!bounds) throw new Error("A table cell has no source boundaries.");
        return { start: bounds.startOffset, end: bounds.endOffset, value: cellHtml[index] };
      });
      return spliceSource(source, cellEdits, location.startOffset, location.endOffset);
    }
    return `${opening(source, originalRow, row)}${cellHtml.join("")}${rawClosing(source, originalRow)}`;
  });
  const edits: SourceEdit[] = [];
  const replacements = new Map(
    rows.flatMap((oldIndex, newIndex) =>
      oldIndex === undefined ? [] : [[oldIndex, renderedRows[newIndex]] as const],
    ),
  );
  originalRows.forEach((row, index) => {
    const location = row.sourceCodeLocation;
    if (!location) throw new Error("A table row has no source boundaries.");
    edits.push({
      start: location.startOffset,
      end: location.endOffset,
      value: replacements.get(index) ?? "",
    });
  });
  const newRows = new Map<number, string[]>();
  afterRows.forEach((_, index) => {
    if (rows[index] !== undefined) return;
    const next = rows.slice(index + 1).find((oldIndex) => oldIndex !== undefined);
    const lastBody = originalRows[originalRows.length - 1];
    let offset: number;
    let html = renderedRows[index];
    if (next !== undefined) offset = originalRows[next].sourceCodeLocation!.startOffset;
    else if (
      lastBody.parentNode &&
      element(lastBody.parentNode) &&
      lastBody.parentNode.tagName === "thead"
    ) {
      const body = descendants(original, "tbody")[0];
      if (body?.sourceCodeLocation?.startTag) offset = body.sourceCodeLocation.startTag.endOffset;
      else {
        offset =
          lastBody.parentNode.sourceCodeLocation?.endOffset ??
          lastBody.sourceCodeLocation!.endOffset;
        html = `<tbody>${html}</tbody>`;
      }
    } else offset = lastBody.sourceCodeLocation!.endOffset;
    const insertions = newRows.get(offset) ?? [];
    insertions.push(html);
    newRows.set(offset, insertions);
  });
  newRows.forEach((values, offset) =>
    edits.push({ start: offset, end: offset, value: values.join("") }),
  );
  const columnGroups = sameColumns ? [] : descendants(original, "colgroup");
  for (const group of columnGroups) {
    const cols = group.childNodes.filter(
      (node): node is Element => element(node) && node.tagName === "col",
    );
    if (cols.length !== beforeCells[0].length) continue;
    const location = group.sourceCodeLocation;
    if (!location?.startTag || !location.endTag) continue;
    const value = columns
      .map((oldIndex, index) => {
        if (oldIndex !== undefined) return rawSource(source, cols[oldIndex]);
        const templateIndex =
          columns
            .slice(0, index)
            .reverse()
            .find((value) => value !== undefined) ?? 0;
        return serializeOuter(
          clonedElement(cols[templateIndex], { ...cols[templateIndex], attrs: [] }),
        );
      })
      .join("");
    edits.push({ start: location.startTag.endOffset, end: location.endTag.startOffset, value });
  }
  const location = original.sourceCodeLocation!;
  const mergedOpening = opening(source, original, after);
  if (location.startTag)
    edits.push({
      start: location.startTag.startOffset,
      end: location.startTag.endOffset,
      value: mergedOpening,
    });
  return spliceSource(source, edits, location.startOffset, location.endOffset);
}

export function renderChangedStructure(
  source: string,
  original: Element,
  before: Tree.DocumentFragment,
  after: Tree.DocumentFragment,
  renderCell: (original: Element, before: Element, after: Element) => string,
): string {
  const beforeNodes = before.childNodes.filter(element);
  const afterNodes = after.childNodes.filter(element);
  if (
    original.tagName === "table" &&
    beforeNodes.length === 1 &&
    afterNodes.length === 1 &&
    afterNodes[0].tagName === "table"
  ) {
    return renderTable(source, original, beforeNodes[0], afterNodes[0], renderCell);
  }
  const context: RenderContext = { source, used: new Set() };
  let restored = false;
  return after.childNodes
    .filter((node) => !textNode(node) || node.value.trim())
    .map((node) => {
      if (!restored && element(node) && compatible(original, node)) {
        restored = true;
        return renderElement(original, node, context);
      }
      return element(node)
        ? renderNewContent(node, frontier(original), context)
        : serializeOuter(node);
    })
    .join("");
}
