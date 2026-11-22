import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { parseFragment, Tokenizer } from "parse5";

// This dev-only public-format codec deliberately has no dependency on Confx renderers,
// identities, source mappers or editor bridges. Its private markers belong to the sandbox.
const window = new JSDOM("").window;
const AC = "http://atlassian.com/content";
const RI = "http://atlassian.com/resource/identifier";
const HTML = "http://www.w3.org/1999/xhtml";
const XMLNS = "http://www.w3.org/2000/xmlns/";
const MAX_BYTES = 1536 * 1024;
const MAX_DEPTH = 128;
const MAX_NODES = 40_000;
const HTML_TAGS = new Set(
  "p h1 h2 h3 h4 h5 h6 div span strong b em i u s del strike sub sup code pre a br hr ul ol li blockquote table caption thead tbody tfoot tr th td colgroup col img figure figcaption dl dt dd abbr kbd samp mark small".split(
    " ",
  ),
);
const VOID_TAGS = new Set(["br", "hr", "img", "col"]);
const AC_TAGS = new Set(
  "structured-macro macro parameter rich-text-body plain-text-body link link-body plain-text-link-body image caption task-list task task-id task-status task-body layout layout-section layout-cell emoticon placeholder".split(
    " ",
  ),
);
const RI_TAGS = new Set(["page", "attachment", "url", "user", "space", "content-entity"]);
const LAYOUT_CELLS = {
  single: 1,
  two_equal: 2,
  two_left_sidebar: 2,
  two_right_sidebar: 2,
  three_equal: 3,
  three_with_sidebars: 3,
};
const NATIVE_ATTRIBUTES = new Set([
  "data-mce-style",
  "data-mce-src",
  "data-mce-href",
  "data-mce-selected",
  "data-mce-bogus",
  "data-mce-last",
  "data-mce-first",
  "data-mce-tabindex",
]);
const PRIVATE_ATTRIBUTES = new Set([
  "data-sandbox-kind",
  "data-sandbox-storage",
  "data-sandbox-digest",
  "data-sandbox-attrs",
]);

export class CodecError extends Error {
  constructor(message) {
    super(message);
    this.name = "CodecError";
  }
}

function fail(message) {
  throw new CodecError(message);
}

function bounded(source) {
  if (typeof source !== "string") fail("Invalid source: expected text");
  if (source.length > MAX_BYTES || Buffer.byteLength(source, "utf8") > MAX_BYTES)
    fail("Source exceeds the sandbox size limit");
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = source.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail("Invalid non-lossless Unicode source");
      index += 1;
    } else if ((code >= 0xdc00 && code <= 0xdfff) || (code < 32 && ![9, 10, 13].includes(code)))
      fail("Invalid source character");
  }
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function textXml(value) {
  return escapeHtml(value)
    .replace(/\u00a0/g, "&#160;")
    .replace(/\r/g, "&#13;");
}

function attrXml(value) {
  return textXml(value).replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");
}

function attributeString(attributes) {
  return attributes.map(([name, value]) => ` ${name}="${attrXml(value)}"`).join("");
}

function safeUrl(value, resource = false) {
  const compact = value.replace(/[\x00-\x20\x7f-\x9f]/g, "");
  const scheme = /^[a-z][a-z\d+.-]*:/i.exec(compact)?.[0].toLowerCase();
  if (scheme && !["http:", "https:", "mailto:", "tel:"].includes(scheme)) fail("Unsafe URL scheme");
  if (resource && (scheme || compact.startsWith("//") || compact.includes("\\")))
    fail("Only local sandbox resource URLs are supported");
}

