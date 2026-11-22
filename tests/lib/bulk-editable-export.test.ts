import { webcrypto } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfluenceApi, type ConfluencePageRaw } from "@/lib/confluence-api";
import { extractFromHtml } from "@/lib/extractor";
import { applyStorageMarkdown, readStorageMarkdown } from "@/lib/storage-roundtrip";
import { produceConfluenceExport } from "@/lib/export/confluence";
import type { ExtractRequest } from "@/lib/export/contracts";
import { collectExport } from "../helpers/export-collector";
import { prepareExport } from "@/lib/export/prepare";
import { createExportDefaults, migrateSettings } from "@/lib/settings";
import type { SourceContext } from "@/lib/source-context";
import type { ExportPresetId, ExtractionRule } from "@/types";

const HOST = "https://wiki.example.com";
const SOURCE_CONTEXT: SourceContext = {
  tabId: 1,
  windowId: 1,
  product: "confluence",
  baseUrl: HOST,
  pageUrl: `${HOST}/pages/viewpage.action?pageId=100`,
  pageId: "100",
  spaceKey: "DOC",
};
const SOURCE =
  '<p>Original paragraph</p><ac:structured-macro ac:name="status"><ac:parameter ac:name="title">Opaque value</ac:parameter></ac:structured-macro>';
const originalChrome = globalThis.chrome;
let raw: ConfluencePageRaw;
let rules: ExtractionRule[];

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}

function makePage(): ConfluencePageRaw {
  return {
    id: "100",
    title: "Root Page",
    type: "page",
    status: "current",
    space: { key: "DOC" },
    version: { number: 7 },
    ancestors: [],
    body: {
      view: { representation: "view", value: "<p>Original paragraph</p><p>Rendered status</p>" },
      storage: { representation: "storage", value: SOURCE },
    },
    _links: { webui: "/pages/viewpage.action?pageId=100" },
  };
}

function settingsFor(presetId: ExportPresetId) {
  const settings = migrateSettings(undefined);
  settings.exportDefaults = createExportDefaults(presetId);
  settings.exportDefaults.package.comments = false;
  settings.exportDefaults.package.history = false;
  settings.customRules = rules;
  settings.maxRetries = 0;
  return settings;
}

async function exportMode(mode: string, presetId: ExportPresetId = "md-only") {
  const common = { host: HOST, presetId };
  let request: ExtractRequest;
  switch (mode) {
    case "page":
      request = { ...common, kind: "extract-page", pageId: "100" };
      break;
    case "tree":
      request = { ...common, kind: "extract-subtree", rootPageId: "100" };
      break;
    case "space":
      request = { ...common, kind: "extract-space", spaceKey: "DOC" };
      break;
    case "block":
      request = {
        kind: "extract-block",
        html: raw.body?.view?.value ?? "",
        pageMeta: new ConfluenceApi(HOST).toPageMeta(raw),
        presetId,
      };
      break;
    default:
      request = {
        ...common,
        kind: "extract-watch-changed",
        pageIds: ["100"],
        rootTitle: "Root Page",
        diff: { changed: ["100"] },
      };
  }
  return collectExport(
    produceConfluenceExport,
    prepareExport(SOURCE_CONTEXT, request, settingsFor(presetId)),
  );
}

async function archive(mode: string, presetId: ExportPresetId = "md-only") {
  const result = await exportMode(mode, presetId);
  const entries = unzipSync(new Uint8Array(await result.zipBlob.arrayBuffer()));
  const manifestPath = Object.keys(entries).find((path) => path.endsWith("manifest.json"))!;
  const manifest = JSON.parse(strFromU8(entries[manifestPath]));
  const root = manifestPath.slice(0, manifestPath.lastIndexOf("/") + 1);
  return { entries, manifest, root, outcome: result.outcome };
}

