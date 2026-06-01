import { describe, expect, it } from "vitest";

import {
  ALL_TABLES_CSV_PRESET,
  API_DOC_PRESET,
  applyRules,
  DEFAULT_PRESET_ID,
  exportRules,
  FULL_PAGE_PRESET,
  GENERIC_PRESET,
  getPreset,
  importRules,
  MD_ATTACHMENTS_PRESET,
  MD_ONLY_PRESET,
  PRESETS,
  TABLES_ONLY_PRESET,
} from "../../src/lib/rule-engine";
import type { ExtractionRule } from "../../src/types";

function parseMainHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function makeRule(overrides: Partial<ExtractionRule>): ExtractionRule {
  return {
    id: "test-rule",
    name: "Test rule",
    type: "selector",
    matcher: ".target",
    action: "to-md",
    enabled: true,
    ...overrides,
  };
}

describe("applyRules", () => {
  it("returns HTML unchanged with no tables when rules array is empty", () => {
    const html = '<article><h1>Title</h1><p class="body">Text</p></article>';

    const result = applyRules(html, []);

    expect(result).toEqual({ mainHtml: html, tables: [] });
  });

  it('removes matching elements for selector rules with action "skip"', () => {
    const html = '<main><p>Keep</p><aside class="noise">Drop</aside></main>';

    const result = applyRules(html, [makeRule({ action: "skip", matcher: ".noise" })]);
    const doc = parseMainHtml(result.mainHtml);

    expect(doc.querySelector(".noise")).toBeNull();
    expect(doc.querySelector("main")?.textContent).toContain("Keep");
    expect(result.tables).toEqual([]);
  });

  it('extracts a matching selector table to CSV and keeps the table in HTML for action "to-csv"', () => {
    const html = `
      <h1>API Component</h1>
      <table class="confluenceTable target">
        <tr><th>Prop</th><th>Type</th></tr>
        <tr><td>disabled</td><td>boolean</td></tr>
      </table>
    `;

    const result = applyRules(html, [makeRule({ action: "to-csv", matcher: "table.target" })]);
    const doc = parseMainHtml(result.mainHtml);

    expect(doc.querySelector("table.target")).not.toBeNull();
    expect(result.tables).toEqual([
      {
        csv: "Prop,Type\ndisabled,boolean",
        name: "api-component-01.csv",
        section: "api-component",
      },
    ]);
  });

  it("finds matching section headings by regex and extracts content tables", () => {
    const html = `
      <h2>API компонента</h2>
      <p>Intro</p>
      <table class="api-table"><tr><td>Name</td><td>Value</td></tr></table>
      <h2>Other section</h2>
      <table class="other-table"><tr><td>Skip</td></tr></table>
    `;

    const result = applyRules(html, [
      makeRule({ type: "section", matcher: "API\\s+компонента", action: "to-csv" }),
    ]);

    expect(result.tables).toEqual([
      {
        csv: "Name,Value",
        name: "api-компонента-01.csv",
        section: "api-компонента",
      },
    ]);
  });

  it('processes .expand-container elements for spoiler rules with action "to-csv"', () => {
    const html = `
      <h1>Details</h1>
      <div class="expand-container">
        <p>Collapsed content</p>
        <table><tr><td>Hidden</td><td>Value</td></tr></table>
      </div>
    `;

    const result = applyRules(html, [
      makeRule({ type: "spoiler", matcher: "ignored", action: "to-csv" }),
    ]);

    expect(result.tables).toEqual([
      {
        csv: "Hidden,Value",
        name: "details-01.csv",
        section: "details",
      },
    ]);
  });

  it("filters table rules to TABLE elements only", () => {
    const html = `
      <h1>Mixed Nodes</h1>
      <div class="target"><table><tr><td>Wrapped</td></tr></table></div>
      <table class="target"><tr><td>Direct</td></tr></table>
    `;

    const result = applyRules(html, [
      makeRule({ type: "table", matcher: ".target", action: "to-csv" }),
    ]);

    expect(result.tables).toEqual([
      {
        csv: "Direct",
        name: "mixed-nodes-01.csv",
        section: "mixed-nodes",
      },
    ]);
  });

  it('strips tablesorter classes for action "gfm-table"', () => {
    const html = `
      <table class="tablesorter tablesorter-default stickyTableHeaders confluenceTable">
        <tr><td>Cell</td></tr>
      </table>
    `;

    const result = applyRules(html, [
      makeRule({ type: "table", matcher: "table", action: "gfm-table" }),
    ]);
    const table = parseMainHtml(result.mainHtml).querySelector("table");

    expect(table?.className).toBe("confluenceTable");
    expect(result.tables).toEqual([]);
  });

  it('sets data-keep-html for action "keep-html"', () => {
    const html = '<section class="target"><p>Raw HTML block</p></section>';

    const result = applyRules(html, [makeRule({ action: "keep-html", matcher: ".target" })]);
    const section = parseMainHtml(result.mainHtml).querySelector("section");

    expect(section?.getAttribute("data-keep-html")).toBe("1");
    expect(result.tables).toEqual([]);
  });

  it('sets data-image-group for action "extract-images"', () => {
    const html = '<figure class="target"><img src="image.png" alt="Preview"></figure>';

    const result = applyRules(html, [
      makeRule({ id: "gallery-images", action: "extract-images", matcher: ".target" }),
    ]);
    const figure = parseMainHtml(result.mainHtml).querySelector("figure");

    expect(figure?.getAttribute("data-image-group")).toBe("gallery-images");
    expect(result.tables).toEqual([]);
  });

  it('leaves matching nodes unchanged for action "to-md"', () => {
    const html = '<div class="target"><strong>Markdown content</strong></div>';

    const result = applyRules(html, [makeRule({ action: "to-md", matcher: ".target" })]);

    expect(result).toEqual({ mainHtml: html, tables: [] });
  });

  it("skips disabled rules", () => {
    const html = '<main><p class="target">Should stay</p></main>';

    const result = applyRules(html, [
      makeRule({ action: "skip", matcher: ".target", enabled: false }),
    ]);

    expect(result).toEqual({ mainHtml: html, tables: [] });
  });

  it("handles invalid section regex without crashing", () => {
    const html = '<section><h2>API</h2><p class="target">Cell</p></section>';

    expect(() =>
      applyRules(html, [makeRule({ type: "section", matcher: "(", action: "to-csv" })]),
    ).not.toThrow();
    expect(applyRules(html, [makeRule({ type: "section", matcher: "(", action: "to-csv" })])).toEqual({
      mainHtml: html,
      tables: [],
    });
  });

  it("handles invalid CSS selectors without crashing", () => {
    const html = '<main><p class="target">Should stay</p></main>';

    expect(() => applyRules(html, [makeRule({ action: "skip", matcher: "[" })])).not.toThrow();
    expect(applyRules(html, [makeRule({ action: "skip", matcher: "[" })])).toEqual({
      mainHtml: html,
      tables: [],
    });
  });

  it("deduplicates CSV output when the same table is matched by multiple rules", () => {
    const html = `
      <h1>Duplicate CSV</h1>
      <table class="target confluenceTable"><tr><td>Only once</td></tr></table>
    `;

    const result = applyRules(html, [
      makeRule({ id: "first", action: "to-csv", matcher: "table.target" }),
      makeRule({ id: "second", type: "table", action: "to-csv", matcher: ".confluenceTable" }),
    ]);

    expect(result.tables).toEqual([
      {
        csv: "Only once",
        name: "duplicate-csv-01.csv",
        section: "duplicate-csv",
      },
    ]);
  });

  it("does not export Confluence attachments macro tables as CSV", () => {
    const html = `
      <h1>Other blocks</h1>
      <div class="conf-macro" data-macro-name="attachments">
        <table class="confluenceTable">
          <tr><th></th><th>Файл</th><th>Изменено</th></tr>
          <tr><td colspan="3">Файлов еще нет. Загрузить файл</td></tr>
        </table>
      </div>
      <table class="confluenceTable target">
        <tr><th>Columnt 1</th><th>Columnt 2</th><th>Columnt 3</th></tr>
        <tr><td>1</td><td>2</td><td>3</td></tr>
      </table>
    `;

    const result = applyRules(html, [makeRule({ action: "to-csv", matcher: "table" })]);

    expect(result.tables).toEqual([
      {
        csv: "Columnt 1,Columnt 2,Columnt 3\n1,2,3",
        name: "other-blocks-01.csv",
        section: "other-blocks",
      },
    ]);
  });

  it("tables-only preset removes real tables after CSV extraction", () => {
    const html = `
      <h1>Table Page</h1>
      <p>Intro text</p>
      <table class="confluenceTable">
        <tr><th>Columnt 1</th><th>Columnt 2</th><th>Columnt 3</th></tr>
        <tr><td>1</td><td>2</td><td>3</td></tr>
      </table>
    `;

    const result = applyRules(html, TABLES_ONLY_PRESET.rules);

    expect(result.tables).toHaveLength(1);
    expect(result.tables[0].csv).toBe("Columnt 1,Columnt 2,Columnt 3\n1,2,3");
    expect(parseMainHtml(result.mainHtml).querySelector("table")).toBeNull();
  });
});

