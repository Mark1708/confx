import { webcrypto } from "node:crypto";
import { posix } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as extractor from "@/lib/extractor";
import { produceConfluenceExport } from "@/lib/export/confluence";
import type { ArchiveEntry, ExtractRequest, ProgressEvent } from "@/lib/export/contracts";
import { produceJiraExport } from "@/lib/export/jira";
import { prepareExport } from "@/lib/export/prepare";
import { ZipEncoder } from "@/lib/export/zip-encoder";
import { archivePathKey } from "@/lib/export/paths";
import { collectExport, hasBlobBody } from "../helpers/export-collector";
import { createExportDefaults, migrateSettings } from "@/lib/settings";
import type { ConfluencePageRaw } from "@/lib/confluence-api";
import type { SourceContext } from "@/lib/source-context";

const HOST = "https://wiki.example.test";
const source: SourceContext = {
  tabId: 1,
  windowId: 1,
  product: "confluence",
  baseUrl: HOST,
  pageUrl: `${HOST}/pages/viewpage.action?pageId=100`,
  pageId: "100",
  spaceKey: "LOREM",
};

function rawPage(id: string, title: string, html: string): ConfluencePageRaw {
  return {
    id,
    title,
    type: "page",
    status: "current",
    version: { number: 3 },
    space: { key: "LOREM" },
    ancestors: id === "100" ? [] : [{ id: "100", title: "Root page" }],
    body: {
      view: { representation: "view", value: html },
      storage: { representation: "storage", value: html },
    },
    _links: { webui: `/pages/viewpage.action?pageId=${id}` },
  };
}

function prepared(request: ExtractRequest, resources = false) {
  const settings = migrateSettings(undefined);
  settings.exportDefaults = createExportDefaults(resources ? "md-attachments" : "md-only");
  settings.exportDefaults.package.editable = false;
  settings.exportDefaults.package.comments = false;
  settings.exportDefaults.package.history = false;
  settings.exportDefaults.package.plantUmlAssets = false;
  settings.exportDefaults.conversion.deduplicateAssets = true;
  settings.exportDefaults.conversion.rewriteInternalLinks = true;
  settings.maxRetries = 0;
  settings.locale = "en";
  return prepareExport(source, request, settings);
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}

function installPages(pages: ConfluencePageRaw[], options: { failPage?: string } = {}) {
  const sourceReads: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const id = url.pathname.match(/^\/rest\/api\/content\/(\d+)$/)?.[1];
      if (id) {
        if (url.searchParams.get("expand")?.includes("body.view")) {
          sourceReads.push(id);
          if (id === options.failPage) return new Response("", { status: 503 });
        }
        const page = pages.find((item) => item.id === id);
        if (!page) throw new Error(`Unexpected page ${id}`);
        return json(page);
      }
      if (/\/child\/page$/.test(url.pathname)) {
        const children = url.pathname.includes("/100/") ? pages.slice(1) : [];
        return json({ results: url.searchParams.get("start") === "0" ? children : [] });
      }
      if (/\/child\/attachment$/.test(url.pathname)) {
        return json({
          results:
            url.pathname.includes("/200/") && url.searchParams.get("start") === "0"
              ? [
                  {
                    id: "lorem-shared",
                    title: "shared.png",
                    extensions: { mediaType: "image/png", fileSize: 12 },
                    _links: { download: "/download/attachments/200/shared.png" },
                  },
                ]
              : [],
        });
      }
      if (
        url.pathname === "/assets/shared.png" ||
        url.pathname === "/download/attachments/200/shared.png"
      ) {
        return new Response("shared bytes", { headers: { "Content-Type": "image/png" } });
      }
      throw new Error(`Unexpected request ${url}`);
    }),
  );
  return sourceReads;
}

function context() {
  return { signal: new AbortController().signal, onPackage: vi.fn() };
}

function assertLocalTargets(entries: readonly ArchiveEntry[]) {
  const paths = new Set(entries.map((entry) => entry.path));
  for (const entry of entries) {
    if (!entry.path.endsWith(".md") || typeof entry.body !== "string") continue;
    for (const match of entry.body.matchAll(/\]\(([^)]+)\)/g)) {
      const href = match[1];
      if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(href)) continue;
      const target = posix.normalize(
        posix.join(posix.dirname(entry.path), decodeURIComponent(href.split("#")[0])),
      );
      expect(paths.has(target), `${entry.path} -> ${href}`).toBe(true);
    }
  }
}

