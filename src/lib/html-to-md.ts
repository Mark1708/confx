import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export interface HtmlToMdOptions {
  imageReplacer?: (img: HTMLImageElement) => string;
  linkRewriter?: (href: string, text: string) => string;
  spoilersAsDetails?: boolean;
  dropSelectors?: string[];
}

function preprocessConfluenceNoise(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");

  doc.querySelectorAll("p").forEach((p) => {
    if (p.querySelector("img, video, audio, iframe, embed")) return;
    const text = (p.textContent ?? "").replace(/[\s ]/g, "");
    if (text === "") p.remove();
  });

  doc.querySelectorAll("p, div, span").forEach((el) => {
    if (el.children.length > 0) return;
    const text = (el.textContent ?? "").trim();
    if (text.length < 6 || text.length > 4000) return;
    if (!(text.startsWith("{") || text.startsWith("["))) return;
    try {
      JSON.parse(text);
      el.remove();
    } catch {
      /* not a config object, keep */
    }
  });

  doc.querySelectorAll("p.auto-cursor-target, .auto-cursor-target").forEach((el) => {
    if (el.textContent?.trim() === "") el.remove();
  });

  doc.querySelectorAll(".confluence-anchor-link, .heading-anchor-wrapper").forEach((el) => {
    el.remove();
  });

  doc.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((h) => {
    h.querySelectorAll("a.confluence-anchor-link").forEach((a) => {
      a.remove();
    });
  });

  return doc.body.innerHTML;
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

  const md = cellTd.turndown(clone.innerHTML).trim();
  return md
    .replace(/\|/g, "\\|")
    .replace(/\r?\n+/g, " <br> ")
    .replace(/\s{2,}/g, " ")
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

function getFabricCodeLanguage(codeEl: HTMLElement): string {
  const codeLang = codeEl.getAttribute("data-code-lang") || "";
  if (codeLang) return codeLang;

  const wrapperLang = codeEl.parentElement?.getAttribute("data-code-lang") || "";
  if (wrapperLang) return wrapperLang;

  const codeClass = codeEl.getAttribute("class") || "";
  const langMatch = codeClass.match(/language-(\S+)/);
  return langMatch?.[1] ?? "";
}

function getSyntaxHighlighterLanguage(el: Element): string {
  const params = el.getAttribute("data-syntaxhighlighter-params") || el.getAttribute("class") || "";
  const brushMatch = params.match(/brush:\s*([\w-]+)/i);
  if (brushMatch) return brushMatch[1].toLowerCase();

  const languageMatch = params.match(/language-([\w-]+)/i);
  if (languageMatch) return languageMatch[1].toLowerCase();

  const className = el.getAttribute("class") || "";
  const languageClass = className
    .split(/\s+/)
    .find((token) => token && !["code", "panel", "pdl", "syntaxhighlighter-pre"].includes(token));
  return languageClass?.toLowerCase() ?? "";
}

function fencedCode(language: string, code: string): string {
  return `\n\n\`\`\`${language}\n${code.replace(/\n+$/g, "")}\n\`\`\`\n\n`;
}

function convertJiraWikiMarkup(markdown: string): string {
  const normalizedWikiMarkup = markdown
    .replace(/\\\[(?=[^\]\n]*\|)/g, "[")
    .replace(/\\\{\\\*\\\}/g, "{*}")
    .replace(/\{\\\*\}/g, "{*}")
    .replace(/\\\{code/g, "{code")
    .replace(/\\\{noformat/g, "{noformat")
    .replace(/\\\}/g, "}");

  return normalizedWikiMarkup
    .replace(
      /\\?\{code(?::([\w-]+))?\\?\}\n?([\s\S]*?)\\?\{code\\?\}/g,
      (_match, language, code) => {
        return fencedCode(language || "", String(code).trim());
      },
    )
    .replace(/\\?\{noformat\\?\}\n?([\s\S]*?)\\?\{noformat\\?\}/g, (_match, code) => {
      return fencedCode("", String(code).trim());
    })
    .replace(/\[([^\]|\n]+)\|((?:https?:\/\/|\/)[^\]\\\s]+)\\?\]/g, (_match, text, url) => {
      return `[${String(text)}](${String(url).replace(/\\([()])/g, "$1")})`;
    })
    .replace(/\{\*\}([\s\S]*?)\{\*\}/g, "**$1**");
}