describe("presets", () => {
  it("defines GENERIC_PRESET with no rules", () => {
    expect(GENERIC_PRESET).toMatchObject({
      id: "generic",
      rules: [],
    });
  });

  it("defines ALL_TABLES_CSV_PRESET with one CSV selector rule", () => {
    expect(ALL_TABLES_CSV_PRESET.rules).toEqual([
      {
        id: "all-tables-csv",
        name: "Все таблицы → +CSV",
        type: "selector",
        matcher: "table.confluenceTable, div.table-wrap > table",
        action: "to-csv",
        enabled: true,
      },
    ]);
  });

  it("contains all built-in presets in PRESETS", () => {
    expect(PRESETS).toEqual([MD_ATTACHMENTS_PRESET, MD_ONLY_PRESET, TABLES_ONLY_PRESET]);
    expect(DEFAULT_PRESET_ID).toBe("md-attachments");
  });

  it("returns matching presets by id and maps legacy ids to current presets", () => {
    expect(getPreset("md-attachments")).toBe(MD_ATTACHMENTS_PRESET);
    expect(getPreset("md-only")).toBe(MD_ONLY_PRESET);
    expect(getPreset("tables-only")).toBe(TABLES_ONLY_PRESET);
    expect(getPreset("generic")).toBe(MD_ONLY_PRESET);
    expect(getPreset("all-csv")).toBe(MD_ATTACHMENTS_PRESET);
    expect(getPreset("full-page")).toBe(MD_ATTACHMENTS_PRESET);
    expect(getPreset("api-doc")).toBe(MD_ATTACHMENTS_PRESET);
    expect(getPreset("unknown-preset")).toBe(MD_ATTACHMENTS_PRESET);
  });

  it("keeps legacy preset constants importable for old rule export files", () => {
    expect(GENERIC_PRESET.id).toBe("generic");
    expect(ALL_TABLES_CSV_PRESET.id).toBe("all-csv");
    expect(FULL_PAGE_PRESET.id).toBe("full-page");
    expect(API_DOC_PRESET.id).toBe("api-doc");
  });
});