function safeAttributes(name, attributes, editor = false) {
  for (const [rawName, value] of attributes) {
    const lower = rawName.toLowerCase();
    const local = lower.split(":").at(-1);
    if (local.startsWith("on") || ["srcdoc", "is", "srcset", "ping"].includes(local))
      fail(`Unsafe or unsupported attribute: ${rawName}`);
    if (lower === "style" || lower === "data-mce-style") {
      if (/\\|\/\*|@|(?:expression|url)\s*\(|(?:^|[;\s])(?:behavior|-moz-binding)\s*:/i.test(value))
        fail("Unsafe active CSS");
    }
    if (
      [
        "href",
        "src",
        "poster",
        "cite",
        "background",
        "action",
        "data-mce-href",
        "data-mce-src",
      ].includes(lower)
    )
      safeUrl(value, ["src", "poster", "background", "data-mce-src"].includes(lower));
    if (name === "ri:url" && lower === "ri:value") safeUrl(value);
    if (!editor && lower.startsWith("data-sandbox-"))
      fail("Unsupported private editor metadata in Storage");
    if (editor && lower.startsWith("data-sandbox-") && !PRIVATE_ATTRIBUTES.has(lower))
      fail("Unsupported sandbox metadata");
    if (editor && lower.startsWith("data-mce-") && !NATIVE_ATTRIBUTES.has(lower))
      fail(`Unsupported native editor metadata: ${rawName}`);
  }
}

function xmlAttributes(node) {
  return [...node.attributes].map((attribute) => [attribute.name, attribute.value]);
}

function parseStorage(source) {
  bounded(source);
  if (/<!DOCTYPE|<!ENTITY|<\?/i.test(source))
    fail("Unsupported XML doctype or processing instruction");
  const document = new window.DOMParser().parseFromString(
    `<sandbox-root xmlns:ac="${AC}" xmlns:ri="${RI}">${source}</sandbox-root>`,
    "text/xml",
  );
  if (
    document.getElementsByTagName("parsererror").length ||
    document.documentElement.nodeName !== "sandbox-root"
  )
    fail("Invalid Storage XML");
  let count = 0;
  const visit = (node, depth) => {
    if (++count > MAX_NODES || depth > MAX_DEPTH) fail("Storage exceeds node or depth limit");
    if (node.nodeType === 3 || node.nodeType === 4 || node.nodeType === 8) return;
    if (node.nodeType !== 1) fail("Unsupported XML node");
    const namespace = node.namespaceURI;
    if (namespace === AC && node.prefix === "ac") {
      if (!AC_TAGS.has(node.localName))
        fail(`Unsupported Confluence Storage tag: ${node.nodeName}`);
    } else if (namespace === RI && node.prefix === "ri") {
      if (!RI_TAGS.has(node.localName)) fail(`Unsupported resource tag: ${node.nodeName}`);
    } else if ((namespace === null || namespace === HTML) && !node.prefix) {
      if (!HTML_TAGS.has(node.nodeName)) fail(`Unsafe or unsupported HTML tag: ${node.nodeName}`);
    } else fail("Unsupported Storage namespace");
    for (const attribute of node.attributes) {
      if (attribute.namespaceURI === XMLNS) {
        const expected = { ac: AC, ri: RI, xmlns: HTML }[attribute.localName];
        if (attribute.value !== expected) fail("Unsupported namespace declaration");
      } else if (attribute.namespaceURI && ![AC, RI].includes(attribute.namespaceURI))
        fail("Unsupported attribute namespace");
    }
    safeAttributes(node.nodeName, xmlAttributes(node));
    if (VOID_TAGS.has(node.nodeName) && node.childNodes.length)
      fail("Unsupported content in void HTML element");
    for (const child of node.childNodes) visit(child, depth + 1);
  };
  for (const node of document.documentElement.childNodes) visit(node, 0);
  return [...document.documentElement.childNodes];
}

function serializeXml(node) {
  if (node.nodeType === 3) return textXml(node.nodeValue);
  if (node.nodeType === 4) return `<![CDATA[${node.nodeValue}]]>`;
  if (node.nodeType === 8) return `<!--${node.nodeValue}-->`;
  const name = node.nodeName;
  const attrs = attributeString(xmlAttributes(node));
  if (!node.childNodes.length && (VOID_TAGS.has(name) || name.startsWith("ri:")))
    return `<${name}${attrs}/>`;
  return `<${name}${attrs}>${[...node.childNodes].map(serializeXml).join("")}</${name}>`;
}

/** Canonical fixture baseline: no implicit HTML repairs, no removed text/attributes. */
export function canonicalStorage(source) {
  return parseStorage(source).map(serializeXml).join("");
}

const encode = (value) => Buffer.from(value, "utf8").toString("base64url");
const digest = (value) => createHash("sha256").update(value).digest("hex");
function decode(value) {
  if (typeof value !== "string" || !/^[A-Za-z\d_-]+$/.test(value))
    fail("Invalid opaque metadata encoding");
  const result = Buffer.from(value, "base64url").toString("utf8");
  if (encode(result) !== value) fail("Invalid noncanonical opaque metadata");
  return result;
}

function opaqueLabel(node) {
  if (["ac:structured-macro", "ac:macro"].includes(node.nodeName))
    return `Protected macro: ${node.getAttribute("ac:name") || "unnamed"}`;
  if (node.nodeName === "ac:task-list") return "Protected resource: task-list";
  return `Protected resource: ${node.nodeName}`;
}

function opaqueEditor(node, inline) {
  const source = serializeXml(node);
  const name = node.getAttribute("ac:name") || node.localName;
  const tag = inline ? "span" : "div";
  return `<${tag} class="sandbox-opaque mceNonEditable" contenteditable="false" data-sandbox-kind="opaque" data-sandbox-storage="${encode(source)}" data-sandbox-digest="${digest(source)}" data-macro-name="${escapeHtml(name)}">${escapeHtml(opaqueLabel(node))}</${tag}>`;
}

function elementChildren(node) {
  return [...node.childNodes].filter((child) => child.nodeType === 1);
}

function assertLayout(node) {
  if (node.nodeName === "ac:layout") {
    const sections = elementChildren(node);
    if (
      !sections.length ||
      sections.some((child) => child.nodeName !== "ac:layout-section") ||
      [...node.childNodes].some(
        (child) => child.nodeType !== 1 && (child.nodeType !== 3 || child.nodeValue.trim()),
      )
    )
      fail("Unsupported layout root structure");
    for (const section of sections) assertLayout(section);
  } else if (node.nodeName === "ac:layout-section") {
    const count = LAYOUT_CELLS[node.getAttribute("ac:type")];
    const cells = elementChildren(node);
    if (
      !count ||
      cells.length !== count ||
      cells.some((child) => child.nodeName !== "ac:layout-cell") ||
      [...node.childNodes].some(
        (child) => child.nodeType !== 1 && (child.nodeType !== 3 || child.nodeValue.trim()),
      )
    )
      fail("Unsupported layout type or cell count");
  }
}

function layoutMetadata(node) {
  return ` data-sandbox-kind="${node.localName}" data-sandbox-attrs="${encode(JSON.stringify(xmlAttributes(node)))}"`;
}

function editorNode(node, parentName = "") {
  if (node.nodeType !== 1) return serializeXml(node);
  const name = node.nodeName;
  if (name === "ac:layout") {
    assertLayout(node);
    return `<div class="contentLayout2"${layoutMetadata(node)}>${[...node.childNodes].map((child) => editorNode(child, name)).join("")}</div>`;
  }
  if (name === "ac:layout-section") {
    if (parentName !== "ac:layout") fail("Unsupported detached layout section");
    return `<div class="columnLayout" data-layout="${escapeHtml(node.getAttribute("ac:type"))}"${layoutMetadata(node)}>${[...node.childNodes].map((child) => editorNode(child, name)).join("")}</div>`;
  }
  if (name === "ac:layout-cell") {
    if (parentName !== "ac:layout-section") fail("Unsupported detached layout cell");
    return `<div class="cell"${layoutMetadata(node)}><div class="innerCell">${[...node.childNodes].map((child) => editorNode(child, name)).join("")}</div></div>`;
  }
  if (node.namespaceURI === AC || node.namespaceURI === RI)
    return opaqueEditor(
      node,
      [
        "p",
        "a",
        "span",
        "strong",
        "em",
        "li",
        "td",
        "th",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
      ].includes(parentName),
    );
  const attrs = attributeString(xmlAttributes(node));
  if (VOID_TAGS.has(name)) return `<${name}${attrs}>`;
  return `<${name}${attrs}>${[...node.childNodes].map((child) => editorNode(child, name)).join("")}</${name}>`;
}

export function storageToEditor(source) {
  return parseStorage(source)
    .map((node) => editorNode(node))
    .join("");
}

function htmlAttributePairs(node) {
  return node.attrs.map(({ name, value, prefix }) => [prefix ? `${prefix}:${name}` : name, value]);
}
const htmlAttr = (node, name) => node.attrs?.find((attribute) => attribute.name === name)?.value;
const hasClass = (node, name) => (htmlAttr(node, "class") || "").split(/\s+/).includes(name);

function validateEditorTokens(source) {
  const tokenizer = new Tokenizer(
    {},
    {
      onStartTag(token) {
        if (!HTML_TAGS.has(token.tagName))
          fail(`Unsafe or unsupported editor tag: ${token.tagName}`);
        safeAttributes(
          token.tagName,
          token.attrs.map(({ name, value }) => [name, value]),
          true,
        );
      },
      onEndTag(token) {
        if (!HTML_TAGS.has(token.tagName)) fail(`Unsupported editor closing tag: ${token.tagName}`);
      },
      onDoctype() {
        fail("Unsupported editor doctype");
      },
      onNullCharacter() {
        fail("Unsafe null character in editor HTML");
      },
      onComment() {},
      onEof() {},
      onCharacter() {},
      onWhitespaceCharacter() {},
    },
  );
  tokenizer.write(source, true);
}

function restoreOpaque(node) {
  const source = decode(htmlAttr(node, "data-sandbox-storage"));
  if (htmlAttr(node, "data-sandbox-digest") !== digest(source))
    fail("Invalid opaque metadata digest");
  const roots = parseStorage(source);
  if (
    roots.length !== 1 ||
    roots[0].nodeType !== 1 ||
    ![AC, RI].includes(roots[0].namespaceURI) ||
    roots[0].nodeName.startsWith("ac:layout")
  )
    fail("Invalid protected Storage payload");
  const original = roots[0];
  const label = opaqueLabel(original);
  const children = node.childNodes || [];
  // Native TinyMCE serialization omits contenteditable on mceNonEditable placeholders.
  const editable = htmlAttr(node, "contenteditable");
  if (
    children.some((child) => child.nodeName !== "#text") ||
    children.map((child) => child.value).join("") !== label ||
    (editable !== undefined && editable !== "false") ||
    !hasClass(node, "mceNonEditable") ||
    htmlAttr(node, "data-macro-name") !== (original.getAttribute("ac:name") || original.localName)
  )
    fail("Unsupported edit to protected opaque region");
  const allowed = new Set([
    "class",
    "contenteditable",
    "data-sandbox-kind",
    "data-sandbox-storage",
    "data-sandbox-digest",
    "data-macro-name",
    ...NATIVE_ATTRIBUTES,
  ]);
  if (node.attrs.some(({ name }) => !allowed.has(name)))
    fail("Unsupported protected placeholder attribute");
  return source;
}

function restoreLayout(node, kind, parentKind, convert) {
  if (node.tagName !== "div") fail("Invalid layout editor tag");
  const requiredParent = {
    layout: "",
    "layout-section": "layout",
    "layout-cell": "layout-section",
  }[kind];
  if (requiredParent === undefined || parentKind !== requiredParent)
    fail("Invalid layout metadata hierarchy");
  let attributes;
  try {
    attributes = JSON.parse(decode(htmlAttr(node, "data-sandbox-attrs")));
  } catch {
    fail("Invalid layout attribute metadata");
  }
  if (
    !Array.isArray(attributes) ||
    attributes.some(
      (pair) =>
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        pair.some((value) => typeof value !== "string"),
    ) ||
    new Set(attributes.map(([name]) => name)).size !== attributes.length
  )
    fail("Invalid layout attribute metadata");
  const expectedClass = {
    layout: "contentLayout2",
    "layout-section": "columnLayout",
    "layout-cell": "cell",
  }[kind];
  if (!hasClass(node, expectedClass)) fail("Invalid layout editor class");
  const allowed = new Set([
    "class",
    "data-layout",
    "data-sandbox-kind",
    "data-sandbox-attrs",
    ...NATIVE_ATTRIBUTES,
  ]);
  if (node.attrs.some(({ name }) => !allowed.has(name)))
    fail("Unsupported layout editor attribute");
  safeAttributes(`ac:${kind}`, attributes);
  if (attributes.some(([name]) => !/^ac:[A-Za-z][\w.-]*$/.test(name)))
    fail("Unsupported layout attribute namespace");
  let children = node.childNodes;
  if (kind === "layout-cell") {
    if (
      children.length !== 1 ||
      children[0].tagName !== "div" ||
      !hasClass(children[0], "innerCell") ||
      children[0].attrs.some(({ name }) => name !== "class" && !NATIVE_ATTRIBUTES.has(name))
    )
      fail("Invalid layout inner cell structure");
    children = children[0].childNodes;
  } else {
    const expectedChild = kind === "layout" ? "layout-section" : "layout-cell";
    if (
      children.some(
        (child) =>
          child.nodeName !== "#text" && htmlAttr(child, "data-sandbox-kind") !== expectedChild,
      ) ||
      children.some((child) => child.nodeName === "#text" && child.value.trim())
    )
      fail("Invalid layout child structure");
  }
  if (
    kind === "layout-section" &&
    htmlAttr(node, "data-layout") !== attributes.find(([name]) => name === "ac:type")?.[1]
  )
    fail("Unsupported edit to layout type metadata");
  return `<ac:${kind}${attributeString(attributes)}>${children.map((child) => convert(child, kind)).join("")}</ac:${kind}>`;
}

export function editorToStorage(source) {
  bounded(source);
  validateEditorTokens(source);
  const fragment = parseFragment(source);
  let count = 0;
  const convert = (node, parentKind = "", depth = 0) => {
    if (++count > MAX_NODES || depth > MAX_DEPTH) fail("Editor exceeds node or depth limit");
    if (node.nodeName === "#text") return textXml(node.value);
    if (node.nodeName === "#comment") {
      if (node.data.includes("--") || node.data.endsWith("-"))
        fail("Invalid XML comment in editor source");
      return `<!--${node.data}-->`;
    }
    if (!HTML_TAGS.has(node.tagName) || node.namespaceURI !== HTML)
      fail("Unsupported editor element or namespace");
    const kind = htmlAttr(node, "data-sandbox-kind");
    if (kind === "opaque") return restoreOpaque(node);
    if (kind)
      return restoreLayout(node, kind, parentKind, (child, parent) =>
        convert(child, parent, depth + 1),
      );
    if (node.attrs.some(({ name }) => name.startsWith("data-sandbox-")))
      fail("Invalid private metadata without a kind");
    const attributes = htmlAttributePairs(node).filter(([name]) => !NATIVE_ATTRIBUTES.has(name));
    safeAttributes(node.tagName, attributes);
    if (attributes.some(([name]) => name.includes(":")))
      fail("Unsupported editor attribute namespace");
    if (htmlAttr(node, "data-mce-bogus") === "all")
      fail("Unsupported transient native editor element");
    const attrs = attributeString(attributes);
    if (VOID_TAGS.has(node.tagName)) return `<${node.tagName}${attrs}/>`;
    return `<${node.tagName}${attrs}>${node.childNodes.map((child) => convert(child, "", depth + 1)).join("")}</${node.tagName}>`;
  };
  const storage = fragment.childNodes.map((node) => convert(node)).join("");
  // Revalidate decoded metadata as Storage; private markers never bypass the XML safety boundary.
  const roots = parseStorage(storage);
  const validateLayouts = (node) => {
    if (node.nodeType !== 1) return;
    if (node.nodeName === "ac:layout") assertLayout(node);
    for (const child of node.childNodes) validateLayouts(child);
  };
  roots.forEach(validateLayouts);
  return storage;
}

function parameter(node, name, fallback = "") {
  return (
    elementChildren(node).find(
      (child) => child.nodeName === "ac:parameter" && child.getAttribute("ac:name") === name,
    )?.textContent ?? fallback
  );
}
function body(node) {
  return elementChildren(node).find((child) =>
    ["ac:rich-text-body", "ac:plain-text-body"].includes(child.nodeName),
  );
}
function localAttachment(node, context) {
  const filename = node.getAttribute("ri:filename");
  if (!filename || /[\\/\x00]/.test(filename)) fail("Invalid local attachment filename");
  const page = elementChildren(node).find((child) => child.nodeName === "ri:page");
  const pageId =
    page?.getAttribute("ri:content-id") ||
    page?.getAttribute("ri:page-id") ||
    context.pageId ||
    "1700";
  if (!/^[1-9]\d*$/.test(pageId)) fail("Invalid local attachment page");
  return `/download/attachments/${pageId}/${encodeURIComponent(filename)}`;
}
function resourceLink(node, context) {
  if (node.nodeName === "ri:attachment") return localAttachment(node, context);
  if (node.nodeName === "ri:url") {
    const value = node.getAttribute("ri:value") || "";
    safeUrl(value);
    return value;
  }
  if (node.nodeName === "ri:page") {
    const id =
      node.getAttribute("ri:content-id") ||
      node.getAttribute("ri:page-id") ||
      context.resolvePage?.(node.getAttribute("ri:content-title"));
    if (!id || !/^[1-9]\d*$/.test(id)) fail("Unsupported unresolved local page reference");
    return `/pages/viewpage.action?pageId=${id}`;
  }
  return "";
}

/** Render public-format specimens, not an authentic Atlassian/plugin runtime. */
export function storageToView(source, context = {}) {
  const roots = parseStorage(source);
  const headings = [];
  const collect = (node) => {
    if (node.nodeType !== 1) return;
    if (/^h[1-6]$/.test(node.nodeName))
      headings.push({ text: node.textContent, id: node.getAttribute("id") });
    for (const child of node.childNodes) collect(child);
  };
  roots.forEach(collect);
  const render = (node) => {
    if (node.nodeType === 3 || node.nodeType === 4) return textXml(node.nodeValue);
    if (node.nodeType === 8) return `<!--${node.nodeValue}-->`;
    const children = () => [...node.childNodes].map(render).join("");
    const name = node.nodeName;
    if (name === "ac:layout") {
      assertLayout(node);
      return `<div class="contentLayout2">${children()}</div>`;
    }
    if (name === "ac:layout-section")
      return `<div class="columnLayout" data-layout="${escapeHtml(node.getAttribute("ac:type"))}">${children()}</div>`;
    if (name === "ac:layout-cell")
      return `<div class="cell"><div class="innerCell">${children()}</div></div>`;
    if (["ac:structured-macro", "ac:macro"].includes(name)) {
      const macro = node.getAttribute("ac:name") || "unnamed";
      const content = body(node);
      const renderedBody = content ? [...content.childNodes].map(render).join("") : "";
      const marker = ` data-macro-name="${escapeHtml(macro)}"`;
      if (["info", "note", "warning", "tip"].includes(macro))
        return `<div class="confluence-information-macro confluence-information-macro-${macro}"${marker}>${renderedBody}</div>`;
      if (macro === "expand")
        return `<details class="expand-container"${marker}><summary class="expand-control">${escapeHtml(parameter(node, "title", "Lorem details"))}</summary><div class="expand-content">${renderedBody}</div></details>`;
      if (macro === "status")
        return `<span class="status-macro"${marker}>${escapeHtml(parameter(node, "title", "LOREM"))}</span>`;
      if (macro === "code")
        return `<div class="code panel"${marker}><pre><code class="language-${escapeHtml(parameter(node, "language", "text"))}">${textXml(content?.textContent || "")}</code></pre></div>`;
      if (macro === "toc")
        return `<div class="toc-macro"${marker}><strong>Lorem contents</strong><ul>${headings.map((heading) => `<li>${heading.id ? `<a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a>` : escapeHtml(heading.text)}</li>`).join("")}</ul></div>`;
      if (macro === "children")
        return `<div class="children-macro"${marker}><ul>${(context.children || []).map((page) => `<li><a href="/pages/viewpage.action?pageId=${encodeURIComponent(page.id)}">${escapeHtml(page.title)}</a></li>`).join("")}</ul></div>`;
      if (macro === "excerpt")
        return `<blockquote class="excerpt-macro"${marker}>${renderedBody}</blockquote>`;
      if (["details", "page-properties"].includes(macro))
        return `<div class="page-properties"${marker}>${renderedBody}</div>`;
      if (macro === "gallery")
        return `<div class="gallery-macro"${marker}>${renderedBody || '<figure><img src="/download/attachments/1700/lorem.png" alt="Lorem local image"><figcaption>Lorem gallery specimen</figcaption></figure>'}</div>`;
      if (["editor-settings", "collaboration"].includes(macro))
        return `<div class="hidden sandbox-editor-noise" hidden="hidden"${marker}>${renderedBody}</div>`;
      return `<div class="macro-placeholder conf-macro"${marker}><strong>Protected unknown macro: ${escapeHtml(macro)}</strong><p>Opaque Lorem payload retained; plugin rendering is not emulated.</p></div>`;
    }
    if (name === "ac:task-list")
      return `<div class="task-list" data-macro-name="task-list">${elementChildren(node)
        .map((task) => {
          const status = elementChildren(task).find(
            (child) => child.nodeName === "ac:task-status",
          )?.textContent;
          const taskBody = elementChildren(task).find((child) => child.nodeName === "ac:task-body");
          return `<div class="task-list-item" data-status="${status === "complete" ? "checked" : "unchecked"}"><span aria-hidden="true">${status === "complete" ? "[x]" : "[ ]"}</span> <span class="task-list-body">${taskBody ? [...taskBody.childNodes].map(render).join("") : ""}</span></div>`;
        })
        .join("")}</div>`;
    if (name === "ac:image") {
      const resource = elementChildren(node).find(
        (child) => child.nodeName === "ri:attachment" || child.nodeName === "ri:url",
      );
      if (!resource) fail("Unsupported image without a resource");
      const src = resourceLink(resource, context);
      safeUrl(src, true);
      const dimensions = ["width", "height"]
        .map((key) => {
          const value = node.getAttribute(`ac:${key}`);
          if (value && !/^\d{1,4}$/.test(value)) fail("Unsupported image dimension");
          return value ? ` ${key}="${value}"` : "";
        })
        .join("");
      const caption = elementChildren(node).find((child) => child.nodeName === "ac:caption");
      return `<figure class="sandbox-image"><img src="${escapeHtml(src)}" alt="${escapeHtml(node.getAttribute("ac:alt") || "Lorem local image")}"${dimensions}>${caption ? `<figcaption>${[...caption.childNodes].map(render).join("")}</figcaption>` : ""}</figure>`;
    }
    if (name === "ac:link") {
      const resource = elementChildren(node).find((child) => child.namespaceURI === RI);
      const linkBody = elementChildren(node).find((child) =>
        ["ac:link-body", "ac:plain-text-link-body"].includes(child.nodeName),
      );
      const anchor = node.getAttribute("ac:anchor");
      const href =
        (resource ? resourceLink(resource, context) : "") +
        (anchor ? `#${encodeURIComponent(anchor)}` : "");
      if (!href) fail("Unsupported link without a local target");
      return `<a href="${escapeHtml(href)}">${linkBody ? [...linkBody.childNodes].map(render).join("") : escapeHtml(resource?.getAttribute("ri:content-title") || resource?.getAttribute("ri:filename") || "Lorem link")}</a>`;
    }
    if (node.namespaceURI === RI) {
      if (name === "ri:user")
        return `<span class="confluence-userlink" data-username="${escapeHtml(node.getAttribute("ri:username") || "lorem")}">@${escapeHtml(node.getAttribute("ri:username") || "lorem")}</span>`;
      const href = resourceLink(node, context);
      return href
        ? `<a href="${escapeHtml(href)}">${escapeHtml(node.getAttribute("ri:content-title") || node.getAttribute("ri:filename") || "Lorem resource")}</a>`
        : `<span>Protected resource: ${escapeHtml(name)}</span>`;
    }
    if (node.namespaceURI === AC)
      return `<span class="sandbox-protected-resource">Protected resource: ${escapeHtml(name)}</span>`;
    const attrs = attributeString(xmlAttributes(node));
    if (VOID_TAGS.has(name)) return `<${name}${attrs}>`;
    return `<${name}${attrs}>${children()}</${name}>`;
  };
  return roots.map(render).join("");
}
