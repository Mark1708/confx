import { parse, Tokenizer, TokenizerMode, type DefaultTreeAdapterTypes } from "parse5";
import { MAX_ROUNDTRIP_TEXT_BYTES, type EditorSnapshot } from "./contracts";

type Element = DefaultTreeAdapterTypes.Element;
type Attribute = Element["attrs"][number];

const ACTIVE_ELEMENTS: Record<string, boolean> = {
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
const URL_ATTRIBUTES: Record<string, boolean> = {
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
const SAFE_URL_SCHEMES: Record<string, boolean> = {
  "http:": true,
  "https:": true,
  "mailto:": true,
  "tel:": true,
};

function assertBoundedText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  if (value.length > MAX_ROUNDTRIP_TEXT_BYTES) {
    throw new Error(`${label} exceeds the 5 MiB UTF-8 text limit`);
  }
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error(`${label} contains non-lossless Unicode (an unpaired surrogate)`);
      }
      bytes += 4;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`${label} contains non-lossless Unicode (an unpaired surrogate)`);
    } else bytes += 3;
    if (bytes > MAX_ROUNDTRIP_TEXT_BYTES) {
      throw new Error(`${label} exceeds the 5 MiB UTF-8 text limit`);
    }
  }
}

function assertSafeUrl(value: string, attribute: string): void {
  // Browsers ignore ASCII controls within schemes, after entity decoding by parse5.
  let normalized = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 32 && (code < 127 || code > 159)) normalized += value[index];
  }
  const scheme = normalized.match(/^[a-z][a-z\d+.-]*:/i)?.[0].toLowerCase();
  if (scheme && SAFE_URL_SCHEMES[scheme] !== true) {
    throw new Error(`Unsafe URL scheme in ${attribute}; active URLs are not allowed`);
  }
}

function assertSafeElement(tagName: string, attributes: readonly Attribute[]): void {
  if (ACTIVE_ELEMENTS[tagName] === true) {
    throw new Error(`Unsafe active HTML: <${tagName}> is not allowed in an editor snapshot`);
  }
  for (const attribute of attributes) {
    const name = attribute.name.toLowerCase();
    if (name.startsWith("on") || name === "srcdoc" || name === "is") {
      throw new Error(`Unsafe active HTML attribute: ${name} is not allowed`);
    }
    if (name === "style" || name === "data-mce-style") {
      // Keep ordinary editor layout styles, but reject CSS with executable/URL syntax,
      // escapes or comments rather than trying to sanitize its original source.
      if (
        /\\|\/\*|@|(?:expression|url)\s*\(|(?:^|[;\s])(?:behavior|-moz-binding)\s*:/i.test(
          attribute.value,
        )
      ) {
        throw new Error("Unsafe active CSS is not allowed in an editor snapshot");
      }
    } else if (name === "srcset" || name === "imagesrcset") {
      for (const candidate of attribute.value.split(",")) {
        assertSafeUrl(candidate.trim().split(/\s+/)[0] ?? "", name);
      }
    } else if (name === "ping") {
      for (const url of attribute.value.trim().split(/\s+/)) assertSafeUrl(url, name);
    } else if (URL_ATTRIBUTES[name] === true) {
      assertSafeUrl(attribute.value, name);
    }
  }
}

function assertSafeHtml(html: string, wrapperOnly = false): void {
  // Validate tokens, not only the constructed tree: HTML parsing can discard a
  // nested form, an extra body tag, or other active source before a tree walk sees it.
  const tokenizer = new Tokenizer(
    {},
    {
      onStartTag(token) {
        assertSafeElement(token.tagName, token.attrs);
        if (wrapperOnly && token.tagName !== "html" && token.tagName !== "head") {
          throw new Error(
            "Unsupported content outside the explicit body; exact extraction would lose document content",
          );
        }
        if (token.tagName === "title") tokenizer.state = TokenizerMode.RCDATA;
      },
      onNullCharacter() {
        throw new Error("Unsafe HTML contains a null character");
      },
      onEndTag(token) {
        if (wrapperOnly && token.tagName !== "html" && token.tagName !== "head") {
          throw new Error("Unsupported HTML tags outside the explicit body");
        }
      },
      onComment() {},
      onDoctype() {},
      onEof() {},
      onCharacter(token) {
        if (wrapperOnly && token.chars.trim() !== "") {
          throw new Error(
            "Unsupported text outside the explicit body; exact extraction would lose document content",
          );
        }
      },
      onWhitespaceCharacter() {},
    },
  );
  tokenizer.write(html, true);
}

/** Validate direct engine callers without sanitizing or mutating their source. */
export function assertSafeEditorSnapshot(snapshot: EditorSnapshot): void {
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot) ||
    snapshot.representation !== "editor"
  ) {
    throw new Error("Only the editor source representation is supported");
  }
  assertBoundedText(snapshot.html, "Editor HTML");
  assertBoundedText(snapshot.title, "Snapshot title");
  if (
    snapshot.pageId !== undefined &&
    (typeof snapshot.pageId !== "string" || !/^[1-9]\d*$/.test(snapshot.pageId))
  ) {
    throw new Error("Snapshot page identity must be a positive decimal page ID");
  }
  if (snapshot.capturedAt !== undefined) {
    assertBoundedText(snapshot.capturedAt, "Snapshot capture timestamp");
    if (!Number.isFinite(Date.parse(snapshot.capturedAt))) {
      throw new Error("Snapshot capture timestamp is invalid");
    }
  }
  assertSafeHtml(snapshot.html);
}

