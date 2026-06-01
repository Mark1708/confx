import type { ExtractedTable, ExtractionRule, RulePreset } from "@/types";
import { slugify, tableFilename, tableToCsv } from "./table-to-csv";

export interface RuleEngineResult {
  /** HTML that will be passed to Turndown. Tables stay in place — CSV export is additive. */
  mainHtml: string;
  /** Tables additionally extracted to CSV files (table also remains inline in MD). */
  tables: ExtractedTable[];
}

/**
 * Apply rules to a cloned HTML document. `to-csv` only DUPLICATES tables into CSV files;
 * tables always remain in HTML so that Turndown converts them to GFM inside the Markdown.
 * `skip` hard-removes elements from HTML.
 */
export function applyRules(html: string, rules: ExtractionRule[]): RuleEngineResult {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const tables: ExtractedTable[] = [];

  const sectionMap = buildSectionMap(doc);

  // Stable set of tables already exported as CSV — avoid dupes when selectors overlap.
  const csvEmitted = new WeakSet<HTMLTableElement>();
  let tableIdx = 0;

  for (const rule of rules.filter((r) => r.enabled)) {
    if (rule.type === "selector") {
      handleNodes(
        safeQueryAll(doc, rule.matcher),
        rule,
        sectionMap,
        tables,
        csvEmitted,
        () => tableIdx++,
      );
    } else if (rule.type === "table") {
      const nodes = safeQueryAll(doc, rule.matcher).filter(
        (n): n is HTMLTableElement => n.tagName === "TABLE",
      );
      handleNodes(nodes, rule, sectionMap, tables, csvEmitted, () => tableIdx++);
    } else if (rule.type === "section") {
      let re: RegExp;
      try {
        re = new RegExp(rule.matcher, "i");
      } catch {
        continue;
      }
      const headings = Array.from(doc.querySelectorAll("h1,h2,h3,h4,h5,h6")).filter((h) =>
        re.test(h.textContent?.trim() ?? ""),
      );
      for (const heading of headings) {
        const blockElements = collectSection(heading);
        // For section rules, we look at the contained tables (and wrappers).
        const nodes = blockElements.flatMap((el) => {
          const tbl = el.matches("table")
            ? [el as HTMLTableElement]
            : (Array.from(el.querySelectorAll("table")) as HTMLTableElement[]);
          return tbl as Element[];
        });
        handleNodes(nodes, rule, sectionMap, tables, csvEmitted, () => tableIdx++);
      }
    } else if (rule.type === "spoiler") {
      const nodes = Array.from(doc.querySelectorAll(".expand-container"));
      handleNodes(nodes, rule, sectionMap, tables, csvEmitted, () => tableIdx++);
    }
  }

  return { mainHtml: doc.body.innerHTML, tables };
}

