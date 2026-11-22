import DOMPurify from "dompurify";

/**
 * Passive-only rendered content for the read-only viewer: formatting, links,
 * images, tables, code, and disclosure widgets stay; anything that can act
 * (forms, controls, frames, embedded documents, scripts, styles, SVG/MathML,
 * metadata/navigation elements, event handlers, active URL schemes) is removed.
 */
const ALLOWED_TAGS = [
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "del",
  "details",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
];

/** Presentation-only attributes; no styling, metadata, or event surface. */
const ALLOWED_ATTR = [
  "align",
  "alt",
  "colspan",
  "height",
  "href",
  "rowspan",
  "src",
  "title",
  "width",
];

/** http(s)/mailto/tel plus relative, fragment, and scheme-less URLs. */
const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i;

export function sanitizeViewerHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP,
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    SANITIZE_DOM: true,
  });
}