describe("import/export", () => {
  it("roundtrips exported preset and custom rules", () => {
    const customRules = [
      makeRule({
        id: "custom-skip-footer",
        name: "Custom skip footer",
        matcher: ".footer",
        action: "skip",
        options: { reason: "noise", priority: 1, userDefined: true },
      }),
    ];

    const json = exportRules(FULL_PAGE_PRESET, customRules);

    expect(JSON.parse(json)).toMatchObject({ version: 1 });
    expect(importRules(json)).toEqual({ preset: FULL_PAGE_PRESET, customRules });
  });

  it("throws for invalid JSON", () => {
    expect(() => importRules("{")).toThrow();
  });

  it("throws when version is missing", () => {
    const json = JSON.stringify({ preset: GENERIC_PRESET, customRules: [] });

    expect(() => importRules(json)).toThrow();
  });
});

describe("new presets", () => {
  it("defines FULL_PAGE_PRESET with expected id, name, and rules", () => {
    expect(FULL_PAGE_PRESET).toMatchObject({
      id: "full-page",
      name: expect.any(String),
    });
    expect(FULL_PAGE_PRESET.rules).toEqual([
      {
        id: "navigation-chrome-skip",
        name: "Навигационный chrome → пропустить",
        type: "selector",
        matcher: ".page-metadata, #breadcrumb-section",
        action: "skip",
        enabled: true,
      },
    ]);
  });

  it("defines TABLES_ONLY_PRESET with expected id, name, and rules", () => {
    expect(TABLES_ONLY_PRESET).toMatchObject({
      id: "tables-only",
      name: expect.any(String),
    });
    expect(TABLES_ONLY_PRESET.rules).toEqual([
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
    ]);
  });

  it("defines API_DOC_PRESET with expected id, name, and rules", () => {
    expect(API_DOC_PRESET).toMatchObject({
      id: "api-doc",
      name: expect.any(String),
    });
    expect(API_DOC_PRESET.rules).toEqual([
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
    ]);
  });
});
