/** Preserve text nodes without letting GFM autolinks consume Markdown escape characters. */
export function escapeMarkdownText(text: string, escape: (value: string) => string): string {
  const htmlText = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escape(htmlText)
    .replace(/\b(https?|ftp):\/\//gi, "$1\\://")
    .replace(/\bwww\./gi, "www\\.");
}

/**
 * Encode arbitrary attribute-derived text for a Markdown link/image label.
 * Keeps the value inside the label so it cannot break out into raw Markdown/HTML.
 */
export function encodeMarkdownLabel(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\[\]]/g, (char) => `\\${char}`);
}

/**
 * Encode a destination so Markdown keeps parsing it as one URL. Clean URLs are
 * returned unchanged; destinations with whitespace, quotes, or parentheses are
 * angle-wrapped, which CommonMark accepts verbatim.
 */
export function encodeMarkdownDestination(destination: string): string {
  const dest = destination.trim();
  if (!dest) return "";
  const needsWrapping = Array.from(dest).some(
    (char) => char.charCodeAt(0) < 0x20 || /[\s"'()<>]/.test(char),
  );
  if (!needsWrapping) return dest;
  return `<${dest.replace(/</g, "%3C").replace(/>/g, "%3E")}>`;
}
