import { Blob as NodeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConfluencePageRaw } from "@/lib/confluence-api";
import { produceConfluenceExport } from "@/lib/export/confluence";
import { capturePageInventory, serializeConfluenceExportManifest } from "@/lib/export-manifest";
import { writePageEntries } from "@/lib/export/package-writer";
import { collectEntries, collectExport } from "../helpers/export-collector";
import { prepareExport } from "@/lib/export/prepare";
import { createExportDefaults, migrateSettings } from "@/lib/settings";
import type { SourceContext } from "@/lib/source-context";
import type { ExportPresetId, ExtractedPage } from "@/types";

const SOURCE: SourceContext = {
  tabId: 1,
  windowId: 1,
  product: "confluence",
  baseUrl: "https://wiki.example.com",
  pageUrl: "https://wiki.example.com/pages/viewpage.action?pageId=100",
  pageId: "100",
  spaceKey: "DOC",
};
const originalFetch = globalThis.fetch;

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => vi.stubGlobal("Blob", NodeBlob));
afterEach(() => vi.unstubAllGlobals());

function settingsFor(presetId: ExportPresetId) {
  const settings = migrateSettings(undefined);
  settings.exportDefaults = createExportDefaults(presetId);
  settings.maxRetries = 0;
  return settings;
}

