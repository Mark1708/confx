import { parseFragment } from "parse5";
import { MAX_ROUNDTRIP_TEXT_BYTES } from "./offline-roundtrip/contracts";

export interface StorageAttribute {
  name: string;
  value: string;
}

export interface StorageElement {
  type: "element";
  name: string;
  namespaceURI: string | null;
  attributes: StorageAttribute[];
  children: StorageNode[];
  start: number;
  openEnd: number;
  closeStart: number;
  end: number;
}

export interface StorageText {
  type: "text" | "cdata" | "comment";
  value: string;
  start: number;
  end: number;
}

export type StorageNode = StorageElement | StorageText;
export interface StorageDocument {
  children: StorageNode[];
}

const MAX_DEPTH = 256;
const MAX_NODES = 150_000;
const ACTIVE_ELEMENTS: Record<string, true> = {
  script: true,
  iframe: true,
  frame: true,
  frameset: true,
  object: true,
  embed: true,
  applet: true,
  form: true,
  input: true,
  button: true,
  select: true,
  textarea: true,
  keygen: true,
  base: true,
  link: true,
  meta: true,
  style: true,
  svg: true,
  math: true,
  noscript: true,
  xmp: true,
  plaintext: true,
};
const URL_ATTRIBUTES: Record<string, true> = {
  href: true,
  src: true,
  poster: true,
  cite: true,
  background: true,
  longdesc: true,
  action: true,
  formaction: true,
  data: true,
  codebase: true,
  profile: true,
  manifest: true,
  usemap: true,
  archive: true,
  "xlink:href": true,
  "data-mce-href": true,
  "data-mce-src": true,
  "data-mce-background": true,
};
const SAFE_SCHEMES: Record<string, true> = {
  "http:": true,
  "https:": true,
  "mailto:": true,
  "tel:": true,
};
const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
const VOID_ELEMENTS: Record<string, true> = {
  area: true,
  base: true,
  br: true,
  col: true,
  embed: true,
  hr: true,
  img: true,
  input: true,
  link: true,
  meta: true,
  param: true,
  source: true,
  track: true,
  wbr: true,
};

/** Check UTF-8 limits without first allocating an unbounded encoded copy. */
export function assertStorageText(
  value: unknown,
  label: string,
  limit = MAX_ROUNDTRIP_TEXT_BYTES,
): asserts value is string {
  if (typeof value !== "string") throw new Error(`${label} must contain text`);
  if (value.length > limit) throw new Error(`${label} exceeds its size limit`);
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new Error(`${label} contains non-lossless Unicode`);
      bytes += 4;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`${label} contains non-lossless Unicode`);
    } else bytes += 3;
    if (bytes > limit) throw new Error(`${label} exceeds its UTF-8 size limit`);
  }
}

