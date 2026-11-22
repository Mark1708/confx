import { describe, expect, it } from "vitest";

import {
  buildConfluenceExportManifest,
  capturePageInventory,
  serializeConfluenceExportManifest,
} from "../../src/lib/export-manifest";
import type {
  ConfluenceExportInventory,
  ConfluenceExportManifestPage,
  ExportFailure,
  ExtractedPage,
} from "../../src/types";

import { isBlobLike } from "../helpers/export-collector";

function makePage(overrides: Partial<ExtractedPage> = {}): ExtractedPage {
  return {
    meta: {
      id: "100",
      title: "Root page",
      spaceKey: "DOCS",
      baseUrl: "https://wiki.example.com/wiki",
      url: "https://wiki.example.com/wiki/pages/viewpage.action?pageId=100",
      version: 7,
      ancestors: [
        { id: "10", title: "Home" },
        { id: "20", title: "Parent" },
      ],
      attachmentCount: 3,
    },
    markdown: "# Root page\n",
    tables: [{ name: "data.csv", csv: "a,b\n1,2" }],
    images: [
      {
        sourceUrl: "/image.png",
        archivePath: "images/image.png",
        blob: new Blob(["image"]),
        hash: "image-hash",
      },
    ],
    attachments: [
      {
        sourceUrl: "/report.pdf",
        archivePath: "attachments/report.pdf",
        fileName: "report.pdf",
        mediaType: "application/pdf",
        fileSize: 6,
        blob: new Blob(["report"]),
        hash: "attachment-hash",
      },
    ],
    plantUmlAssets: [
      {
        png: {
          archivePath: "attachments/linked/plantuml/plantuml-diagram.png",
          fileName: "plantuml-diagram.png",
          mediaType: "image/png",
          fileSize: 3,
          blob: new Blob(["png"]),
          hash: "plantuml-png-hash",
        },
        source: {
          archivePath: "attachments/linked/plantuml/plantuml-diagram.puml",
          fileName: "plantuml-diagram.puml",
          mediaType: "text/plain",
          fileSize: 4,
          blob: new Blob(["puml"]),
          hash: "plantuml-source-hash",
        },
      },
    ],
    commentAttachments: [],
    comments: [],
    inlineComments: [],
    history: [],
    folder: "",
    outcome: {
      attachments: {
        declared: 3,
        listed: 3,
        eligible: 3,
        archived: 1,
        skippedSize: 1,
        failedDownloads: 1,
      },
      plantUml: {
        discovered: 2,
        archived: 1,
        skippedLimit: 0,
        failedDownloads: 1,
        unsupported: 0,
      },
      layout: {
        status: "preserved",
        sections: 2,
      },
      failures: [
        {
          scope: "attachment",
          page_id: "100",
          href: "/broken.pdf",
          reason: "attachment-download-failed",
          status: 503,
        },
      ],
    },
    ...overrides,
  };
}

function pageInput(
  page: ExtractedPage,
  overrides: {
    origin?: ConfluenceExportManifestPage["origin"];
    linkDepth?: number | null;
    discoveredFrom?: string[];
  } = {},
): ConfluenceExportInventory {
  return capturePageInventory(
    page,
    overrides.origin ?? "root",
    overrides.linkDepth ?? null,
    overrides.discoveredFrom ?? [],
  );
}