describe("sidepanel extraction", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock;
    vi.stubGlobal("crypto", webcrypto);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("extractSubtree skips inline image downloads for the md-only preset", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      const expand = url.searchParams.get("expand") ?? "";

      if (url.pathname === "/rest/api/content/100" && expand.includes("body.view")) {
        return jsonResponse(makePageWithImage());
      }

      if (url.pathname === "/rest/api/content/100") {
        return jsonResponse(makePage());
      }

      if (url.pathname === "/rest/api/content/100/child/page") {
        return jsonResponse({ results: [], size: 0 });
      }

      if (url.pathname === "/rest/api/content/100/comment") {
        return jsonResponse({ results: [] });
      }

      if (url.pathname === "/rest/inlinecomments/1.0/comments") {
        return jsonResponse([]);
      }

      if (url.pathname === "/rest/api/content/100/version") {
        return jsonResponse({ results: [] });
      }

      throw new Error(`Unexpected request: ${url.toString()}`);
    });

    const result = await collectExport(produceConfluenceExport,
      prepareExport(
        SOURCE,
        {
          kind: "extract-subtree",
          rootPageId: "100",
          host: "https://wiki.example.com",
          presetId: "md-only",
          maxDepth: 1,
        },
        settingsFor("md-only"),
      ),
    );

    const requestedUrls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(requestedUrls).not.toContain(
      "https://wiki.example.com/download/attachments/100/chart.png",
    );
    expect(requestedUrls.some((url) => url.includes("/download/attachments/"))).toBe(false);
    expect(requestedUrls.some((url) => url.startsWith("https://www.plantuml.com/"))).toBe(false);
    const entries = unzipSync(new Uint8Array(await result.zipBlob.arrayBuffer()));
    expect(strFromU8(entries["root-page/root-page/index.md"])).toContain(
      `[Diagram](https://www.plantuml.com/plantuml/uml/SyfFKj2rKt3CoKnELR1Io4ZDoSa70000)`,
    );
  });

  it("places watch-changed pages in flat ID-namespaced folders", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      const pageMatch = url.pathname.match(/^\/rest\/api\/content\/(100|200)$/);

      if (pageMatch && url.searchParams.get("expand")?.includes("body.view")) {
        return jsonResponse(makeWatchPage(pageMatch[1]));
      }
      if (/\/rest\/api\/content\/(100|200)\/comment$/.test(url.pathname)) {
        return jsonResponse({ results: [] });
      }
      if (url.pathname === "/rest/inlinecomments/1.0/comments") {
        return jsonResponse([]);
      }
      if (/\/rest\/api\/content\/(100|200)\/version$/.test(url.pathname)) {
        return jsonResponse({ results: [] });
      }

      throw new Error(`Unexpected request: ${url.toString()}`);
    });

    const result = await collectExport(produceConfluenceExport,
      prepareExport(
        SOURCE,
        {
          kind: "extract-watch-changed",
          host: "https://wiki.example.com",
          presetId: "md-only",
          pageIds: ["100", "200"],
          rootTitle: "Watch Root",
          diff: { changed: ["100", "200"] },
        },
        settingsFor("md-only"),
      ),
    );
    const entries = unzipSync(new Uint8Array(await result.zipBlob.arrayBuffer()));
    const root = "watch-root-changed";
    const manifest = JSON.parse(strFromU8(entries[`${root}/manifest.json`]));

    expect(strFromU8(entries[`${root}/pages/100/index.md`])).toContain("# Page 100");
    expect(strFromU8(entries[`${root}/pages/200/index.md`])).toContain("# Page 200");
    expect(entries[`${root}/index.md`]).toBeUndefined();
    expect(manifest).toMatchObject({
      manifest_version: 2,
      type: "watch-changed",
      counts: { pages: 2 },
    });
    expect(manifest.pages.map((page: { archive_path: string }) => page.archive_path)).toEqual([
      "pages/100/index.md",
      "pages/200/index.md",
    ]);
  });

  it("materializes PlantUML pairs in an md-attachments space archive", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      const expand = url.searchParams.get("expand") ?? "";

      if (url.hostname === "www.plantuml.com") {
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { "Content-Type": "image/png" },
        });
      }
      if (url.pathname === "/rest/api/space/DOC" && expand.includes("description.plain")) {
        return jsonResponse({ key: "DOC", name: "Docs", homepage: { id: "100" } });
      }
      if (url.pathname === "/rest/api/space/DOC/content/page") {
        return jsonResponse({ results: url.searchParams.get("start") === "0" ? [makePage()] : [] });
      }
      if (url.pathname === "/rest/api/content/100" && expand.includes("body.view")) {
        return jsonResponse(makePageWithPlantUml());
      }
      if (url.pathname === "/rest/api/content/100/child/attachment") {
        return jsonResponse({ results: [] });
      }
      if (url.pathname === "/rest/api/content/100/comment") {
        return jsonResponse({ results: [] });
      }
      if (url.pathname === "/rest/inlinecomments/1.0/comments") {
        return jsonResponse([]);
      }
      if (url.pathname === "/rest/api/content/100/version") {
        return jsonResponse({ results: [] });
      }

      throw new Error(`Unexpected request: ${url.toString()}`);
    });

    const result = await collectExport(produceConfluenceExport,
      prepareExport(
        SOURCE,
        {
          kind: "extract-space",
          host: "https://wiki.example.com",
          spaceKey: "DOC",
          presetId: "md-attachments",
        },
        settingsFor("md-attachments"),
      ),
    );
    const entries = unzipSync(new Uint8Array(await result.zipBlob.arrayBuffer()));
    const markdown = strFromU8(entries["docs/root-page/index.md"]);
    const manifest = JSON.parse(strFromU8(entries["docs/space-manifest.json"]));
    const pngPath = markdown.match(
      /!\[Diagram\]\((attachments\/linked\/plantuml\/plantuml-[a-f0-9]{64}\.png)\)/,
    )?.[1];

    expect(pngPath).toBeDefined();
    expect(entries[`docs/root-page/${pngPath}`]).toBeDefined();
    expect(entries[`docs/root-page/${pngPath?.replace(/\.png$/, ".puml")}`]).toBeDefined();
    expect(manifest.counts.plantuml_diagrams).toBe(1);
    expect(manifest.pages[0]).toMatchObject({
      archive_path: "root-page/index.md",
      plantuml_outcome: { archived: 1 },
    });
  });

  it("rejects a ready ZIP when a later page source exhausts its attempts", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/rest/api/content/100") return jsonResponse(makePage());
      if (url.pathname === "/rest/api/content/200") return new Response("", { status: 503 });
      if (url.pathname === "/rest/api/content/100/child/page") {
        return jsonResponse({ results: url.searchParams.get("start") === "0" ? [makeWatchPage("200")] : [] });
      }
      if (url.pathname.endsWith("/child/page")) return jsonResponse({ results: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    const settings = settingsFor("md-only");
    settings.exportDefaults.package.editable = false;
    settings.exportDefaults.package.comments = false;
    settings.exportDefaults.package.history = false;
    await expect(collectExport(produceConfluenceExport, prepareExport(
      SOURCE, { kind: "extract-subtree", host: SOURCE.baseUrl, rootPageId: "100" }, settings,
    ))).rejects.toMatchObject({ name: "PageSourceError", pageId: "200" });
  });
});