function xmlCharacter(code: number): boolean {
  return (
    code === 9 ||
    code === 10 ||
    code === 13 ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

function assertSafeUrl(value: string, name: string): void {
  const compact = value.replace(/[\x00-\x20\x7f-\x9f]/g, "");
  const scheme = /^[a-z][a-z\d+.-]*:/i.exec(compact)?.[0].toLowerCase();
  if (scheme && SAFE_SCHEMES[scheme] !== true)
    throw new Error(`Unsafe URL in Storage attribute ${name}`);
}

// Match the editor source safety policy, but inspect XML nodes directly: macro CDATA is data,
// not HTML, and must never be fed into a permissive HTML parser or sanitizer.
function assertSafeElement(node: StorageElement): void {
  const tag = node.name.toLowerCase();
  const htmlNamespace =
    node.namespaceURI === null || node.namespaceURI === "http://www.w3.org/1999/xhtml";
  if (htmlNamespace && ACTIVE_ELEMENTS[tag.slice(tag.lastIndexOf(":") + 1)] === true) {
    throw new Error(`Unsafe active HTML in Storage: ${node.name}`);
  }
  for (const attribute of node.attributes) {
    const name = attribute.name.toLowerCase();
    if (name.startsWith("on") || name === "srcdoc" || name === "is") {
      throw new Error(`Unsafe active HTML attribute in Storage: ${name}`);
    }
    if (name === "style" || name === "data-mce-style") {
      if (
        /\\|\/\*|@|(?:expression|url)\s*\(|(?:^|[;\s])(?:behavior|-moz-binding)\s*:/i.test(
          attribute.value,
        )
      ) {
        throw new Error("Unsafe active CSS in Storage");
      }
    } else if (name === "srcset" || name === "imagesrcset") {
      for (const candidate of attribute.value.split(","))
        assertSafeUrl(candidate.trim().split(/\s+/)[0] ?? "", name);
    } else if (name === "ping") {
      for (const url of attribute.value.trim().split(/\s+/)) assertSafeUrl(url, name);
    } else if (
      URL_ATTRIBUTES[name] === true ||
      URL_ATTRIBUTES[name.slice(name.lastIndexOf(":") + 1)] === true ||
      (tag === "ri:url" && name === "ri:value")
    )
      assertSafeUrl(attribute.value, name);
  }
}

/**
 * A source-range XML tokenizer paired with the browser's namespace-aware XML validator.
 * No document serialization is used. Only HTML named entity references are expanded for
 * validation; their exact original spelling and all source offsets remain authoritative.
 */
export function parseStorageXml(source: string): StorageDocument {
  assertStorageText(source, "Storage source");
  const document: StorageDocument = { children: [] };
  const stack: StorageElement[] = [];
  const elements: StorageElement[] = [];
  const entityCache = new Map<string, string>();
  const validationEdits: { start: number; end: number; value: string }[] = [];
  let offset = 0;
  let nodes = 0;
  function fail(message: string): never {
    throw new Error(`Invalid Storage XML: ${message}`);
  }
  const append = (node: StorageNode): void => {
    if (++nodes > MAX_NODES) fail("source exceeds the node limit");
    (stack[stack.length - 1]?.children ?? document.children).push(node);
  };
  const space = (): void => {
    while (offset < source.length && /[\t\n\r ]/.test(source[offset])) offset += 1;
  };
  const name = (): string => {
    const start = offset;
    while (offset < source.length && !/[\t\n\r \/<>=?'"!\[\]]/.test(source[offset])) offset += 1;
    if (start === offset) fail("expected an XML name");
    return source.slice(start, offset);
  };
  const decode = (start: number, end: number): string => {
    const parts: string[] = [];
    let cursor = start;
    let plain = start;
    while (cursor < end) {
      const code = source.codePointAt(cursor)!;
      if (!xmlCharacter(code)) fail("invalid XML character");
      if (source[cursor] !== "&") {
        cursor += code > 0xffff ? 2 : 1;
        continue;
      }
      parts.push(source.slice(plain, cursor));
      const semicolon = source.indexOf(";", cursor + 1);
      if (semicolon === -1 || semicolon >= end) fail("invalid entity reference");
      const entity = source.slice(cursor + 1, semicolon);
      let value: string;
      if (entity.startsWith("#")) {
        if (!/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(entity)) fail("invalid numeric entity");
        const codepoint =
          entity[1] === "x"
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10);
        if (!xmlCharacter(codepoint)) fail("invalid entity codepoint");
        value = String.fromCodePoint(codepoint);
      } else if (Object.hasOwn(XML_ENTITIES, entity)) value = XML_ENTITIES[entity];
      else {
        const cached = entityCache.get(entity);
        if (cached !== undefined) value = cached;
        else {
          if (entity.length > 64 || !/^[A-Za-z][A-Za-z0-9]+$/.test(entity))
            fail("unknown entity reference");
          const spelling = `&${entity};`;
          // Attribute context forbids HTML's legacy partial matches (&notit; must not
          // silently become "¬it;"). Only complete semicolon-terminated names count.
          const parsed = parseFragment(`<span data-confx="${spelling}"></span>`);
          const child = parsed.childNodes[0];
          const decoded =
            child && "attrs" in child
              ? child.attrs.find((attribute) => attribute.name === "data-confx")?.value
              : undefined;
          if (decoded === undefined || decoded === spelling) fail(`unknown named entity ${entity}`);
          value = decoded;
          entityCache.set(entity, value);
        }
        const numeric = Array.from(value, (character) => `&#${character.codePointAt(0)};`).join("");
        validationEdits.push({ start: cursor, end: semicolon + 1, value: numeric });
      }
      parts.push(value);
      cursor = semicolon + 1;
      plain = cursor;
    }
    if (!parts.length) return source.slice(start, end);
    parts.push(source.slice(plain, end));
    return parts.join("");
  };
  while (offset < source.length) {
    const start = offset;
    if (source[offset] !== "<") {
      const next = source.indexOf("<", offset);
      offset = next === -1 ? source.length : next;
      const value = decode(start, offset);
      if (source.slice(start, offset).includes("]]>")) fail("CDATA terminator in text");
      append({ type: "text", start, end: offset, value });
      continue;
    }
    if (source.startsWith("<!--", offset)) {
      const end = source.indexOf("-->", offset + 4);
      if (end === -1) fail("unclosed comment");
      const value = source.slice(offset + 4, end);
      if (value.includes("--") || value.endsWith("-")) fail("invalid XML comment");
      offset = end + 3;
      append({ type: "comment", start, end: offset, value });
      continue;
    }
    if (source.startsWith("<![CDATA[", offset)) {
      const end = source.indexOf("]]>", offset + 9);
      if (end === -1) fail("unclosed CDATA");
      const value = source.slice(offset + 9, end);
      offset = end + 3;
      append({ type: "cdata", start, end: offset, value });
      continue;
    }
    if (source.startsWith("<!", offset) || source.startsWith("<?", offset)) {
      fail("DTDs, declarations and processing instructions are not allowed");
    }
    if (source.startsWith("</", offset)) {
      offset += 2;
      const closingName = name();
      space();
      if (source[offset] !== ">") fail("invalid closing tag");
      offset += 1;
      const node = stack.pop();
      if (!node || node.name !== closingName) fail("mismatched closing tag");
      node.closeStart = start;
      node.end = offset;
      continue;
    }
    offset += 1;
    const tag = name();
    const attributes: StorageAttribute[] = [];
    const seen = new Set<string>();
    let selfClosing = false;
    while (offset < source.length) {
      const beforeSpace = offset;
      space();
      if (source.startsWith("/>", offset)) {
        selfClosing = true;
        offset += 2;
        break;
      }
      if (source[offset] === ">") {
        offset += 1;
        break;
      }
      if (offset === beforeSpace) fail("attributes must be separated by whitespace");
      const attributeName = name();
      if (seen.has(attributeName)) fail("duplicate attribute");
      seen.add(attributeName);
      space();
      if (source[offset] !== "=") fail("an attribute requires a value");
      offset += 1;
      space();
      const quote = source[offset];
      if (quote !== '"' && quote !== "'") fail("an attribute requires quotes");
      offset += 1;
      const valueStart = offset;
      const valueEnd = source.indexOf(quote, offset);
      if (valueEnd === -1) fail("unclosed attribute value");
      if (source.slice(valueStart, valueEnd).includes("<")) fail("unescaped markup in attribute");
      const value = decode(valueStart, valueEnd);
      attributes.push({ name: attributeName, value });
      offset = valueEnd + 1;
    }
    if (source[offset - 1] !== ">") fail("unclosed start tag");
    const node: StorageElement = {
      type: "element",
      name: tag,
      namespaceURI: null,
      attributes,
      children: [],
      start,
      openEnd: offset,
      closeStart: offset,
      end: offset,
    };
    append(node);
    elements.push(node);
    if (!selfClosing) {
      if (stack.length >= MAX_DEPTH) fail("source exceeds the nesting limit");
      stack.push(node);
    }
  }
  if (stack.length) fail("unclosed element");
  let previous = 0;
  const validated: string[] = [];
  for (const edit of validationEdits) {
    validated.push(source.slice(previous, edit.start), edit.value);
    previous = edit.end;
  }
  validated.push(source.slice(previous));
  const xml = new DOMParser().parseFromString(
    '<confx-storage-root xmlns:ac="http://atlassian.com/content" xmlns:ri="http://atlassian.com/resource/identifier">' +
      validated.join("") +
      "</confx-storage-root>",
    "application/xml",
  );
  if (
    xml.getElementsByTagNameNS(
      "http://www.mozilla.org/newlayout/xml/parsererror.xml",
      "parsererror",
    ).length ||
    xml.documentElement.localName !== "confx-storage-root"
  ) {
    fail("malformed or unbound XML structure");
  }
  let elementIndex = 0;
  for (const node of xml.getElementsByTagName("*")) {
    if (
      node.namespaceURI === "http://www.w3.org/2000/svg" ||
      node.namespaceURI === "http://www.w3.org/1998/Math/MathML"
    ) {
      throw new Error("Unsafe active SVG or MathML namespace in Storage");
    }
    if (node !== xml.documentElement) {
      const original = elements[elementIndex++];
      if (!original || original.name !== node.tagName)
        fail("XML source and validated structure disagree");
      original.namespaceURI = node.namespaceURI;
      assertSafeElement(original);
    }
  }
  if (elementIndex !== elements.length) fail("XML source and validated structure disagree");
  return document;
}

/** XML identity retains every attribute, comment and text codepoint, including whitespace. */
export function storageXmlIdentity(source: string): string {
  const document = parseStorageXml(source);
  type Identity = string | [string, unknown, unknown];
  const children = (nodes: StorageNode[]): Identity[] => {
    const result: Identity[] = [];
    for (const node of nodes) {
      if (node.type === "element")
        result.push([
          node.name,
          node.attributes
            .map(({ name, value }) => [name, value])
            .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
          children(node.children),
        ]);
      else if (node.type === "comment") result.push(["#comment", node.value, []]);
      else {
        const last = result[result.length - 1];
        if (typeof last === "string") result[result.length - 1] = last + node.value;
        else if (node.value) result.push(node.value);
      }
    }
    return result;
  };
  return JSON.stringify(children(document.children));
}

/**
 * The shared Markdown renderer emits HTML void tags. Close only those lexical start tags;
 * never serialize the document, or normalize already valid source tags/attributes/entities.
 */
export function closeStorageVoidTags(html: string): string {
  const insertions: number[] = [];
  let offset = 0;
  while (offset < html.length) {
    if (html.startsWith("<!--", offset)) {
      const end = html.indexOf("-->", offset + 4);
      if (end === -1) throw new Error("Unclosed generated HTML comment");
      offset = end + 3;
      continue;
    }
    if (html[offset] !== "<") {
      offset += 1;
      continue;
    }
    const start = offset++;
    if (html[offset] === "/") {
      offset = html.indexOf(">", offset) + 1;
      if (!offset) throw new Error("Unclosed generated tag");
      continue;
    }
    const nameStart = offset;
    while (offset < html.length && !/[\s/>]/.test(html[offset])) offset += 1;
    const tag = html.slice(nameStart, offset);
    let quote: string | undefined;
    while (offset < html.length) {
      const character = html[offset];
      if (quote) {
        if (character === quote) quote = undefined;
      } else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
      offset += 1;
    }
    if (offset === html.length) throw new Error("Unclosed generated HTML start tag");
    if (
      VOID_ELEMENTS[tag] === true &&
      html[offset - 1] !== "/" &&
      !html.startsWith(`</${tag}>`, offset + 1)
    )
      insertions.push(offset);
    offset += 1;
    if (offset <= start) throw new Error("Invalid generated HTML");
  }
  let previous = 0;
  const result: string[] = [];
  for (const insertion of insertions) {
    result.push(html.slice(previous, insertion), "/");
    previous = insertion;
  }
  result.push(html.slice(previous));
  return result.join("");
}
