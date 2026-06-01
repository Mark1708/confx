import { webcrypto } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfluenceApi } from "../../src/lib/confluence-api";
import { extractFromHtml, folderForPage } from "../../src/lib/extractor";
import * as ruleEngine from "../../src/lib/rule-engine";
import type {
  ConfluencePageMeta,
  ExtractedImage,
  ExtractionRule,
} from "../../src/types";
import { readFixtureText } from "../fixtures/fixture-loader";

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

type TestConfluenceApi = ConfluenceApi & {
  fetchBlob: (path: string, signal?: AbortSignal) => Promise<Blob>;
  fetchJson: <T>(path: string, signal?: AbortSignal) => Promise<T>;
};

const createApi = (): TestConfluenceApi => {
  const api = new ConfluenceApi("https://wiki.example.com", {
    maxRetries: 0,
  }) as TestConfluenceApi;
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

  it("converts Confluence fixture headings, macro content, images and CSV rules", async () => {
    const api = createApi();
    const html = await readFixtureText("confluence-page.html");
    const applyRulesSpy = vi.spyOn(ruleEngine, "applyRules");

    const result = await extractFromHtml(api, html, testMeta, {
      rules: [allTablesRule],
      folder: folderForPage(testMeta),
    });

    expect(applyRulesSpy).toHaveBeenCalledWith(html, [allTablesRule]);
    expect(result.folder).toBe("компонент-menu");
    expect(result.markdown).toContain("# Компонент Menu");
    expect(result.markdown).toContain("# Other blocks Page");
    expect(result.markdown).toContain("lorem lorem");
    expect(result.markdown).toContain("Some content 1");
    expect(result.markdown).toContain("Some content 2");
    expect(result.markdown).toContain("Some status");
    expect(result.markdown).toContain("# Выбор макроса");
    expect(result.markdown).toContain("#### Excel");
    expect(result.markdown).toContain("JSM Incident Timeline");
    expect(result.tables).toHaveLength(0);
    expect(result.images.map((image: ExtractedImage) => image.zipPath)).toEqual([
      "images/d90b8bcace50f2043e29a197037f0518.png",
      "images/5ef487744575b30ab14fb111.png",
      "images/wait.png",
      "images/excel.png",
      "images/roadmap.png",
      "images/macro-icon.png",
      "images/icon-attachments.png",
      "images/jira-chart-macro-icon.png",
      "images/icon.png",
      "images/search.png",
      "images/decision-report.png",
      "images/task-report.png",
      "images/jira.png",
      "images/icon-macro-createfromtemplate-80.png",
      "images/macro-icons.png",
    ]);
    expect(api.fetchBlob).toHaveBeenCalledTimes(15);
  });

  it("keeps remote image Markdown and skips image downloads when exportImages is false", async () => {
    const api = createApi();

    const result = await extractFromHtml(
      api,
      '<p>Intro</p><img src="/download/attachments/123/menu.png" alt="Menu" />',
      testMeta,
      { rules: [], exportImages: false, exportAttachments: false },
    );

    expect(result.markdown).toContain("![Menu](/download/attachments/123/menu.png)");
    expect(result.images).toEqual([]);
    expect(result.attachments).toEqual([]);
    expect(api.fetchBlob).not.toHaveBeenCalled();
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
    const html = await readFixtureText("confluence-page.html");

    const result = await extractFromHtml(api, html, testMeta, {
      rules: [],
      folder: "components/menu",
      pageIdToFolder,
      rewriteLinks: true,
      includeFrontMatter: false,
    });

    expect(result.markdown).toContain("# Other blocks Page");
    expect(result.markdown).toContain("Some content 1");
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