describe("sequential Confluence producer transactions", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("awaits every entry of a page before reading the next page source", async () => {
    const reads = installPages([
      rawPage("100", "Root page", '<p>Lorem first</p><img src="/assets/shared.png" alt="Lorem" />'),
      rawPage("200", "Child page", "<p>Lorem last</p>"),
    ]);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const ctx = context();
    const entries: ArchiveEntry[] = [];
    const run = produceConfluenceExport(
      prepared(
        {
          kind: "extract-watch-changed",
          host: HOST,
          pageIds: ["100", "200"],
          rootTitle: "Lorem root",
          diff: {},
        },
        true,
      ),
      ctx,
      async (entry) => {
        expect(ctx.onPackage).toHaveBeenCalledTimes(1);
        entries.push(entry);
        if (hasBlobBody(entry) && entry.path.startsWith("pages/100/")) {
          entered.resolve();
          await release.promise;
        }
      },
    );
    try {
      await Promise.race([
        entered.promise,
        run.then(() => {
          throw new Error("Producer finished before its first write");
        }),
      ]);
      expect(reads).toEqual(["100"]);
      expect(entries[0].path).toBe("pages/100/index.md");
      expect(entries).toHaveLength(2);
    } finally {
      release.resolve();
    }
    const summary = await run;
    expect(reads).toEqual(["100", "200"]);
    expect(ctx.onPackage).toHaveBeenCalledExactlyOnceWith({
      rootName: "lorem-root-changed",
      fileName: "lorem-root-changed.zip",
    });
    expect(summary.outcome).toMatchObject({ successfulPages: 2, entriesWritten: entries.length });
  });

  it("discards provisional assets from a failed source attempt before retrying", async () => {
    installPages([
      rawPage("100", "Root page", '<img src="/assets/shared.png" alt="Lorem" />'),
      rawPage("200", "Child page", '<a href="/download/attachments/200/shared.png">Shared</a>'),
    ]);
    const actual = extractor.extractFromHtml;
    vi.spyOn(extractor, "extractFromHtml").mockImplementationOnce(async (...args) => {
      await actual(...args);
      throw new Error("Synthetic conversion failure after resource reservation");
    });
    const entries: ArchiveEntry[] = [];
    const summary = await produceConfluenceExport(
      prepared({ kind: "extract-subtree", host: HOST, rootPageId: "100" }, true),
      context(),
      async (entry) => {
        entries.push(entry);
      },
    );
    const binaries = entries.filter(hasBlobBody);
    expect(binaries).toHaveLength(1);
    expect(await (binaries[0].body as Blob).text()).toBe("shared bytes");
    expect(summary.outcome).toMatchObject({
      partial: false,
      successfulPages: 2,
      successfulResources: 1,
    });
    assertLocalTargets(entries);
  });

  it("never retries or redelivers a page after an irreversible writer failure", async () => {
    const reads = installPages([
      rawPage("100", "Root page", '<img src="/assets/shared.png" alt="Lorem" />'),
      rawPage("200", "Child page", "<p>Lorem last</p>"),
    ]);
    const writeFailure = new Error("Synthetic destination failure");
    const emit = vi.fn(async () => {
      if (emit.mock.calls.length === 2) throw writeFailure;
    });
    await expect(
      produceConfluenceExport(
        prepared({ kind: "extract-subtree", host: HOST, rootPageId: "100" }, true),
        context(),
        emit,
      ),
    ).rejects.toBe(writeFailure);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(reads).toEqual(["100"]);
  });

  it("keeps forward links online and cannot finish a ZIP after the target source exhausts retries", async () => {
    const reads = installPages(
      [
        rawPage(
          "100",
          "Root page",
          '<p><a href="/pages/viewpage.action?pageId=200">Future child</a></p>',
        ),
        rawPage("200", "Child page", "<p>Unavailable tail</p>"),
      ],
      { failPage: "200" },
    );
    const entries: ArchiveEntry[] = [];
    const ready = vi.fn();
    const finish = vi.spyOn(ZipEncoder.prototype, "finish");
    const progress: ProgressEvent[] = [];
    const run = collectExport(
      (options, ctx, emit) =>
        produceConfluenceExport(options, ctx, async (entry) => {
          entries.push(entry);
          await emit(entry);
        }),
      prepared({ kind: "extract-subtree", host: HOST, rootPageId: "100" }),
      (event) => {
        progress.push(event);
      },
    ).then(ready);
    await expect(run).rejects.toMatchObject({ name: "PageSourceError", pageId: "200" });
    expect(reads).toEqual(["100", "200", "200"]);
    expect(ready).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    expect(progress.at(-1)?.counts).toMatchObject({
      successfulPages: 1,
      failedPages: 1,
      entriesWritten: 1,
    });
    expect(entries.map((entry) => entry.path)).toEqual(["root-page/index.md"]);
    expect(entries[0].body).toContain(`[Future child](${HOST}/pages/viewpage.action?pageId=200)`);
  });

  it("uses only committed targets and one physical canonical asset across page folders", async () => {
    installPages([
      rawPage(
        "100",
        "Root page",
        '<img src="/assets/shared.png" alt="Lorem" /><a href="/pages/viewpage.action?pageId=200">Future</a>',
      ),
      rawPage(
        "200",
        "Child page",
        '<a href="/download/attachments/200/shared.png">Shared</a><a href="/pages/viewpage.action?pageId=100">Previous</a>',
      ),
    ]);
    const entries: ArchiveEntry[] = [];
    await produceConfluenceExport(
      prepared({ kind: "extract-subtree", host: HOST, rootPageId: "100" }, true),
      context(),
      async (entry) => {
        entries.push(entry);
      },
    );
    expect(entries.filter(hasBlobBody)).toHaveLength(1);
    const root = entries.find((entry) => entry.path === "root-page/index.md")!;
    const child = entries.find((entry) => entry.path === "root-page/child-page/index.md")!;
    expect(root.body).toContain(`[Future](${HOST}/pages/viewpage.action?pageId=200)`);
    expect(child.body).toContain("[Previous](../index.md)");
    expect(child.body).toMatch(/\[Shared\]\(\.\.\/images\/[^)]+\)/);
    assertLocalTargets(entries);
    expect(new Set(entries.map((entry) => entry.path)).size).toBe(entries.length);
  });

  it("protects every discovery folder before reserving the first page's resources", async () => {
    installPages([
      rawPage("100", "Root page", '<a href="/download/attachments/100/index.md">Resource</a>'),
      rawPage("200", "Attachments", "<p>Lorem child index must survive</p>"),
    ]);
    const originalFetch = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/child/attachment")) {
          return json({
            results:
              url.pathname.includes("/100/") && url.searchParams.get("start") === "0"
                ? [
                    {
                      id: "lorem-index",
                      title: "index.md",
                      extensions: { mediaType: "text/markdown", fileSize: 11 },
                      _links: { download: "/download/attachments/100/index.md" },
                    },
                  ]
                : [],
          });
        }
        if (url.pathname === "/download/attachments/100/index.md")
          return new Response("Lorem asset");
        return originalFetch(input, init);
      }),
    );
    const entries: ArchiveEntry[] = [];
    await produceConfluenceExport(
      prepared({ kind: "extract-subtree", host: HOST, rootPageId: "100" }, true),
      context(),
      async (entry) => {
        entries.push(entry);
      },
    );
    expect(
      entries.find((entry) => entry.path === "root-page/attachments/index.md")?.body,
    ).toContain("Lorem child index must survive");
    const resource = entries.find(hasBlobBody)!;
    expect(resource.path).not.toBe("root-page/attachments/index.md");
    expect(await (resource.body as Blob).text()).toBe("Lorem asset");
    assertLocalTargets(entries);
    expect(new Set(entries.map((entry) => entry.path)).size).toBe(entries.length);
  });

  it("allocates NFC page folders and disambiguates caseless Unicode title collisions before writing", async () => {
    installPages([
      rawPage("100", "가", "<p>Lorem root</p>"),
      rawPage("200", "ß", "<p>Lorem first child</p>"),
      rawPage("300", "SS", "<p>Lorem second child</p>"),
    ]);
    const result = await collectExport(
      produceConfluenceExport,
      prepared({ kind: "extract-subtree", host: HOST, rootPageId: "100" }),
    );
    const paths = Object.keys(unzipSync(new Uint8Array(await result.zipBlob.arrayBuffer())));
    expect(result.rootName).toBe("가");
    expect(paths.filter((path) => path.endsWith("/index.md"))).toHaveLength(3);
    expect(paths.every((path) => path === path.normalize("NFC"))).toBe(true);
    expect(new Set(paths.map(archivePathKey)).size).toBe(paths.length);
  });

  it("writes NFC Korean CSV filenames and links the tables-only index to the actual member", async () => {
    installPages([
      rawPage(
        "100",
        "Root page",
        "<h2>가</h2><table><tr><th>Lorem</th><th>Ipsum</th></tr><tr><td>Alpha</td><td>Beta</td></tr></table>",
      ),
    ]);
    const settings = migrateSettings(undefined);
    settings.exportDefaults = createExportDefaults("tables-only");
    settings.maxRetries = 0;
    const result = await collectExport(
      produceConfluenceExport,
      prepareExport(source, { kind: "extract-page", host: HOST, pageId: "100" }, settings),
    );
    const files = unzipSync(new Uint8Array(await result.zipBlob.arrayBuffer()));
    expect(strFromU8(files["root-page/tables/가-01.csv"])).toBe("Lorem,Ipsum\nAlpha,Beta");
    expect(strFromU8(files["root-page/index.md"])).toContain("[가-01.csv](tables/가-01.csv)");
  });

  it.each(["page", "watch"] as const)("%s retains its one-attempt source budget", async (mode) => {
    const reads = installPages([rawPage("100", "Root page", "<p>Lorem</p>")], { failPage: "100" });
    const request: ExtractRequest =
      mode === "page"
        ? { kind: "extract-page", host: HOST, pageId: "100" }
        : {
            kind: "extract-watch-changed",
            host: HOST,
            pageIds: ["100"],
            rootTitle: "Lorem",
            diff: {},
          };
    const emit = vi.fn();
    await expect(produceConfluenceExport(prepared(request), context(), emit)).rejects.toMatchObject(
      {
        name: "PageSourceError",
        pageId: "100",
      },
    );
    expect(reads).toEqual(["100"]);
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("sequential Jira aggregate export", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("awaits each issue binary before loading the next issue while preserving aggregate outputs and the search cap", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const issues = ["LOREM-1", "LOREM-2"].map((key) => ({
      key,
      fields: {
        summary: `Lorem ${key}`,
        description: `Description ${key}`,
        project: { key: "LOREM" },
        issuetype: { name: "Task" },
        status: { name: "Open" },
        created: "2026-01-01T12:00:00Z",
        updated: "2026-01-02T12:00:00Z",
        attachment: [
          {
            id: key,
            filename: "lorem.txt",
            size: 7,
            mimeType: "text/plain",
            content: `${HOST}/files/${key}.txt`,
          },
        ],
      },
    }));
    const issueReads: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/2/search") {
          expect(url.searchParams.get("maxResults")).toBe("50");
          return json({ issues });
        }
        const key = url.pathname.match(/^\/rest\/api\/2\/issue\/(LOREM-\d+)$/)?.[1];
        if (key) {
          issueReads.push(key);
          return json(issues.find((issue) => issue.key === key));
        }
        if (url.pathname.startsWith("/files/"))
          return new Response(url.pathname.includes("LOREM-1") ? "first" : "second");
        throw new Error(`Unexpected request ${url}`);
      }),
    );
    const settings = migrateSettings(undefined);
    settings.exportDefaults = createExportDefaults("md-attachments");
    settings.exportDefaults.package.comments = false;
    settings.maxRetries = 0;
    const runOptions = prepareExport(
      { ...source, product: "jira", pageUrl: `${HOST}/browse/LOREM-1`, issueKey: "LOREM-1" },
      { kind: "extract-jira-search", host: HOST, jql: "project = LOREM" },
      settings,
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const ctx = context();
    const entries: ArchiveEntry[] = [];
    const run = produceJiraExport(runOptions, ctx, async (entry) => {
      expect(ctx.onPackage).toHaveBeenCalledTimes(1);
      entries.push(entry);
      if (entry.path === "attachments/LOREM-1/lorem.txt") {
        entered.resolve();
        await release.promise;
      }
    });
    try {
      await Promise.race([
        entered.promise,
        run.then(() => {
          throw new Error("Missing first issue binary");
        }),
      ]);
      expect(issueReads).not.toContain("LOREM-2");
    } finally {
      release.resolve();
    }
    const summary = await run;
    expect(ctx.onPackage).toHaveBeenCalledExactlyOnceWith({
      rootName: "issues",
      fileName: "jira-search.zip",
    });
    expect(entries.map((entry) => entry.path)).toEqual([
      "attachments/LOREM-1/lorem.txt",
      "attachments/LOREM-2/lorem.txt",
      "index.md",
      "issues.json",
      "issues.csv",
    ]);
    expect(await (entries[0].body as Blob).text()).toBe("first");
    expect(await (entries[1].body as Blob).text()).toBe("second");
    expect(entries[2].body).toContain("Description LOREM-1");
    expect(entries[2].body).toContain("Description LOREM-2");
    expect(
      JSON.parse(entries[3].body as string).map((issue: { key: string }) => issue.key),
    ).toEqual(["LOREM-1", "LOREM-2"]);
    expect(entries[4].body).toContain("LOREM-2,LOREM,Task,Open");
    expect(summary.outcome).toMatchObject({
      partial: false,
      successfulPages: 2,
      successfulResources: 2,
      failedResources: 0,
      entriesWritten: 5,
    });
  });
});