export function buildTurndown(opts: HtmlToMdOptions = {}): TurndownService {
  const imageReplacer = opts.imageReplacer;
  const linkRewriter = opts.linkRewriter;
  const dropSelectors = opts.dropSelectors;
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
  if (imageReplacer) {
    cellTd.addRule("cell-img", {
      filter: "img",
      replacement: (_c, node) => imageReplacer(node as HTMLImageElement),
    });
  }
  if (linkRewriter) {
    cellTd.addRule("cell-link", {
      filter: "a",
      replacement: (content, node) => {
        const a = node as HTMLAnchorElement;
        const href = a.getAttribute("href") || "";
        const text = (content || a.textContent || "").trim();
        return href ? `[${text}](${linkRewriter(href, text)})` : text;
      },
    });
  }

  const addInlineConfluenceRules = (service: TurndownService): void => {
    service.addRule("jira-issue", {
      filter: (node) =>
        node.nodeName === "SPAN" && (node as HTMLElement).classList?.contains("jira-issue"),
      replacement: (_content, node) => {
        const el = node as HTMLElement;
        const key = el.getAttribute("data-jira-key") || "";
        const link = el.querySelector("a.jira-issue-key");
        const href = link?.getAttribute("href") || "";
        const summary = el.querySelector(".summary")?.textContent?.trim() || "";
        const status = el.querySelector(".aui-lozenge")?.textContent?.trim() || "";
        const isResolved = el.classList.contains("resolved");
        const issueRef = href ? `[${key}](${href})` : key;
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
      const body = el.querySelector(".expand-content");
      if (!body) return "";
      const inner = td.turndown(body.innerHTML).trim();
      if (opts.spoilersAsDetails !== false) {
        return `\n\n<details>\n<summary>${escapeHtml(title)}</summary>\n\n${inner}\n\n</details>\n\n`;
      }
      return `\n\n### ${title}\n\n${inner}\n\n`;
    },
  });

  td.addRule("confluence-image", {
    filter: "img",
    replacement: (_content, node) => {
      const img = node as HTMLImageElement;
      if (imageReplacer) return imageReplacer(img);
      const src = img.getAttribute("data-image-src") || img.getAttribute("src") || "";
      const alt = img.getAttribute("alt") || "";
      return src ? `![${alt}](${src})` : "";
    },
  });

  if (linkRewriter) {
    td.addRule("rewrite-link", {
      filter: "a",
      replacement: (content, node) => {
        const a = node as HTMLAnchorElement;
        const href = a.getAttribute("href") || "";
        if (!href) return content;
        const text = (content || a.textContent || "").trim();
        return `[${text}](${linkRewriter(href, text)})`;
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
      const lang = getFabricCodeLanguage(codeEl);
      const code = codeEl.textContent || "";
      return fencedCode(lang, code);
    },
  });

  td.addRule("plain-pre-code-block", {
    filter: (node) => {
      if (node.nodeName !== "PRE") return false;
      const el = node as HTMLElement;
      return !el.closest(".code.panel");
    },
    replacement: (_content, node) => {
      const pre = node as HTMLElement;
      const codeEl = pre.querySelector("code") ?? pre;
      const lang = getSyntaxHighlighterLanguage(pre) || getSyntaxHighlighterLanguage(codeEl);
      return fencedCode(lang, codeEl.textContent || "");
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
      const codeEl = el.querySelector("code");
      const preEl = el.querySelector("pre");
      if (!codeEl && !preEl) return "";

      let lang = codeEl ? getSyntaxHighlighterLanguage(codeEl) : "";

      if (!lang && preEl) {
        lang = getSyntaxHighlighterLanguage(preEl);
      }

      const code = (codeEl ?? preEl)?.textContent || "";
      return fencedCode(lang, code);
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
      const body = el.querySelector("ac\\:rich-text-body");
      const inner = body ? td.turndown(body.innerHTML).trim() : content.trim();
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
          const alt = image.getAttribute("alt") || image.getAttribute("ac:alt") || filename;
          return src ? `![${alt}](${src})` : "";
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
      const link = target ? `[${title}](${target})` : title;
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function htmlToMarkdown(html: string, opts?: HtmlToMdOptions): string {
  const cleaned = preprocessConfluenceNoise(html);
  return convertJiraWikiMarkup(buildTurndown(opts).turndown(cleaned)).trim();
}
