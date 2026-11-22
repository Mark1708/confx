import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import type { LayoutExtractionOutcome } from "@/types";
import { extractConfluenceLayout, formatConfluenceLayoutMarkdown } from "./confluence-layout";
import {
  encodeMarkdownDestination,
  encodeMarkdownLabel,
  escapeMarkdownText,
} from "./markdown-literals";

export interface HtmlToMdOptions {
  imageReplacer?: (img: HTMLImageElement) => string;
  linkRenderer?: (href: string, text: string) => string | undefined;
  linkRewriter?: (href: string, text: string) => string;
  spoilersAsDetails?: boolean;
  dropSelectors?: string[];
  storageHtml?: string;
}

export interface HtmlToMarkdownResult {
  markdown: string;
  layout: LayoutExtractionOutcome;
}
function preprocessConfluenceNoise(html: string | HTMLElement): HTMLElement {
  const root =
    typeof html === "string" ? new DOMParser().parseFromString(html, "text/html").body : html;

  root
    .querySelectorAll(
      ".enh-settings.hidden, .enh-settings[hidden], .enh-settings[aria-hidden='true'], " +
        ".synchrony-container, .synchrony-exclude",
    )
    .forEach((el) => el.remove());

  root.querySelectorAll("p").forEach((p) => {
    if (p.closest("pre") || p.querySelector("img, video, audio, iframe, embed")) return;
    const text = (p.textContent ?? "").replace(/[\s ]/g, "");
    if (text === "") p.remove();
  });

  root.querySelectorAll(".auto-cursor-target").forEach((el) => {
    if (el.textContent?.trim() === "") el.remove();
  });

  root.querySelectorAll(".confluence-anchor-link, .heading-anchor-wrapper").forEach((el) => {
    el.remove();
  });

  root.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((heading) => {
    const preview = heading.getAttribute("data-numhead-preview");
    const alreadyNumbered = /^\s*\d+(?:\.\d+)*[.)]?(?=\s|$)/.test(heading.textContent ?? "");
    if (preview && !alreadyNumbered) heading.prepend(root.ownerDocument.createTextNode(preview));
  });

  // Passing the DOM avoids parsing PRE a second time and swallowing another opening newline.
  return root;
}

function cellToMd(el: Element, cellTd: TurndownService): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll(".tablesorter-header-inner").forEach((n) => {
    const children = Array.from(n.childNodes);
    n.replaceWith(...children);
  });
  clone
    .querySelectorAll(".tablesorter-headerIcon, .tablesorter-header-indicator, .aui-icon")
    .forEach((n) => {
      n.remove();
    });

  const md = cellTd.turndown(clone as HTMLElement).trim();
  return md
    .replace(/\|/g, "\\|")
    .replace(/\r?\n+/g, " <br> ")
    .trim();
}

interface CellInfo {
  text: string;
  isHeader: boolean;
}