describe("buildConfluenceExportManifest", () => {
  it("captures detached slim metadata without retaining a previous page payload", () => {
    const page = makePage();
    const discoveredFrom = ["10"];
    const inventory = capturePageInventory(page, "linked", 2, discoveredFrom);
    const before = JSON.parse(JSON.stringify(inventory));
    page.markdown = "discarded source projection";
    page.meta.ancestors![0].title = "mutated";
    page.outcome.failures[0].reason = "fetch-failed";
    discoveredFrom.push("20");
    page.images.length = 0;
    expect(inventory).toEqual(before);
    expect(inventory.counts).toEqual({
      tables_csv: 1,
      images: 1,
      attachments: 1,
      plantuml_diagrams: 1,
    });
    expect(Object.keys(inventory).sort()).toEqual(["counts", "failures", "page"]);
    expect(Object.values(inventory.page).some((value) => isBlobLike(value))).toBe(false);
    expect(inventory.page).not.toHaveProperty("markdown");
    expect(inventory.page).not.toHaveProperty("images");
    expect(inventory.page).not.toHaveProperty("meta");
  });

  it("builds canonical root metadata with ordered ancestors and verified counts", () => {
    const page = makePage();

    const manifest = buildConfluenceExportManifest({
      type: "single-page",
      exportedAt: "2026-08-28T10:00:00.000Z",
      preset: "md-attachments",
      source: {
        host: "https://wiki.example.com/wiki",
        pageId: "100",
        title: "Root page",
      },
      pages: [pageInput(page)],
    });

    expect(manifest).toEqual(
      expect.objectContaining({
        manifest_version: 2,
        type: "single-page",
        exported_at: "2026-08-28T10:00:00.000Z",
        preset: "md-attachments",
        counts: {
          pages: 1,
          tables_csv: 1,
          images: 1,
          attachments: 1,
          plantuml_diagrams: 1,
        },
      }),
    );
    expect(manifest.pages[0]).toMatchObject({
      id: "100",
      title: "Root page",
      version: 7,
      url: "https://wiki.example.com/wiki/pages/viewpage.action?pageId=100",
      space: "DOCS",
      parent_id: "20",
      ancestors: [
        { id: "10", title: "Home" },
        { id: "20", title: "Parent" },
      ],
      archive_path: "index.md",
      origin: "root",
      link_depth: null,
      discovered_from: [],
      attachment_outcome: {
        declared: 3,
        listed: 3,
        eligible: 3,
        archived: 1,
        skipped_size: 1,
        failed_downloads: 1,
      },
      plantuml_outcome: {
        discovered: 2,
        archived: 1,
        skipped_limit: 0,
        failed_downloads: 1,
        unsupported: 0,
      },
      layout_outcome: {
        status: "preserved",
        sections: 2,
      },
    });
    expect(manifest.failures).toEqual(page.outcome.failures);
  });

  it.each([
    ["block", "block", "index.md"],
    ["watch-changed", "watch", "pages/200/index.md"],
    ["subtree", "subtree", "parent/child/index.md"],
    ["space", "space", "space-page/index.md"],
    ["linked-pages", "linked", "pages/200/index.md"],
  ] as const)("records %s page origin and archive path", (type, origin, archivePath) => {
    const folder = archivePath === "index.md" ? "" : archivePath.replace(/\/index\.md$/, "");
    const page = makePage({
      meta: { ...makePage().meta, id: "200", ancestors: [] },
      folder,
    });

    const manifest = buildConfluenceExportManifest({
      type,
      exportedAt: "2026-08-28T10:00:00.000Z",
      preset: "md-only",
      source: { host: "https://wiki.example.com/wiki" },
      pages: [
        pageInput(page, {
          origin,
          linkDepth: origin === "linked" ? 1 : null,
          discoveredFrom: origin === "linked" ? ["100"] : [],
        }),
      ],
    });

    expect(manifest.pages[0]).toMatchObject({
      origin,
      archive_path: archivePath,
      parent_id: null,
      link_depth: origin === "linked" ? 1 : null,
      discovered_from: origin === "linked" ? ["100"] : [],
    });
  });

  it("keeps failures without inflating successful page or attachment counts", () => {
    const linkedFailure: ExportFailure = {
      scope: "linked-page",
      from_page_id: "100",
      href: "/wiki/pages/404/missing",
      reason: "not-found",
      status: 404,
    };
    const page = makePage({
      attachments: [],
      outcome: {
        attachments: {
          declared: 20,
          listed: 0,
          eligible: 0,
          archived: 0,
          skippedSize: 0,
          failedDownloads: 0,
        },
        plantUml: {
          discovered: 1,
          archived: 0,
          skippedLimit: 0,
          failedDownloads: 1,
          unsupported: 0,
        },
        layout: {
          status: "none",
          sections: 0,
        },
        failures: [
          {
            scope: "attachment",
            page_id: "100",
            reason: "attachment-list-failed",
            status: 403,
          },
          {
            scope: "linked-asset",
            page_id: "100",
            reason: "fetch-failed",
          },
        ],
      },
    });

    const manifest = buildConfluenceExportManifest({
      type: "linked-pages",
      exportedAt: "2026-08-28T10:00:00.000Z",
      preset: "md-attachments",
      source: { host: "https://wiki.example.com/wiki" },
      pages: [pageInput(page)],
      failures: [linkedFailure],
    });

    expect(manifest.counts).toEqual({
      pages: 1,
      tables_csv: 1,
      images: 1,
      attachments: 0,
      plantuml_diagrams: 1,
    });
    expect(manifest.pages[0].attachment_outcome).toMatchObject({ declared: 20, archived: 0 });
    expect(manifest.pages[0].plantuml_outcome).toMatchObject({
      discovered: 1,
      archived: 1,
      failed_downloads: 1,
    });
    expect(manifest.pages[0].layout_outcome).toEqual({ status: "none", sections: 0 });
    expect(manifest.failures).toEqual([...page.outcome.failures, linkedFailure]);
    expect(manifest.failures[1]).not.toHaveProperty("href");
  });

  it("serializes the v2 contract as formatted JSON", () => {
    const serialized = serializeConfluenceExportManifest({
      type: "block",
      exportedAt: "2026-08-28T10:00:00.000Z",
      preset: "md-only",
      source: { host: "https://wiki.example.com/wiki" },
      pages: [pageInput(makePage(), { origin: "block" })],
    });

    expect(JSON.parse(serialized)).toMatchObject({ manifest_version: 2, type: "block" });
    expect(serialized).toContain('\n  "manifest_version": 2,');
  });
});
