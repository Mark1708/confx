import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfluenceApi } from "../../src/lib/confluence-api";
import { extractFromHtml, folderForPage } from "../../src/lib/extractor";
import * as ruleEngine from "../../src/lib/rule-engine";
import type {
  ConfluencePageMeta,
  ExtractedImage,
  ExtractedTable,
  ExtractionRule,
} from "../../src/types";

const fixturePath = path.resolve(process.cwd(), "tests/fixtures/confluence-page.html");

const testMeta: ConfluencePageMeta = {
  id: "123456",
  title: "Компонент Menu",
  spaceKey: "TEST",
  baseUrl: "https://wiki.example.com",
  url: "https://wiki.example.com/pages/viewpage.action?pageId=123456",
  version: 7,
  labels: ["ui", "menu"],
  ancestors: [{ id: "100", title: "UI Kit" }],
  attachmentCount: 2,
};

const allTablesRule: ExtractionRule = {
  id: "all-tables-csv",
  name: "All tables to CSV",
  type: "selector",
  matcher: "table.confluenceTable, div.table-wrap > table",
  action: "to-csv",
  enabled: true,
};

const createApi = (): ConfluenceApi => {
  const api = new ConfluenceApi("https://wiki.example.com", { maxRetries: 0 });
  vi.spyOn(api, "fetchBlob").mockResolvedValue(
    new Blob(["fake-image"], { type: "image/png" }),
  );
  vi.spyOn(api, "fetchJson").mockRejectedValue(new Error("not mocked"));
  return api;
};

describe("folderForPage", () => {
  it("uses slugified title", () => {
    expect(folderForPage({ ...testMeta, title: "Menu Component: API v2" })).toBe(
      "menu-component-api-v2",
    );
  });

  it("falls back to page id when slug is empty", () => {
    expect(folderForPage({ ...testMeta, id: "42", title: "!!!" })).toBe("page-42");
  });
});

describe("extractFromHtml", () => {
  beforeAll(() => {
    vi.stubGlobal("crypto", webcrypto);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("produces only front matter and title for empty HTML", async () => {
    const api = createApi();

    const result = await extractFromHtml(api, "", testMeta, { rules: [] });

    expect(result.markdown).toContain('title: "Компонент Menu"');
    expect(result.markdown).toContain('page_id: "123456"');
    expect(result.markdown).toContain("# Компонент Menu\n\n");
    expect(result.markdown.trim().endsWith("# Компонент Menu")).toBe(true);
    expect(result.tables).toEqual([]);
    expect(result.images).toEqual([]);
    expect(api.fetchBlob).not.toHaveBeenCalled();
  });

  it("converts Confluence fixture headings, tables, callouts, spoilers, images and CSV rules", async () => {
    const api = createApi();
    const html = await readFile(fixturePath, "utf8");
    const applyRulesSpy = vi.spyOn(ruleEngine, "applyRules");

    const result = await extractFromHtml(api, html, testMeta, {
      rules: [allTablesRule],
      folder: folderForPage(testMeta),
    });

    expect(applyRulesSpy).toHaveBeenCalledWith(html, [allTablesRule]);
    expect(result.folder).toBe("компонент-menu");
    expect(result.markdown).toContain("# Компонент Menu");
    expect(result.markdown).toContain("## API компонента");
    expect(result.markdown).toContain("| Свойство | Тип | По умолчанию | Описание |");
    expect(result.markdown).toContain("| `items` | `MenuItem[]` | `[]` | Массив элементов меню |");
    expect(result.markdown).toContain("> **INFO**");
    expect(result.markdown).toContain("Это информационная заметка");
    expect(result.markdown).toContain("> **WARNING**");
    expect(result.markdown).toContain("> **NOTE**");
    expect(result.markdown).toContain("> **TIP**");
    expect(result.markdown).toContain("<details>");
    expect(result.markdown).toContain("<summary>Дополнительные примеры</summary>");
    expect(result.markdown).toContain("![Горизонтальное меню](images/menu-horizontal.png)");
    expect(result.markdown).toContain("![Вертикальное меню](images/menu-vertical.png)");
    expect(result.tables).toHaveLength(4);
    expect(result.tables.map((table: ExtractedTable) => table.name)).toEqual([
      "api-компонента-01.csv",
      "цветовая-схема-02.csv",
      "таблица-с-colspan-03.csv",
      "когда-и-как-применять-04.csv",
    ]);
    expect(result.tables[0].csv).toContain("Свойство,Тип,По умолчанию,Описание");
    expect(result.tables[0].csv).toContain("items,MenuItem[]");
    expect(result.images.map((image: ExtractedImage) => image.zipPath)).toEqual([
      "images/menu-horizontal.png",
      "images/menu-vertical.png",
    ]);
    expect(api.fetchBlob).toHaveBeenCalledTimes(2);
  });

  it("includes front matter by default and excludes it when requested", async () => {
    const defaultResult = await extractFromHtml(createApi(), "<p>Текст</p>", testMeta, { rules: [] });
    const withoutFrontMatter = await extractFromHtml(createApi(), "<p>Текст</p>", testMeta, {
      rules: [],
      includeFrontMatter: false,
    });

    expect(defaultResult.markdown.startsWith("---\n")).toBe(true);
    expect(withoutFrontMatter.markdown.startsWith("# Компонент Menu\n\nТекст")).toBe(true);
    expect(withoutFrontMatter.markdown).not.toContain('page_id: "123456"');
  });

  it("rewrites exported internal Confluence links to relative Markdown paths", async () => {
    const api = createApi();
    const pageIdToFolder = new Map<string, string>([
      ["123456", "components/menu"],
      ["789012", "components/button"],
    ]);
    const html = await readFile(fixturePath, "utf8");

    const result = await extractFromHtml(api, html, testMeta, {
      rules: [],
      folder: "components/menu",
      pageIdToFolder,
      rewriteLinks: true,
      includeFrontMatter: false,
    });

    expect(result.markdown).toContain("[Связанная страница](../button/index.md)");
    expect(result.markdown).toContain("[React документация](https://react.dev/)");
  });

  describe("AbortSignal", () => {
    it("extractFromHtml with pre-aborted signal returns partial result", async () => {
      const api = createApi();
      const controller = new AbortController();
      controller.abort();

      const result = await extractFromHtml(
        api,
        '<p>Текст</p><img src="/download/attachments/123/menu.png" alt="Menu" />',
        testMeta,
        { rules: [], signal: controller.signal },
      );

      expect(result.images).toEqual([]);
      expect(result.markdown).toContain("# Компонент Menu");
      expect(result.markdown).toContain("![Menu](/download/attachments/123/menu.png)");
      expect(api.fetchBlob).not.toHaveBeenCalled();
    });
  });
});