function tableToGfm(table: HTMLTableElement, cellConv: (el: Element) => string): string {
  const rows = Array.from(table.rows);
  if (!rows.length) return "";

  const grid: CellInfo[][] = [];
  for (let r = 0; r < rows.length; r++) {
    if (!grid[r]) grid[r] = [];
    let c = 0;
    for (const cell of Array.from(rows[r].cells)) {
      while (grid[r][c]) c++;
      const text = cellConv(cell);
      const isHeader = cell.tagName === "TH";
      const rs = Math.max(1, parseInt(cell.getAttribute("rowspan") || "1", 10));
      const cs = Math.max(1, parseInt(cell.getAttribute("colspan") || "1", 10));
      for (let dr = 0; dr < rs; dr++) {
        for (let dc = 0; dc < cs; dc++) {
          if (!grid[r + dr]) grid[r + dr] = [];
          grid[r + dr][c + dc] = { text, isHeader };
        }
      }
      c += cs;
    }
  }

  const cols = Math.max(1, ...grid.map((row) => row.length));
  for (const row of grid) {
    while (row.length < cols) row.push({ text: "", isHeader: false });
  }

  const firstRowAllHeader = grid[0].every((cell) => cell.isHeader);
  const firstColAllHeader = grid.every((row) => row[0]?.isHeader);

  let header: string[];
  let bodyRows: string[][];

  if (firstRowAllHeader) {
    header = grid[0].map((c) => c.text);
    bodyRows = grid.slice(1).map((row) => row.map((c) => c.text));
  } else if (firstColAllHeader && !firstRowAllHeader) {
    if (cols === 2) {
      header = ["Поле", "Значение"];
    } else {
      header = ["Поле", ...Array.from({ length: cols - 1 }, (_, i) => `Значение ${i + 1}`)];
    }
    bodyRows = grid.map((row) => row.map((c) => c.text));
  } else {
    header = grid[0].map((c, i) => c.text || `Колонка ${i + 1}`);
    bodyRows = grid.slice(1).map((row) => row.map((c) => c.text));
  }

  const sep = header.map(() => "---");
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${sep.join(" | ")} |`,
    ...bodyRows.map((row) => `| ${row.map((s) => s || " ").join(" | ")} |`),
  ];
  return `\n\n${lines.join("\n")}\n\n`;
}

function isFabricCodeBlock(node: Node): boolean {
  if (!(node instanceof HTMLElement) || node.nodeName !== "CODE") return false;
  const parent = node.parentElement;
  return !!parent && parent.hasAttribute("data-ds--code--code-block");
}

const CODE_LANGUAGE_CLASSES: Readonly<Record<string, true>> = {
  actionscript: true,
  applescript: true,
  bash: true,
  c: true,
  "c#": true,
  "c++": true,
  clojure: true,
  cpp: true,
  csharp: true,
  css: true,
  delphi: true,
  diff: true,
  erl: true,
  erlang: true,
  go: true,
  groovy: true,
  html: true,
  java: true,
  javascript: true,
  js: true,
  jscript: true,
  json: true,
  kotlin: true,
  lua: true,
  markdown: true,
  md: true,
  none: true,
  perl: true,
  php: true,
  plain: true,
  plaintext: true,
  powershell: true,
  properties: true,
  py: true,
  python: true,
  r: true,
  rb: true,
  ruby: true,
  rust: true,
  sass: true,
  scala: true,
  scss: true,
  sh: true,
  shell: true,
  sql: true,
  text: true,
  ts: true,
  typescript: true,
  vb: true,
  xml: true,
  yaml: true,
  yml: true,
};

function getCodeLanguage(...nodes: (Element | null)[]): string {
  for (const node of nodes) {
    const language = node?.getAttribute("data-code-lang")?.trim();
    if (language && /^[\w#+.-]+$/.test(language)) return language.toLowerCase();
  }
  for (const node of nodes) {
    const language = node?.getAttribute("class")?.match(/(?:^|\s)language-([\w#+.-]+)(?=\s|$)/i);
    if (language) return language[1].toLowerCase();
  }
  for (const node of nodes) {
    const language =
      node
        ?.getAttribute("data-syntaxhighlighter-params")
        ?.match(/(?:^|[;\s])brush:\s*([\w#+.-]+)/i) ??
      node?.getAttribute("class")?.match(/(?:^|[;\s])brush:\s*([\w#+.-]+)/i);
    if (language) return language[1].toLowerCase();
  }
  for (const node of nodes) {
    const language = node
      ?.getAttribute("class")
      ?.split(/\s+/)
      .find((token) => Object.hasOwn(CODE_LANGUAGE_CLASSES, token.toLowerCase()));
    if (language) return language.toLowerCase();
  }
  return "";
}

function getCodeText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
    return node.nodeValue ?? "";
  }
  if (node.nodeName === "BR") return "\n";
  let text = "";
  for (const child of node.childNodes) text += getCodeText(child);
  return text;
}

function isParagraphCodeBlock(node: Node): boolean {
  return (
    node.nodeName === "P" &&
    node instanceof HTMLElement &&
    node.classList.contains("code-fence") &&
    node.querySelector("code") !== null
  );
}

function escapeCodeHtml(code: string): string {
  // GFM inline parsers can still interpret Markdown inside raw table-cell HTML.
  return escapeHtmlText(code).replace(/[`*_[\]\\~|@.:]/g, (char) => `&#${char.charCodeAt(0)};`);
}