function readProbe(text: string, fallbackTitle: string): EditorSnapshot {
  let input: unknown;
  try {
    input = JSON.parse(text.trimStart());
  } catch {
    throw new Error("Invalid editor probe JSON");
  }
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !("schema" in input) ||
    (input.schema !== "confx-console-probe/1" && input.schema !== "confx-editor-probe/1")
  ) {
    throw new Error("Unsupported editor probe schema; HAR and token envelopes are not snapshots");
  }
  if (
    Object.keys(input).some((key) =>
      /^(?:log|access_token|refresh_token|id_token|token|authorization|cookie|cookies|headers)$/i.test(
        key,
      ),
    )
  ) {
    throw new Error("HAR and token envelopes are not editor snapshots");
  }
  if (
    !("status" in input) ||
    input.status !== "captured" ||
    !("snapshot" in input) ||
    input.snapshot === null ||
    typeof input.snapshot !== "object" ||
    Array.isArray(input.snapshot)
  ) {
    throw new Error("The editor probe did not capture a document (status must be captured)");
  }
  const captured = input.snapshot;
  if (!("representation" in captured) || captured.representation !== "editor") {
    throw new Error("Only the editor source representation is supported");
  }
  const html = "html" in captured ? captured.html : undefined;
  const title = ("title" in captured ? captured.title : undefined) ?? fallbackTitle;
  assertBoundedText(html, "Editor HTML");
  assertBoundedText(title, "Snapshot title");
  let pageId: unknown;
  if (input.schema === "confx-console-probe/1") {
    pageId = "pageId" in input ? input.pageId : undefined;
  } else if (
    "metadata" in input &&
    input.metadata !== null &&
    typeof input.metadata === "object" &&
    "ajs-page-id" in input.metadata
  ) {
    pageId = input.metadata["ajs-page-id"];
  }
  const capturedAt = "capturedAt" in input ? input.capturedAt : undefined;
  if (pageId !== undefined && pageId !== null && typeof pageId !== "string") {
    throw new Error("Snapshot page identity must be a positive decimal page ID");
  }
  if (capturedAt !== undefined && capturedAt !== null && typeof capturedAt !== "string") {
    throw new Error("Snapshot capture timestamp must be text");
  }
  const snapshot: EditorSnapshot = {
    representation: "editor",
    html,
    title,
    ...(typeof pageId === "string" ? { pageId } : {}),
    ...(typeof capturedAt === "string" ? { capturedAt } : {}),
  };
  assertSafeEditorSnapshot(snapshot);
  return snapshot;
}

function readHtml(html: string, fallbackTitle: string): EditorSnapshot {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const root = document.childNodes.find(
    (node): node is Element => "tagName" in node && node.tagName === "html",
  );
  const head = root?.childNodes.find(
    (node): node is Element => "tagName" in node && node.tagName === "head",
  );
  const body = root?.childNodes.find(
    (node): node is Element => "tagName" in node && node.tagName === "body",
  );
  const fullDocument =
    root?.sourceCodeLocation?.startTag ||
    head?.sourceCodeLocation?.startTag ||
    body?.sourceCodeLocation?.startTag ||
    document.childNodes.some((node) => node.nodeName === "#documentType");
  if (!fullDocument) {
    const snapshot: EditorSnapshot = { representation: "editor", html, title: fallbackTitle };
    assertSafeEditorSnapshot(snapshot);
    return snapshot;
  }
  const location = body?.sourceCodeLocation;
  if (!body || !location?.startTag || !location.endTag) {
    throw new Error(
      "Full HTML requires explicit opening and closing body tags for exact extraction",
    );
  }
  assertSafeElement("body", body.attrs);
  let headStart = head?.sourceCodeLocation?.startOffset ?? location.startTag.startOffset;
  let headEnd = head?.sourceCodeLocation?.endOffset ?? headStart;
  for (const child of head?.childNodes ?? []) {
    if (!child.sourceCodeLocation) continue;
    headStart = Math.min(headStart, child.sourceCodeLocation.startOffset);
    headEnd = Math.max(headEnd, child.sourceCodeLocation.endOffset);
  }
  assertSafeHtml(html.slice(0, headStart), true);
  assertSafeHtml(html.slice(headEnd, location.startTag.startOffset), true);
  assertSafeHtml(html.slice(location.endTag.endOffset), true);
  const bodyTitle = body.attrs.find((attribute) => attribute.name === "data-title")?.value;
  const titleElement = head?.childNodes.find(
    (node): node is Element => "tagName" in node && node.tagName === "title",
  );
  const headTitle = titleElement?.childNodes
    .map((node) => ("value" in node ? node.value : ""))
    .join("");
  const snapshot: EditorSnapshot = {
    representation: "editor",
    html: html.slice(location.startTag.endOffset, location.endTag.startOffset),
    title: bodyTitle ?? headTitle ?? fallbackTitle,
  };
  assertSafeEditorSnapshot(snapshot);
  return snapshot;
}

/** Read a saved capture or editor HTML; this function never reads a live page. */
export function readEditorSnapshot(text: string, fileName?: string): EditorSnapshot {
  assertBoundedText(text, "Snapshot file");
  const fallbackTitle =
    fileName
      ?.split(/[/\\]/)
      .at(-1)
      ?.replace(/\.(?:html?|json)$/i, "") || "Editor snapshot";
  const trimmed = text.trimStart();
  if (/\.(?:json|har)$/i.test(fileName ?? "") || /^[{["]/.test(trimmed)) {
    return readProbe(text, fallbackTitle);
  }
  return readHtml(text, fallbackTitle);
}