describe("reversible full-page Confluence archives", () => {
  beforeEach(() => {
    raw = makePage();
    rules = [];
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("chrome", {
      storage: {
        sync: {
          get: vi.fn(() => {
            throw new Error("Prepared export must not reread stored settings");
          }),
        },
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/content/100") return jsonResponse(raw);
        if (url.pathname === "/rest/api/space/DOC")
          return jsonResponse({ key: "DOC", name: "Docs", homepage: { id: "100" } });
        if (url.pathname === "/rest/api/space/DOC/content/page")
          return jsonResponse({ results: url.searchParams.get("start") === "0" ? [raw] : [], size: 1 });
        if (
          url.pathname === "/rest/api/content/100/child/page" ||
          url.pathname === "/rest/api/content/100/child/attachment"
        )
          return jsonResponse({ results: [], size: 0 });
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalChrome === undefined) Reflect.deleteProperty(globalThis, "chrome");
  });

  it.each(["en", "ru"] as const)(
    "reports phases and measured page counts independently of %s messages",
    async (locale) => {
      const settings = settingsFor("md-only");
      settings.locale = locale;
      const progress = vi.fn();
      const result = await collectExport(produceConfluenceExport,
        prepareExport(
          SOURCE_CONTEXT,
          { kind: "extract-page", host: HOST, pageId: "100" },
          settings,
        ),
        progress,
      );
      const entries = unzipSync(new Uint8Array(await result.zipBlob.arrayBuffer()));
      expect(Object.keys(entries).some((path) => path.endsWith("/index.md"))).toBe(true);
      expect(progress.mock.calls.map(([event]) => event.phase)).toEqual(
        expect.arrayContaining(["reading", "writing", "finalizing"]),
      );
      expect(progress.mock.calls[0][0].counts).toMatchObject({ processed: 0, total: 1 });
      expect(progress.mock.calls.at(-1)![0].counts).toMatchObject({
        processed: 1,
        total: 1,
        successfulPages: 1,
        failedPages: 0,
        successfulResources: 0,
        failedResources: 0,
        entriesWritten: Object.keys(entries).length,
      });
    },
  );

  it("does not confuse an intentional fragment with an incomplete export", async () => {
    const { entries, manifest, root, outcome } = await archive("block");
    expect(manifest.pages[0].editable.reason).toBe("partial-export");
    expect(entries[root + manifest.pages[0].archive_path]).toBeDefined();
    expect(outcome).toEqual({
      partial: false,
      successfulPages: 1,
      failedPages: 0,
      successfulResources: 0,
      failedResources: 0,
      entriesWritten: Object.keys(entries).length,
    });
  });
  it.each(["tree", "space"])(
    "%s rejects an exhausted page source instead of returning a ready partial archive",
    async (mode) => {
      const originalFetch = fetch;
      const missing = { ...makePage(), id: "101", title: "Missing page" };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(String(input));
          if (url.pathname === "/rest/api/content/101") return new Response("", { status: 404 });
          if (url.pathname === "/rest/api/content/100/child/page")
            return jsonResponse({ results: url.searchParams.get("start") === "0" ? [missing] : [], size: 1 });
          if (url.pathname === "/rest/api/content/101/child/page")
            return jsonResponse({ results: [], size: 0 });
          if (url.pathname === "/rest/api/space/DOC/content/page")
            return jsonResponse({ results: url.searchParams.get("start") === "0" ? [raw, missing] : [], size: 2 });
          return originalFetch(input, init);
        }),
      );

      await expect(exportMode(mode)).rejects.toMatchObject({
        name: "PageSourceError",
        pageId: "101",
      });
    },
  );

  it("reports a failed resource without claiming its archived page was skipped", async () => {
    const originalFetch = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/content/100/child/attachment")
          return jsonResponse({
            results: [
              {
                id: "lorem-file",
                title: "lorem.pdf",
                extensions: { mediaType: "application/pdf", fileSize: 12 },
                _links: { download: "/download/attachments/100/lorem.pdf" },
              },
            ],
            size: 1,
          });
        if (url.pathname === "/download/attachments/100/lorem.pdf")
          return new Response("", { status: 404 });
        return originalFetch(input, init);
      }),
    );

    const result = await exportMode("page", "md-attachments");
    const entries = unzipSync(new Uint8Array(await result.zipBlob.arrayBuffer()));
    const manifestPath = Object.keys(entries).find((path) => path.endsWith("/manifest.json"))!;
    const manifest = JSON.parse(strFromU8(entries[manifestPath]));
    expect(manifest.pages).toHaveLength(1);
    expect(Object.keys(entries).some((path) => path.endsWith("/index.md"))).toBe(true);
    expect(Object.keys(entries).some((path) => path.endsWith(".pdf"))).toBe(false);
    expect(manifest.failures).toContainEqual(expect.objectContaining({ scope: "attachment" }));
    expect(result).toHaveProperty("outcome", {
      partial: true,
      successfulPages: 1,
      failedPages: 0,
      successfulResources: 0,
      failedResources: 1,
      entriesWritten: Object.keys(entries).length,
    });
  });
  it("keeps an unknown resource-list failure partial without fabricating a resource count", async () => {
    const originalFetch = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (new URL(String(input)).pathname === "/rest/api/content/100/child/attachment")
          return new Response("", { status: 403 });
        return originalFetch(input, init);
      }),
    );
    const result = await exportMode("page", "md-attachments");
    const entries = unzipSync(new Uint8Array(await result.zipBlob.arrayBuffer()));
    const manifestPath = Object.keys(entries).find((path) => path.endsWith("/manifest.json"))!;
    const manifest = JSON.parse(strFromU8(entries[manifestPath]));
    expect(manifest.failures).toContainEqual(
      expect.objectContaining({
        scope: "attachment",
        reason: "attachment-list-failed",
      }),
    );
    expect(Object.keys(entries).some((path) => path.endsWith("/index.md"))).toBe(true);
    expect(result).toHaveProperty("outcome", {
      partial: true,
      successfulPages: 1,
      failedPages: 0,
      successfulResources: 0,
      failedResources: null,
      entriesWritten: Object.keys(entries).length,
    });
  });

  it.each(["page", "tree", "space", "watch"])(
    "%s writes a self-contained, version-bound editable file beside the unchanged projection",
    async (mode) => {
      const { entries, manifest, root, outcome } = await archive(mode);
      expect(outcome).toEqual({
        partial: false,
        successfulPages: manifest.pages.length,
        failedPages: 0,
        successfulResources: 0,
        failedResources: 0,
        entriesWritten: Object.keys(entries).length,
      });
      const page = manifest.pages[0];
      expect(manifest.manifest_version).toBe(2);
      expect(page.editable).toMatchObject({
        metadata_version: 1,
        status: "available",
        representation: "storage",
        version: 7,
      });
      expect(page.editable.path).toBe(page.archive_path.replace(/index\.md$/, "editable.md"));
      const text = strFromU8(entries[root + page.editable.path]);
      const decoded = await readStorageMarkdown(text);
      expect(decoded.target).toEqual({ host: HOST, pageId: "100" });
      expect(decoded.package.snapshot).toEqual({
        representation: "storage",
        html: SOURCE,
        title: "Root Page",
        pageId: "100",
        version: 7,
      });
      expect(page.editable.source_hash).toBe(decoded.package.sourceHash);
      expect((await applyStorageMarkdown(decoded.package, decoded.markdown)).html).toBe(SOURCE);
      const result = await applyStorageMarkdown(
        decoded.package,
        decoded.markdown.replace("Original paragraph", "Updated paragraph"),
      );
      expect(result.status).toBe("ready");
      expect(result.html).toBe(SOURCE.replace("Original paragraph", "Updated paragraph"));
      const projection = strFromU8(entries[root + page.archive_path]);
      expect(projection).toContain("# Root Page");
      expect(projection).toContain("Original paragraph\n\nRendered status");
      expect(projection).not.toContain("confx:storage-markdown");
      expect(JSON.stringify(manifest)).not.toContain(SOURCE);
    },
  );

  it("also writes editable source in attachment-enabled exports", async () => {
    const { entries, manifest, root } = await archive("space", "md-attachments");
    expect(entries[root + manifest.pages[0].editable.path]).toBeDefined();
  });

  it.each([
    { action: "skip", matcher: ".secret", options: undefined },
    { action: "skip", matcher: ".currently-absent", options: undefined },
    { action: "to-csv", matcher: ".currently-absent", options: { removeAfterCsv: true } },
  ] as const)(
    "suppresses source for enabled destructive rule $action/$matcher even without matches",
    async ({ action, matcher, options }) => {
      raw.body!.storage!.value += '<p class="secret">HIDDEN_EXCLUDED_SECRET</p>';
      rules = [
        {
          id: "privacy",
          name: "Privacy",
          type: "selector",
          enabled: true,
          action,
          matcher,
          options,
        },
      ];
      const { entries, manifest } = await archive("page");
      expect(manifest.pages[0].editable).toEqual({
        metadata_version: 1,
        status: "unavailable",
        reason: "filtered-content",
      });
      expect(Object.keys(entries).some((path) => path.endsWith("editable.md"))).toBe(false);
      for (const bytes of Object.values(entries))
        expect(strFromU8(bytes)).not.toContain("HIDDEN_EXCLUDED_SECRET");
    },
  );

  it("uses the canonical API host rather than the requesting page URL", async () => {
    const result = await collectExport(produceConfluenceExport,
      prepareExport(
        { ...SOURCE_CONTEXT, pageUrl: `${HOST}/display/DOC/Root+Page` },
        {
          kind: "extract-page",
          host: `${HOST}/display/DOC/Root+Page`,
          pageId: "100",
          presetId: "md-only",
        },
        settingsFor("md-only"),
      ),
    );
    const entries = unzipSync(new Uint8Array(await result.zipBlob.arrayBuffer()));
    const path = Object.keys(entries).find((name) => name.endsWith("editable.md"))!;
    expect(path).toBeDefined();
    expect((await readStorageMarkdown(strFromU8(entries[path]))).target.host).toBe(HOST);
  });

  it("does not suppress source for a disabled destructive rule", async () => {
    rules = [
      {
        id: "disabled",
        name: "Disabled",
        type: "selector",
        enabled: false,
        action: "skip",
        matcher: "p",
      },
    ];
    expect((await archive("page")).manifest.pages[0].editable.status).toBe("available");
  });

  it("never adds source to tables-only archives", async () => {
    const { entries, manifest, root } = await archive("page", "tables-only");
    expect(manifest.pages[0].editable.status).toBe("unavailable");
    expect(Object.keys(entries).some((path) => path.endsWith("editable.md"))).toBe(false);
    const index = strFromU8(entries[root + manifest.pages[0].archive_path]);
    expect(index).toContain("# Root Page");
    expect(index).not.toContain("Original paragraph");
    expect([...index.matchAll(/\]\(([^)]+\.csv)\)/g)]).toEqual([]);
  });

  it.each(["page", "tree", "space", "watch", "block"])(
    "%s tables-only writes CSV-backed service indexes last without companion content",
    async (mode) => {
      raw.body!.view!.value = [
        "<p>Lorem narrative must not become a tables-only page.</p>",
        '<table class="confluenceTable"><tr><th>Lorem</th></tr><tr><td>Ipsum</td></tr></table>',
        '<table class="confluenceTable"><tr><th>Dolor</th></tr><tr><td>Sit</td></tr></table>',
        '<img src="/download/attachments/100/lorem.png" alt="Lorem resource" />',
        '<a href="/download/attachments/100/lorem.pdf">Lorem attachment</a>',
      ].join("");

      const { entries, manifest, root } = await archive(mode, "tables-only");
      const page = manifest.pages[0];
      const paths = Object.keys(entries);
      const indexPath = root + page.archive_path;
      const pagePrefix = indexPath.slice(0, -"index.md".length);
      const csvPaths = paths.filter(
        (path) => path.startsWith(`${pagePrefix}tables/`) && path.endsWith(".csv"),
      );
      expect(csvPaths).toHaveLength(2);
      expect(csvPaths.map((path) => strFromU8(entries[path]))).toEqual([
        "Lorem\nIpsum",
        "Dolor\nSit",
      ]);
      const index = strFromU8(entries[indexPath]);
      const linkedCsvs = [...index.matchAll(/\]\((tables\/[^)]+\.csv)\)/g)].map(
        (match) => pagePrefix + match[1],
      );
      expect(linkedCsvs).toEqual(csvPaths);
      expect(index).not.toContain("Lorem narrative");
      expect(index).not.toContain("Lorem resource");
      expect(index).not.toContain("confx:storage-markdown");
      for (const path of csvPaths)
        expect(paths.indexOf(path)).toBeLessThan(paths.indexOf(indexPath));
      expect(
        paths.filter((path) =>
          /(?:editable\.md|comments\.json|history\.json|\/images\/|\/attachments\/)/.test(path),
        ),
      ).toEqual([]);
      expect(manifest.counts).toMatchObject({
        tables_csv: 2,
        images: 0,
        attachments: 0,
      });
      const requests = vi
        .mocked(fetch)
        .mock.calls.map(([input]) => new URL(String(input)).pathname);
      expect(
        requests.filter((path) =>
          /(?:\/download\/|\/child\/attachment$|\/comment$|\/comments$|\/version$|\/convert\/)/.test(
            path,
          ),
        ),
      ).toEqual([]);
    },
  );

  it("uses only the captured imported base and custom rules, source and package after settings change", async () => {
    raw.body!.view!.value = [
      '<p class="secret">Lorem excluded</p>',
      '<table class="selected"><tr><th>Keep</th></tr><tr><td>Lorem</td></tr></table>',
      "<table><tr><th>Ignore</th></tr><tr><td>Ipsum</td></tr></table>",
    ].join("");
    const settings = settingsFor("tables-only");
    const baseRule: ExtractionRule = {
      id: "imported-selection",
      name: "Imported selection",
      type: "selector",
      matcher: "table.selected",
      action: "to-csv",
      enabled: true,
    };
    settings.exportDefaults.conversion.presetRules = [baseRule];
    settings.customRules = [
      {
        id: "private-content",
        name: "Private content",
        type: "selector",
        matcher: ".secret",
        action: "skip",
        enabled: true,
      },
    ];
    const source = { ...SOURCE_CONTEXT };
    const request = {
      kind: "extract-page" as const,
      host: HOST,
      pageId: "100",
      presetId: "tables-only",
    };
    const prepared = prepareExport(source, request, settings);
    baseRule.matcher = "table";
    settings.customRules[0].matcher = "table";
    settings.exportDefaults.presetId = "md-attachments";
    settings.exportDefaults.package.editable = true;
    settings.exportDefaults.package.comments = true;
    settings.exportDefaults.package.history = true;
    source.baseUrl = "https://other.example.test";
    request.host = source.baseUrl;
    request.pageId = "200";

    const result = await collectExport(produceConfluenceExport, prepared);
    const entries = unzipSync(new Uint8Array(await result.zipBlob.arrayBuffer()));
    const manifest = JSON.parse(strFromU8(entries["root-page/manifest.json"]));
    const csvPaths = Object.keys(entries).filter((path) => path.endsWith(".csv"));
    expect(csvPaths).toHaveLength(1);
    expect(strFromU8(entries[csvPaths[0]])).toBe("Keep\nLorem");
    expect(manifest).toMatchObject({
      preset: "tables-only",
      source: { host: HOST, pageId: "100" },
    });
    expect(strFromU8(entries["root-page/index.md"])).not.toContain("Lorem excluded");
    expect(Object.keys(entries).some((path) => /editable|comments|history/.test(path))).toBe(false);
    expect(chrome.storage.sync.get).not.toHaveBeenCalled();
  });

  it.each(
    ["page", "tree", "space", "watch"].flatMap((mode) =>
      ["storage", "version", "draft", "zero-version", "wrong-representation"].map((missing) => ({
        mode,
        missing,
      })),
    ),
  )(
    "keeps ordinary $mode export available without published source identity: $missing",
    async ({ mode, missing }) => {
      if (missing === "storage") delete raw.body!.storage;
      else if (missing === "version") delete raw.version;
      else if (missing === "draft") raw.status = "draft";
      else if (missing === "zero-version") raw.version!.number = 0;
      else raw.body!.storage!.representation = "view";
      const { entries, manifest, root } = await archive(mode);
      expect(manifest.pages[0].editable).toMatchObject({
        status: "unavailable",
        reason: "source-unavailable",
      });
      expect(strFromU8(entries[root + manifest.pages[0].archive_path])).toContain(
        "Original paragraph",
      );
      expect(Object.keys(entries).some((path) => path.endsWith("editable.md"))).toBe(false);
    },
  );

  it.each([
    "<p>Unclosed",
    '<!DOCTYPE x [<!ENTITY secret "unsafe">]><p>&secret;</p>',
    '<p onclick="alert(1)">Unsafe</p>',
  ])("reports invalid storage without falling back to rendered HTML: %s", async (source) => {
    raw.body!.storage!.value = source;
    const { entries, manifest } = await archive("page");
    expect(manifest.pages[0].editable.reason).toBe("invalid-source");
    expect(Object.keys(entries).some((path) => path.endsWith("editable.md"))).toBe(false);
  });

  it("partial block exports do not archive source despite page metadata", async () => {
    const api = new ConfluenceApi(HOST);
    const result = await collectExport(produceConfluenceExport,
      prepareExport(
        SOURCE_CONTEXT,
        {
          kind: "extract-block",
          html: "<p>Chosen block</p>",
          pageMeta: api.toPageMeta(raw),
          presetId: "md-only",
        },
        settingsFor("md-only"),
      ),
    );
    const entries = unzipSync(new Uint8Array(await result.zipBlob.arrayBuffer()));
    const manifestPath = Object.keys(entries).find((path) => path.endsWith("manifest.json"))!;
    expect(JSON.parse(strFromU8(entries[manifestPath])).pages[0].editable.reason).toBe(
      "partial-export",
    );
    expect(Object.keys(entries).some((path) => path.endsWith("editable.md"))).toBe(false);
    const direct = await extractFromHtml(api, "<p>Chosen block</p>", api.toPageMeta(raw), {
      rules: [],
      storageHtml: SOURCE,
      exportImages: false,
      exportAttachments: false,
    });
    expect(direct.editable).toEqual({ status: "unavailable", reason: "partial-export" });
  });

  it.each(["jira", "other"] as const)(
    "%s fragments keep online resources without Confluence metadata or roundtrip calls",
    async (product) => {
      const settings = settingsFor("md-attachments");
      settings.exportDefaults.package.images = false;
      settings.exportDefaults.package.plantUmlAssets = false;
      settings.exportDefaults.package.comments = true;
      settings.exportDefaults.package.history = true;
      const baseUrl = "https://web.example.test";
      const source: SourceContext = {
        tabId: 2,
        windowId: 1,
        product,
        baseUrl,
        pageUrl: `${baseUrl}/articles/lorem`,
      };
      const meta = new ConfluenceApi(HOST).toPageMeta(raw);
      const result = await collectExport(produceConfluenceExport,
        prepareExport(
          source,
          {
            kind: "extract-block",
            html: '<p>Lorem fragment</p><img src="lorem.png" alt="Lorem" />',
            pageMeta: { ...meta, id: "fragment", title: "Lorem fragment" },
            presetId: "md-attachments",
          },
          settings,
        ),
      );
      const entries = unzipSync(new Uint8Array(await result.zipBlob.arrayBuffer()));
      const manifest = JSON.parse(strFromU8(entries["lorem-fragment-block/manifest.json"]));
      expect(strFromU8(entries["lorem-fragment-block/index.md"])).toContain(
        "![Lorem](https://web.example.test/articles/lorem.png)",
      );
      expect(manifest.failures).toEqual([]);
      expect(manifest.pages[0].editable.reason).toBe("partial-export");
      expect(Object.keys(entries)).toEqual([
        "lorem-fragment-block/index.md",
        "lorem-fragment-block/manifest.json",
      ]);
      expect(fetch).not.toHaveBeenCalled();
      expect(chrome.storage.sync.get).not.toHaveBeenCalled();
    },
  );

  it("propagates a real abort instead of recording invalid-source", async () => {
    const controller = new AbortController();
    const abort = new DOMException("Stopped", "AbortError");
    controller.abort(abort);
    const api = new ConfluenceApi(HOST);
    await expect(
      extractFromHtml(api, "<p>Original paragraph</p>", api.toPageMeta(raw), {
        rules: [],
        signal: controller.signal,
        exportImages: false,
        exportAttachments: false,
        fullPageStorage: {
          representation: "storage",
          html: SOURCE,
          title: raw.title,
          pageId: raw.id,
          version: 7,
        },
      }),
    ).rejects.toBe(abort);
  });
});