describe("space archive layout", () => {
  it("writes unified comments metadata, comment binaries, and aggregate attachment counts", async () => {
    const page = makeExtractedPage();
    const manifest = serializeConfluenceExportManifest({
      type: "space",
      preset: "md-attachments",
      source: {
        host: "https://wiki.example.com", space: "DOC", spaceName: "Docs",
        requestedPages: 1, skippedPages: 0,
      },
      pages: [capturePageInventory(page, "space")],
      additionalCounts: { requested_pages: 1, exported_pages: 1, skipped_pages: 0 },
    });
    const signal = new AbortController().signal;
    const blob = await collectEntries("docs", async (emit) => {
      await writePageEntries(page, emit, signal);
      await emit({ path: "space-manifest.json", body: manifest });
    }, signal);
    const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const comments = JSON.parse(strFromU8(entries["docs/root-page/comments.json"]));
    const parsedManifest = JSON.parse(strFromU8(entries["docs/space-manifest.json"]));

    expect(comments.comments).toEqual([]);
    expect(comments.inlineComments[0].replies[0].id).toBe("reply-1");
    expect(strFromU8(entries["docs/root-page/attachments/comments/reply-1/report.pdf"])).toBe(
      "space reply",
    );
    expect(strFromU8(entries["docs/root-page/attachments/linked/plantuml/diagram.png"])).toBe(
      "png",
    );
    expect(strFromU8(entries["docs/root-page/attachments/linked/plantuml/diagram.puml"])).toBe(
      "@startuml\nA -> B\n@enduml",
    );
    expect(entries["docs/root-page/inline-comments.json"]).toBeUndefined();
    expect(parsedManifest.counts.attachments).toBe(1);
    expect(parsedManifest.counts.plantuml_diagrams).toBe(1);
    expect(parsedManifest).toMatchObject({
      manifest_version: 2,
      type: "space",
      counts: {
        pages: 1,
        requested_pages: 1,
        exported_pages: 1,
        skipped_pages: 0,
      },
      pages: [{ id: "100", archive_path: "root-page/index.md", origin: "space" }],
      failures: [],
    });
  });

  it("rejects duplicate space page index paths", async () => {
    const page = makeExtractedPage();
    const duplicate = {
      ...makeExtractedPage(),
      meta: { ...makeExtractedPage().meta, id: "duplicate" },
    };

    const signal = new AbortController().signal;
    await expect(collectEntries("docs", async (emit) => {
      await writePageEntries(page, emit, signal);
      await writePageEntries(duplicate, emit, signal);
    }, signal)).rejects.toThrow(/duplicate/i);
  });
});