function safeQueryAll(doc: Document, selector: string): Element[] {
  try {
    return Array.from(doc.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function handleNodes(
  nodes: Element[],
  rule: ExtractionRule,
  sectionMap: Map<Element, string>,
  tables: ExtractedTable[],
  csvEmitted: WeakSet<HTMLTableElement>,
  nextIdx: () => number,
): void {
  for (const node of nodes) {
    switch (rule.action) {
      case "skip":
        node.remove();
        break;
      case "to-csv": {
        const table =
          node.tagName === "TABLE"
            ? (node as HTMLTableElement)
            : (node.querySelector("table") as HTMLTableElement | null);
        if (table && !csvEmitted.has(table) && !isConfluenceUiTable(table)) {
          emitCsv(table, sectionMap, tables, nextIdx());
          csvEmitted.add(table);
          if (rule.options?.removeAfterCsv === true) {
            table.remove();
          }
        }
        break;
      }
      case "gfm-table":
        // Strip sortable chrome so our converter sees clean structure.
        if (node.tagName === "TABLE") {
          node.classList.remove("tablesorter", "tablesorter-default", "stickyTableHeaders");
        }
        break;
      case "keep-html":
        node.setAttribute("data-keep-html", "1");
        break;
      case "extract-images":
        node.setAttribute("data-image-group", rule.id);
        break;
      case "to-md":
        // default — no-op
        break;
    }
  }
}

function isConfluenceUiTable(table: HTMLTableElement): boolean {
  const context = table.closest(
    '[data-macro-name="attachments"], .plugin_attachments_container, #attachments, #attachment-list, .attachments-container',
  );
  if (context) return true;

  const idAndClass = `${table.id} ${table.className}`.toLowerCase();
  if (idAndClass.includes("attachment")) return true;

  const headerText = Array.from(table.querySelectorAll("th"))
    .map((cell) => cell.textContent?.trim() ?? "")
    .join("|")
    .toLowerCase();
  const bodyText = table.textContent?.toLowerCase() ?? "";
  const hasAttachmentHeaders =
    (headerText.includes("файл") && headerText.includes("изменено")) ||
    (headerText.includes("file") && headerText.includes("modified"));
  const hasAttachmentUiText =
    bodyText.includes("файлов еще нет") ||
    bodyText.includes("загрузить файл") ||
    bodyText.includes("drop files to attach") ||
    bodyText.includes("upload file");

  return hasAttachmentHeaders && hasAttachmentUiText;
}

function emitCsv(
  table: HTMLTableElement,
  sectionMap: Map<Element, string>,
  tables: ExtractedTable[],
  idx: number,
): void {
  const section = sectionMap.get(table);
  const csv = tableToCsv(table);
  const name = tableFilename(section, idx);
  tables.push({ csv, name, section });
}

function buildSectionMap(doc: Document): Map<Element, string> {
  const map = new Map<Element, string>();
  let currentSection = "";
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
  let node = walker.currentNode as Element | null;
  while (node) {
    if (node instanceof Element) {
      if (/^H[1-3]$/.test(node.tagName)) {
        currentSection = slugify(node.textContent?.trim() ?? "") || currentSection;
      }
      map.set(node, currentSection);
    }
    node = walker.nextNode() as Element | null;
  }
  return map;
}

function collectSection(heading: Element): Element[] {
  const level = Number(heading.tagName.slice(1));
  const out: Element[] = [];
  let sibling = heading.nextElementSibling;
  while (sibling) {
    if (/^H[1-6]$/.test(sibling.tagName)) {
      const sibLevel = Number(sibling.tagName.slice(1));
      if (sibLevel <= level) break;
    }
    out.push(sibling);
    sibling = sibling.nextElementSibling;
  }
  return out;
}

export const MD_ONLY_PRESET: RulePreset = {
  id: "md-only",
  name: "MD-only",
  description:
    "Текстовый контент и таблицы остаются в Markdown. CSV, изображения и файлы не генерируются.",
  rules: [],
};

export const MD_ATTACHMENTS_PRESET: RulePreset = {
  id: "md-attachments",
  name: "MD with attachments",
  description: "Экспортирует текстовый контент, Markdown-таблицы, изображения и файлы вложений.",
  rules: [],
};

export const GENERIC_PRESET: RulePreset = {
  ...MD_ONLY_PRESET,
  id: "generic",
  name: "Generic (только MD)",
  description: "Все таблицы и контент остаются в Markdown. CSV не генерируются.",
};

export const ALL_TABLES_CSV_PRESET: RulePreset = {
  id: "all-csv",
  name: "MD + все таблицы в CSV",
  description: "Каждая таблица дополнительно сохраняется в отдельный CSV (MD при этом полон).",
  rules: [
    {
      id: "all-tables-csv",
      name: "Все таблицы → +CSV",
      type: "selector",
      matcher: "table.confluenceTable, div.table-wrap > table",
      action: "to-csv",
      enabled: true,
    },
  ],
};

export const FULL_PAGE_PRESET: RulePreset = {
  id: "full-page",
  name: "Полная страница",
  description: "Экспортирует весь контент страницы, удаляя только навигационный chrome Confluence.",
  rules: [
    {
      id: "navigation-chrome-skip",
      name: "Навигационный chrome → пропустить",
      type: "selector",
      matcher: ".page-metadata, #breadcrumb-section",
      action: "skip",
      enabled: true,
    },
  ],
};

export const TABLES_ONLY_PRESET: RulePreset = {
  id: "tables-only",
  name: "Только таблицы",
  description:
    "Экспортирует только реальные пользовательские таблицы в CSV без Markdown-копий и UI-таблиц Confluence.",
  rules: [
    {
      id: "tables-only-all-csv",
      name: "Все таблицы → +CSV",
      type: "selector",
      matcher: "table.confluenceTable, div.table-wrap > table, table",
      action: "to-csv",
      enabled: true,
      options: { removeAfterCsv: true },
    },
    {
      id: "tables-only-content-skip",
      name: "Нетабличный контент → пропустить",
      type: "selector",
      matcher: ".page-metadata, #breadcrumb-section, p, ul, ol, pre, blockquote",
      action: "skip",
      enabled: true,
    },
  ],
};

export const API_DOC_PRESET: RulePreset = {
  id: "api-doc",
  name: "API-документация",
  description: "Извлекает таблицы endpoint-описаний в CSV, сохраняя блоки кода как HTML.",
  rules: [
    {
      id: "api-endpoint-tables-csv",
      name: "Таблицы endpoint → +CSV",
      type: "selector",
      matcher: "table.confluenceTable, div.table-wrap > table, table.api, table.endpoints",
      action: "to-csv",
      enabled: true,
    },
    {
      id: "api-code-blocks-keep-html",
      name: "Блоки кода → сохранить HTML",
      type: "selector",
      matcher: "pre, code, .code, .syntaxhighlighter, .codeContent",
      action: "keep-html",
      enabled: true,
    },
  ],
};

export const DEFAULT_PRESET_ID = MD_ATTACHMENTS_PRESET.id;

export const PRESETS: RulePreset[] = [MD_ATTACHMENTS_PRESET, MD_ONLY_PRESET, TABLES_ONLY_PRESET];

const LEGACY_PRESET_ALIASES: Readonly<Record<string, RulePreset>> = {
  generic: MD_ONLY_PRESET,
  "all-csv": MD_ATTACHMENTS_PRESET,
  "full-page": MD_ATTACHMENTS_PRESET,
  "api-doc": MD_ATTACHMENTS_PRESET,
};

interface RulesExportPayload {
  version: 1;
  preset: RulePreset;
  customRules: ExtractionRule[];
}

const RULES_EXPORT_VERSION = 1;

export function exportRules(preset: RulePreset, customRules: ExtractionRule[]): string {
  return JSON.stringify({ version: RULES_EXPORT_VERSION, preset, customRules });
}

export function importRules(json: string): { preset: RulePreset; customRules: ExtractionRule[] } {
  const payload = parseRulesPayload(json);
  return {
    preset: payload.preset,
    customRules: payload.customRules,
  };
}

function parseRulesPayload(json: string): RulesExportPayload {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("Invalid rules JSON");
  }

  if (!isRecord(value) || value.version !== RULES_EXPORT_VERSION) {
    throw new Error("Invalid rules export version");
  }
  if (!isRulePreset(value.preset)) {
    throw new Error("Invalid rules preset");
  }
  if (!Array.isArray(value.customRules) || !value.customRules.every(isExtractionRule)) {
    throw new Error("Invalid custom rules");
  }

  return {
    version: RULES_EXPORT_VERSION,
    preset: value.preset,
    customRules: value.customRules,
  };
}

function isRulePreset(value: unknown): value is RulePreset {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    Array.isArray(value.rules) &&
    value.rules.every(isExtractionRule)
  );
}

function isExtractionRule(value: unknown): value is ExtractionRule {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    isRuleType(value.type) &&
    typeof value.matcher === "string" &&
    isRuleAction(value.action) &&
    typeof value.enabled === "boolean" &&
    (value.options === undefined || isRuleOptions(value.options))
  );
}

function isRuleType(value: unknown): value is ExtractionRule["type"] {
  return value === "selector" || value === "section" || value === "spoiler" || value === "table";
}

function isRuleAction(value: unknown): value is ExtractionRule["action"] {
  return (
    value === "skip" ||
    value === "to-csv" ||
    value === "to-md" ||
    value === "extract-images" ||
    value === "keep-html" ||
    value === "gfm-table"
  );
}

function isRuleOptions(value: unknown): value is NonNullable<ExtractionRule["options"]> {
  return isRecord(value) && Object.values(value).every(isRuleOptionValue);
}

function isRuleOptionValue(value: unknown): value is boolean | string | number {
  return typeof value === "boolean" || typeof value === "string" || typeof value === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getPreset(id: string): RulePreset {
  return PRESETS.find((p) => p.id === id) ?? LEGACY_PRESET_ALIASES[id] ?? MD_ATTACHMENTS_PRESET;
}