function inlineCode(code: string): string {
  if (!code) return "";
  if (code.includes("\n")) {
    return `<code>${escapeCodeHtml(code).replace(/\n/g, "<br>")}</code>`;
  }
  let length = 1;
  for (const run of code.matchAll(/`+/g)) length = Math.max(length, run[0].length + 1);
  const delimiter = "`".repeat(length);
  const pad =
    code.startsWith("`") ||
    code.endsWith("`") ||
    (code.startsWith(" ") && code.endsWith(" ") && /[^ ]/.test(code))
      ? " "
      : "";
  return `${delimiter}${pad}${code}${pad}${delimiter}`;
}

function fencedCode(language: string, code: string): string {
  let length = 3;
  for (const run of code.matchAll(/`+/g)) length = Math.max(length, run[0].length + 1);
  const fence = "`".repeat(length);
  return `\n\n${fence}${language}\n${code}\n${fence}\n\n`;
}

export function buildTurndown(opts: HtmlToMdOptions = {}): TurndownService {
  const imageReplacer = opts.imageReplacer;
  const linkRewriter = opts.linkRewriter;
  const linkRenderer = opts.linkRenderer;
  const dropSelectors = opts.dropSelectors;
  const renderLink = (href: string, text: string): string =>
    linkRenderer?.(href, text) ??
    `[${text}](${encodeMarkdownDestination(linkRewriter?.(href, text) ?? href)})`;
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    strongDelimiter: "**",
    hr: "---",
    linkStyle: "inlined",
  });

  td.use(gfm);

  const cellTd = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    strongDelimiter: "**",
    hr: "---",
    linkStyle: "inlined",
  });
  cellTd.remove(["script", "style", "button"]);
  for (const service of [td, cellTd]) {
    const escapeMarkdown = service.escape.bind(service);
    // Reading projection only: leave persisted editable Markdown's v1/v2 baselines unchanged.
    service.escape = (text) => escapeMarkdownText(text, escapeMarkdown).replace(/@/g, "&#64;");
    service.options.preformattedCode = true;
  }

  if (imageReplacer) {
    cellTd.addRule("cell-img", {
      filter: "img",
      replacement: (_c, node) => imageReplacer(node as HTMLImageElement),
    });
  }
  if (linkRenderer || linkRewriter) {
    cellTd.addRule("cell-link", {
      filter: "a",
      replacement: (content, node) => {
        const a = node as HTMLAnchorElement;
        const href = a.getAttribute("href") || "";
        const text = (content || a.textContent || "").trim();
        return href ? renderLink(href, text) : text;
      },
    });
  }

  const addInlineConfluenceRules = (service: TurndownService): void => {
    service.addRule("literal-inline-code", {
      filter: "code",
      replacement: (_content, node) => inlineCode(getCodeText(node)),
    });

    service.addRule("jira-issue", {
      filter: (node) =>
        node.nodeName === "SPAN" && (node as HTMLElement).classList?.contains("jira-issue"),
      replacement: (_content, node) => {
        const el = node as HTMLElement;
        const key = encodeMarkdownLabel(el.getAttribute("data-jira-key") || "");
        const link = el.querySelector("a.jira-issue-key");
        const href = link?.getAttribute("href") || "";
        const summary = el.querySelector(".summary")?.textContent?.trim() || "";
        const status = el.querySelector(".aui-lozenge")?.textContent?.trim() || "";
        const isResolved = el.classList.contains("resolved");
        const issueRef = href ? `[${key}](${encodeMarkdownDestination(href)})` : key;
        const parts = [issueRef];
        if (summary) parts.push(`- ${summary}`);
        if (status) parts.push(`[${status}]`);
        const result = parts.join(" ");
        return isResolved ? `~~${result}~~` : result;
      },
    });

    service.addRule("aui-lozenge", {
      filter: (node) => {
        if (node.nodeName !== "SPAN") return false;
        const el = node as HTMLElement;
        return !!el.classList?.contains("aui-lozenge") && !el.closest?.(".jira-issue");
      },
      replacement: (content, _node) => {
        const text = content.trim();
        return text ? `[${text}]` : "";
      },
    });
  };

  addInlineConfluenceRules(cellTd);
  cellTd.addRule("cell-code-block", {
    filter: (node) => node.nodeName === "PRE" || isParagraphCodeBlock(node),
    replacement: (_content, node) => {
      // GFM table cells cannot contain fenced blocks or physical source newlines.
      const code = escapeCodeHtml(getCodeText(node)).replace(/\n/g, "&#10;");
      return `<pre><code>${code}</code></pre>`;
    },
  });

  td.remove(["script", "style", "button"]);

  td.addRule("attachments-macro", {
    filter: (node) => {
      const macroName = node.getAttribute("data-macro-name") || node.getAttribute("ac:name") || "";
      if (macroName === "attachments") return true;
      return !!node.closest?.(
        '[data-macro-name="attachments"], ac\\:structured-macro[ac\\:name="attachments"]',
      );
    },
    replacement: () => "",
  });

  td.addRule("toc-macro", {
    filter: (node) =>
      node.nodeName === "DIV" && (node as HTMLElement).classList?.contains("toc-macro"),
    replacement: () => "",
  });

  td.addRule("info-macro", {
    filter: (node) =>
      node.nodeName === "DIV" &&
      (node as HTMLElement).classList?.contains("confluence-information-macro"),
    replacement: (content, node) => {
      const el = node as HTMLElement;
      const kind = el.classList.contains("confluence-information-macro-warning")
        ? "WARNING"
        : el.classList.contains("confluence-information-macro-note")
          ? "NOTE"
          : el.classList.contains("confluence-information-macro-tip")
            ? "TIP"
            : "INFO";
      const body = content.trim();
      if (!body) return "";
      const quoted = body
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
      return `\n\n> **${kind}**\n${quoted}\n\n`;
    },
  });

  td.addRule("expand-container", {
    filter: (node) =>
      node.nodeName === "DIV" && (node as HTMLElement).classList?.contains("expand-container"),
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const title = el.querySelector(".expand-control")?.textContent?.trim() ?? "Подробнее";
      const body = el.querySelector<HTMLElement>(".expand-content");
      if (!body) return "";
      const inner = td.turndown(body).trim();
      if (opts.spoilersAsDetails !== false) {
        return `\n\n<details>\n<summary>${escapeHtmlText(title)}</summary>\n\n${inner}\n\n</details>\n\n`;
      }
      return `\n\n### ${td.escape(title)}\n\n${inner}\n\n`;
    },
  });

  td.addRule("confluence-image", {
    filter: "img",
    replacement: (_content, node) => {
      const img = node as HTMLImageElement;
      if (imageReplacer) return imageReplacer(img);
      const src = img.getAttribute("data-image-src") || img.getAttribute("src") || "";
      const alt = encodeMarkdownLabel(img.getAttribute("alt") || "");
      return src ? `![${alt}](${encodeMarkdownDestination(src)})` : "";
    },
  });

  if (linkRenderer || linkRewriter) {
    td.addRule("rewrite-link", {
      filter: "a",
      replacement: (content, node) => {
        const a = node as HTMLAnchorElement;
        const href = a.getAttribute("href") || "";
        if (!href) return content;
        const text = (content || a.textContent || "").trim();
        return renderLink(href, text);
      },
    });
  }

  td.addRule("custom-table", {
    filter: "table",
    replacement: (_content, node) =>
      tableToGfm(node as HTMLTableElement, (el) => cellToMd(el, cellTd)),
  });

  addInlineConfluenceRules(td);

  td.addRule("fabric-code-block", {
    filter: isFabricCodeBlock,
    replacement: (_content, node) => {
      const codeEl = node as HTMLElement;
      const lang = getCodeLanguage(codeEl, codeEl.parentElement);
      return fencedCode(lang, getCodeText(codeEl));
    },
  });

  td.addRule("paragraph-code-block", {
    filter: isParagraphCodeBlock,
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      return fencedCode(getCodeLanguage(...el.querySelectorAll("code"), el), getCodeText(el));
    },
  });

  td.addRule("plain-pre-code-block", {
    filter: "pre",
    replacement: (_content, node) => {
      const pre = node as HTMLElement;
      const lang = getCodeLanguage(...pre.querySelectorAll("code"), pre);
      return fencedCode(lang, getCodeText(pre));
    },
  });

  td.addRule("fabric-code-block-wrapper", {
    filter: (node) =>
      node.nodeName === "SPAN" && (node as HTMLElement).hasAttribute("data-ds--code--code-block"),
    replacement: (content) => content,
  });

  td.addRule("confluence-code-block", {
    filter: (node) =>
      node.nodeName === "DIV" &&
      (node as HTMLElement).classList?.contains("code") &&
      (node as HTMLElement).classList?.contains("panel"),
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const preElements = Array.from(el.querySelectorAll("pre"));
      if (preElements.length) {
        return preElements
          .map((pre) =>
            fencedCode(getCodeLanguage(...pre.querySelectorAll("code"), pre, el), getCodeText(pre)),
          )
          .join("\n\n");
      }
      const codeEl = el.querySelector("code");
      return codeEl ? fencedCode(getCodeLanguage(codeEl, el), getCodeText(codeEl)) : "";
    },
  });

  td.addRule("confluence-code-macro", {
    filter: (node) => {
      const nodeName = node.nodeName.toLowerCase();
      if (nodeName !== "ac:structured-macro") return false;
      const el = node as HTMLElement;
      return (el.getAttribute("ac:name") || el.getAttribute("name")) === "code";
    },
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const language =
        el
          .querySelector('ac\\:parameter[ac\\:name="language"], ac\\:parameter[name="language"]')
          ?.textContent?.trim()
          .toLowerCase() ?? "";
      const body = el.querySelector("ac\\:plain-text-body, ac\\:rich-text-body");
      return fencedCode(language, body?.textContent || el.textContent || "");
    },
  });

  td.addRule("confluence-task-list", {
    filter: (node) =>
      node.nodeName === "DIV" && (node as HTMLElement).classList?.contains("task-list"),
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const items = el.querySelectorAll(".task-list-item");
      if (!items.length) return "";
      const lines = Array.from(items).map((item) => {
        const isChecked =
          item.getAttribute("data-status") === "checked" ||
          item.querySelector("input[checked]") !== null;
        const body =
          item.querySelector(".task-list-body")?.textContent?.trim() ||
          item.textContent?.trim() ||
          "";
        return `- ${isChecked ? "[x]" : "[ ]"} ${body}`;
      });
      return `\n\n${lines.join("\n")}\n\n`;
    },
  });

  td.addRule("confluence-excerpt-macro", {
    filter: (node) => {
      if (node.nodeName.toLowerCase() !== "ac:structured-macro") return false;
      const el = node as HTMLElement;
      return (el.getAttribute("ac:name") || el.getAttribute("name")) === "excerpt";
    },
    replacement: (content, node) => {
      const el = node as HTMLElement;
      const body = el.querySelector<HTMLElement>("ac\\:rich-text-body");
      const inner = body ? td.turndown(body).trim() : content.trim();
      if (!inner) return "";
      const quoted = inner
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      return `\n\n${quoted}\n\n`;
    },
  });

  td.addRule("confluence-gallery-macro", {
    filter: (node) => {
      if (node.nodeName.toLowerCase() !== "ac:structured-macro") return false;
      const el = node as HTMLElement;
      return (el.getAttribute("ac:name") || el.getAttribute("name")) === "gallery";
    },
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const images = Array.from(el.querySelectorAll("ac\\:image, img"));
      const lines = images
        .map((image) => {
          const attachment = image.querySelector("ri\\:attachment");
          const filename =
            attachment?.getAttribute("ri:filename") || attachment?.getAttribute("filename") || "";
          const src =
            image.getAttribute("src") ||
            image.getAttribute("data-image-src") ||
            image.getAttribute("ac:src") ||
            filename;
          const alt = encodeMarkdownLabel(
            image.getAttribute("alt") || image.getAttribute("ac:alt") || filename || "",
          );
          return src ? `![${alt}](${encodeMarkdownDestination(src)})` : "";
        })
        .filter((line) => line.length > 0);
      return lines.length ? `\n\n${lines.join("\n")}\n\n` : "";
    },
  });

  td.addRule("confluence-toc-macro", {
    filter: (node) => {
      if (node.nodeName.toLowerCase() !== "ac:structured-macro") return false;
      const el = node as HTMLElement;
      return (el.getAttribute("ac:name") || el.getAttribute("name")) === "toc";
    },
    replacement: () => "\n\n[TOC]\n\n",
  });

  td.addRule("confluence-page-link", {
    filter: (node) => node.nodeName.toLowerCase() === "ri:page",
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const title =
        el.getAttribute("ri:content-title") ||
        el.getAttribute("content-title") ||
        el.getAttribute("title") ||
        el.textContent?.trim() ||
        "page";
      const pageId =
        el.getAttribute("ri:page-id") || el.getAttribute("page-id") || el.getAttribute("id") || "";
      const spaceKey = el.getAttribute("ri:space-key") || el.getAttribute("space-key") || "";
      const target = pageId || (spaceKey ? `${spaceKey}:${title}` : title);
      const link = target
        ? `[${encodeMarkdownLabel(title)}](${encodeMarkdownDestination(target)})`
        : encodeMarkdownLabel(title);
      const macro = el.closest("ac\\:structured-macro");
      const macroName = macro?.getAttribute("ac:name") || macro?.getAttribute("name") || "";
      return macroName.startsWith("page-properties") ? `\n${title}\n: ${link}\n` : link;
    },
  });

  td.addRule("confluence-user-mention", {
    filter: (node) => {
      if (node.nodeName === "A" || node.nodeName === "SPAN") {
        return (node as HTMLElement).classList?.contains("confluence-userlink") ?? false;
      }
      return false;
    },
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const username =
        el.getAttribute("data-username") || el.textContent?.trim().replace(/^@/, "") || "";
      return username ? `@${username}` : "";
    },
  });

  td.addRule("unknown-macro-fallback", {
    filter: (node) => {
      if (node.nodeName !== "DIV") return false;
      const el = node as HTMLElement;
      const macroName = el.getAttribute("data-macro-name");
      if (!macroName) return false;
      const handled = ["toc", "expand", "info", "note", "warning", "tip", "code", "task-list"];
      return (
        !handled.includes(macroName) &&
        (!!el.classList?.contains("conf-macro") || !!el.classList?.contains("macro-placeholder"))
      );
    },
    replacement: (content, node) => {
      const el = node as HTMLElement;
      const macroName = el.getAttribute("data-macro-name") || "unknown";
      if (macroName === "attachments") return "";
      const body = content.trim();
      if (!body) return `[macro:${macroName}]`;
      return `[macro:${macroName}] <!-- ${body.replace(/-->/g, "]==")} -->`;
    },
  });

  if (dropSelectors?.length) {
    td.addRule("drop-selectors", {
      filter: (node) => {
        if (!(node instanceof Element)) return false;
        return dropSelectors.some((sel) => node.matches(sel));
      },
      replacement: () => "",
    });
  }

  return td;
}

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Converts rendered HTML; wiki-looking source text is kept literal. */
export function htmlToMarkdown(html: string, opts?: HtmlToMdOptions): string {
  return convertHtmlToMarkdown(html, opts);
}

export function htmlToMarkdownWithLayout(
  html: string,
  opts: HtmlToMdOptions = {},
): HtmlToMarkdownResult {
  const layout = extractConfluenceLayout(html, opts.storageHtml);
  if (layout.kind === "valid") {
    return {
      markdown: formatConfluenceLayoutMarkdown(layout.layout, (cell) =>
        convertHtmlToMarkdown(cell, { ...opts, storageHtml: undefined }),
      ),
      layout: { status: "preserved", sections: layout.sections },
    };
  }

  return {
    markdown: convertHtmlToMarkdown(html, opts),
    layout: {
      status: layout.kind === "invalid" ? "flattened" : "none",
      sections: layout.sections,
    },
  };
}

function convertHtmlToMarkdown(html: string | HTMLElement, opts?: HtmlToMdOptions): string {
  const cleaned = preprocessConfluenceNoise(html);
  return buildTurndown(opts).turndown(cleaned).trim();
}