function makeExtractedPage(): ExtractedPage {
  const blob = new Blob(["space reply"], { type: "application/pdf" });
  const plantUmlPng = new Blob(["png"], { type: "image/png" });
  const plantUmlSource = new Blob(["@startuml\nA -> B\n@enduml"], { type: "text/plain" });
  return {
    meta: {
      id: "100",
      title: "Root Page",
      spaceKey: "DOC",
      baseUrl: "https://wiki.example.com",
      url: "https://wiki.example.com/pages/viewpage.action?pageId=100",
    },
    markdown: "# Root Page\n\nBody",
    tables: [],
    images: [],
    attachments: [],
    plantUmlAssets: [
      {
        png: {
          archivePath: "root-page/attachments/linked/plantuml/diagram.png",
          fileName: "diagram.png",
          mediaType: "image/png",
          fileSize: plantUmlPng.size,
          blob: plantUmlPng,
          hash: "plantuml-png",
        },
        source: {
          archivePath: "root-page/attachments/linked/plantuml/diagram.puml",
          fileName: "diagram.puml",
          mediaType: "text/plain",
          fileSize: plantUmlSource.size,
          blob: plantUmlSource,
          hash: "plantuml-source",
        },
      },
    ],
    commentAttachments: [
      {
        sourceUrl: "/download/report",
        archivePath: "root-page/attachments/comments/reply-1/report.pdf",
        fileName: "report.pdf",
        mediaType: "application/pdf",
        fileSize: blob.size,
        blob,
        hash: "reply-hash",
      },
    ],
    comments: [],
    inlineComments: [
      {
        id: "inline-1",
        author: "Alice",
        updatedAt: "2025-03-01T10:00:00Z",
        body: "<p>Inline</p>",
        markdown: "Inline",
        attachments: [],
        selection: "text",
        markerRef: "marker-1",
        status: "open",
        replies: [
          {
            id: "reply-1",
            author: "Bob",
            updatedAt: "2025-03-01T11:00:00Z",
            body: "<p>Reply</p>",
            markdown: "Reply",
            attachments: [
              {
                sourceUrl: "/download/report",
                archivePath: "root-page/attachments/comments/reply-1/report.pdf",
                fileName: "report.pdf",
                mediaType: "application/pdf",
                fileSize: blob.size,
              },
            ],
          },
        ],
      },
    ],
    history: [],
    folder: "root-page",
    outcome: {
      attachments: {
        declared: null,
        listed: 1,
        eligible: 1,
        archived: 1,
        skippedSize: 0,
        failedDownloads: 0,
      },
      plantUml: {
        discovered: 1,
        archived: 1,
        skippedLimit: 0,
        failedDownloads: 0,
        unsupported: 0,
      },
      layout: {
        status: "preserved",
        sections: 2,
      },
      failures: [],
    },
  };
}

function makePage(): ConfluencePageRaw {
  return {
    id: "100",
    title: "Root Page",
    type: "page",
    status: "current",
    space: { key: "DOC" },
    version: { number: 1 },
    _links: { webui: "/pages/viewpage.action?pageId=100" },
  };
}

function makePageWithImage(): ConfluencePageRaw {
  return {
    ...makePage(),
    body: {
      view: {
        representation: "view",
        value:
          '<p>Intro</p><img src="/download/attachments/100/chart.png" alt="Chart" /><a href="https://www.plantuml.com/plantuml/uml/SyfFKj2rKt3CoKnELR1Io4ZDoSa70000">Diagram</a>',
      },
    },
  };
}

function makePageWithPlantUml(): ConfluencePageRaw {
  return {
    ...makePage(),
    body: {
      view: {
        representation: "view",
        value:
          '<p><a href="https://www.plantuml.com/plantuml/uml/SyfFKj2rKt3CoKnELR1Io4ZDoSa70000">Diagram</a></p>',
      },
    },
  };
}

function makeWatchPage(id: string): ConfluencePageRaw {
  return {
    id,
    title: `Page ${id}`,
    type: "page",
    status: "current",
    space: { key: "DOC" },
    version: { number: Number(id) },
    body: {
      view: {
        representation: "view",
        value: `<p>Body ${id}</p>`,
      },
    },
    _links: { webui: `/pages/viewpage.action?pageId=${id}` },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
