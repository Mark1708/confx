import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { JSDOM } from "jsdom";
import { strFromU8, unzipSync } from "fflate";
import { createSandboxServer } from "../server.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
let dom, vite, server, store, origin, api, extractOnePage, readStorageMarkdown, applyStorageMarkdown;
let produceConfluenceExport, produceJiraExport, prepareExport, collectExport;
let createExportDefaults, migrateSettings;

before(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  for (const name of [
    "document",
    "DOMParser",
    "Node",
    "NodeFilter",
    "Element",
    "HTMLElement",
    "HTMLAnchorElement",
    "HTMLImageElement",
    "HTMLTableElement",
    "HTMLTableRowElement",
    "HTMLTableCellElement",
    "Text",
  ])
    globalThis[name] = dom.window[name];
  ({ server, store } = createSandboxServer());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
  vite = await createViteServer({
    root,
    configFile: false,
    resolve: { alias: { "@": new URL("../../src", import.meta.url).pathname } },
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
    logLevel: "error",
  });
  const { ConfluenceApi } = await vite.ssrLoadModule("/src/lib/confluence-api.ts");
  ({ extractOnePage } = await vite.ssrLoadModule("/src/lib/extractor.ts"));
  ({ produceConfluenceExport } = await vite.ssrLoadModule(
    "/src/lib/export/confluence.ts",
  ));
  ({ produceJiraExport } = await vite.ssrLoadModule("/src/lib/export/jira.ts"));
  ({ collectExport } = await vite.ssrLoadModule("/tests/helpers/export-collector.ts"));
  ({ prepareExport } = await vite.ssrLoadModule("/src/lib/export/prepare.ts"));
  ({ createExportDefaults, migrateSettings } = await vite.ssrLoadModule("/src/lib/settings.ts"));
  ({ readStorageMarkdown, applyStorageMarkdown } = await vite.ssrLoadModule(
    "/src/lib/storage-roundtrip.ts",
  ));
  api = new ConfluenceApi(origin, { maxRetries: 0 });
});

after(async () => {
  await vite?.close();
  if (server?.listening) {
    server.closeIdleConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  dom?.window.close();
});

const options = {
  rules: [],
  includeFrontMatter: false,
  exportImages: true,
  exportAttachments: true,
  includeComments: true,
  includeHistory: true,
  rewriteLinks: false,
  includeEditable: true,
};

// Independent consumer boundary: the production exporter calls the real fixture HTTP API.
// This is not an assertion that the fixture server reproduces Atlassian's converter.
test("the real Confx exporter consumes every catalog page, attachments, comments and protected source without mutation", async () => {
  const state = await (await fetch(origin + "/sandbox/api/state")).json();
  for (const page of state.pages) {
    const before = await (await fetch(origin + `/sandbox/api/pages/${page.id}`)).json();
    const settings = migrateSettings(undefined);
    settings.exportDefaults = createExportDefaults("md-attachments");
    settings.maxRetries = 0;
    const result = await collectExport(produceConfluenceExport,
      prepareExport(
        {
          tabId: 1,
          windowId: 1,
          product: "confluence",
          baseUrl: origin,
          pageUrl: `${origin}/pages/viewpage.action?pageId=${page.id}`,
          pageId: page.id,
          spaceKey: "LOREM",
        },
        { kind: "extract-page", host: origin, pageId: page.id, presetId: "md-attachments" },
        settings,
      ),
    );
    const entries = unzipSync(new Uint8Array(await result.zipBlob.arrayBuffer()));
    const manifestPath = Object.keys(entries).find((path) => path.endsWith("/manifest.json"));
    const archiveRoot = manifestPath.slice(0, -"manifest.json".length);
    const manifest = JSON.parse(strFromU8(entries[manifestPath]));
    const exported = manifest.pages[0];
    assert.equal(
      exported.editable.status,
      "available",
      `editable export unavailable for ${page.id}`,
    );
    assert.deepEqual(manifest.failures, [], `export failures for ${page.id}`);
    assert.ok(entries[archiveRoot + exported.archive_path], `missing page index for ${page.id}`);
    assert.deepEqual(result.outcome, {
      partial: false,
      successfulPages: manifest.pages.length,
      failedPages: 0,
      successfulResources: Object.keys(entries).filter((path) => /\/(?:images|attachments)\//.test(path)).length,
      failedResources: 0,
      entriesWritten: Object.keys(entries).length,
    });
    const persisted = await readStorageMarkdown(
      strFromU8(entries[archiveRoot + exported.editable.path]),
    );
    assert.equal(
      persisted.package.snapshot.html,
      before.published.storage,
      `source changed for ${page.id}`,
    );
    assert.equal(persisted.package.snapshot.version, before.page.version);
    const same = await applyStorageMarkdown(persisted.package, persisted.markdown);
    assert.equal(same.status, "unchanged", `false edit on ${page.id}`);
    assert.equal(same.html, before.published.storage);
    const after = await (await fetch(origin + `/sandbox/api/pages/${page.id}`)).json();
    assert.deepEqual(after, before, `export mutated published/draft state for ${page.id}`);
    if (page.id === "1700") {
      for (const fileName of ["lorem.json", "lorem.csv", "lorem.pdf"])
        assert.ok(entries[archiveRoot + `attachments/${fileName}`], `missing exported ${fileName}`);
      assert.deepEqual(JSON.parse(strFromU8(entries[archiveRoot + "attachments/lorem.json"])), {
        lorem: "ipsum",
        count: 3,
        visible: true,
      });
      const comments = JSON.parse(strFromU8(entries[archiveRoot + "comments.json"]));
      assert.ok(comments.comments.some((comment) => comment.markdown.includes("Lorem comment")));
      assert.equal(JSON.parse(strFromU8(entries[archiveRoot + "history.json"]))[0].number, 1);
    }
  }
  const log = await (await fetch(origin + "/sandbox/api/logs")).json();
  assert.equal(
    log.entries.filter((entry) => ["draft", "publish", "scenario"].includes(entry.kind)).length,
    0,
  );
});

test("a Storage Markdown edit passes the independent converter while preserving its opaque macro and published revision", async () => {
  const before = await (await fetch(origin + "/sandbox/api/pages/1000")).json();
  const exported = await extractOnePage(api, "1000", options);
  const loaded = await readStorageMarkdown(exported.editable.markdown);
  const note = "Lorem contract insertion.";
  const firstBlock = loaded.markdown.indexOf("<!-- confx:block id=");
  assert.notEqual(firstBlock, -1);
  const changedMarkdown =
    loaded.markdown.slice(0, firstBlock) + note + "\n\n" + loaded.markdown.slice(firstBlock);
  const changed = await applyStorageMarkdown(loaded.package, changedMarkdown);
  assert.equal(changed.status, "ready");
  assert.equal(changed.html.replace(`<p>${note}</p>\n`, ""), before.published.storage);
  const editor = await api.convertBody(changed.html, "storage", "editor", "1000");
  const restored = await api.convertBody(editor, "editor", "storage", "1000");
  assert.ok(restored.includes(note));
  assert.ok(restored.includes('ac:macro-id="lorem-root-note"'));
  const after = await (await fetch(origin + "/sandbox/api/pages/1000")).json();
  assert.deepEqual(after, before);
  const log = await (await fetch(origin + "/sandbox/api/logs")).json();
  assert.equal(log.entries.filter((entry) => entry.kind === "publish").length, 0);
});

test("prepared page, subtree, space and watch tables-only archives contain only actual CSV indexes and no companions", async () => {
  const beforeLog = await (await fetch(origin + "/sandbox/api/logs")).json();
  const settings = migrateSettings(undefined);
  settings.maxRetries = 0;
  settings.exportDefaults = createExportDefaults("tables-only");
  settings.exportDefaults.package = {
    editable: true,
    images: true,
    attachments: true,
    plantUmlAssets: true,
    comments: true,
    history: true,
  };
  const source = {
    tabId: 1,
    windowId: 1,
    product: "confluence",
    baseUrl: origin,
    pageUrl: `${origin}/pages/viewpage.action?pageId=1300`,
    pageId: "1300",
    spaceKey: "LOREM",
  };
  const common = { host: origin, presetId: "tables-only" };
  const requests = [
    { ...common, kind: "extract-page", pageId: "1300" },
    { ...common, kind: "extract-subtree", rootPageId: "1300" },
    { ...common, kind: "extract-space", spaceKey: "LOREM" },
    {
      ...common,
      kind: "extract-watch-changed",
      pageIds: ["1300", "1700"],
      rootTitle: "Lorem changed",
      diff: { changed: ["1300", "1700"] },
    },
  ];
  for (const request of requests) {
    const result = await collectExport(produceConfluenceExport, prepareExport(source, request, settings));
    const entries = unzipSync(new Uint8Array(await result.zipBlob.arrayBuffer()));
    const paths = Object.keys(entries);
    const manifestPath = paths.find((path) => path.endsWith("manifest.json"));
    const archiveRoot = manifestPath.slice(0, manifestPath.lastIndexOf("/") + 1);
    const manifest = JSON.parse(strFromU8(entries[manifestPath]));
    assert.deepEqual(manifest.failures, [], `tables-only failed for ${request.kind}`);
    assert.ok(manifest.pages.some((page) => page.id === "1300"));
    for (const page of manifest.pages) {
      const indexPath = archiveRoot + page.archive_path;
      assert.ok(entries[indexPath], `missing required archive_path ${indexPath}`);
      const pagePrefix = indexPath.slice(0, -"index.md".length);
      const csvPaths = paths.filter(
        (path) => path.startsWith(pagePrefix + "tables/") && path.endsWith(".csv"),
      );
      const content = strFromU8(entries[indexPath]);
      const links = [...content.matchAll(/\]\((tables\/[^)]+\.csv)\)/g)].map(
        (match) => pagePrefix + match[1],
      );
      assert.deepEqual(
        links,
        csvPaths,
        `service index does not describe actual CSV for ${page.id}`,
      );
      for (const path of csvPaths) assert.ok(paths.indexOf(path) < paths.indexOf(indexPath));
      if (page.id === "1300") {
        assert.equal(csvPaths.length, 3);
        assert.ok(
          csvPaths.some((path) => strFromU8(entries[path]).includes("Lorem key,Lorem value")),
        );
        assert.ok(!content.includes("Lorem table specimen"));
      }
      assert.equal(page.editable.status, "unavailable");
    }
    assert.deepEqual(
      paths.filter((path) =>
        /(?:editable\.md|comments\.json|history\.json|\/images\/|\/attachments\/)/.test(path),
      ),
      [],
    );
  }
  const afterLog = await (await fetch(origin + "/sandbox/api/logs")).json();
  assert.deepEqual(
    afterLog.entries
      .slice(beforeLog.entries.length)
      .filter((entry) =>
        /(?:\/download\/|\/child\/attachment$|\/comment$|\/comments$|\/version$|\/convert\/)/.test(
          entry.path,
        ),
      ),
    [],
  );
});

test("the real sequential producer writes shared image bytes before reading the last page and every offline target exists", async () => {
  const sourcePage = store.pages.get("1100");
  const ids = ["990001", "990002"];
  for (const [index, id] of ids.entries()) {
    const view = `<p>Lorem sequential ${index}</p><img src="/download/attachments/1700/lorem.png" alt="Lorem shared"/>`;
    store.pages.set(id, {
      ...structuredClone(sourcePage),
      id,
      parentId: null,
      title: `Lorem sequential ${index}`,
      storage: view,
      view,
      editor: view,
      revisions: sourcePage.revisions.map((revision) => ({ ...revision, storage: view })),
    });
  }
  const settings = migrateSettings(undefined);
  settings.exportDefaults = createExportDefaults("md-attachments");
  settings.exportDefaults.package.editable = false;
  settings.exportDefaults.package.attachments = false;
  settings.exportDefaults.package.comments = false;
  settings.exportDefaults.package.history = false;
  settings.exportDefaults.package.plantUmlAssets = false;
  settings.exportDefaults.conversion.deduplicateAssets = true;
  settings.maxRetries = 0;
  const entries = [];
  let packageCalls = 0;
  const originalFetch = globalThis.fetch;
  const reads = [];
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (ids.some((id) => url.pathname === `/rest/api/content/${id}`) &&
        url.searchParams.get("expand")?.includes("body.view")) {
      reads.push(url.pathname.split("/").at(-1));
    }
    return originalFetch(input, init);
  };
  const run = collectExport(
    (prepared, context, emit) => produceConfluenceExport(prepared, {
      ...context,
      onPackage(info) { packageCalls += 1; context.onPackage(info); },
    }, async (entry) => {
      assert.equal(packageCalls, 1);
      entries.push(entry);
      await emit(entry);
      if (typeof entry.body !== "string") { entered.resolve(); await release.promise; }
    }),
    prepareExport(
      { tabId: 1, windowId: 1, product: "confluence", baseUrl: origin,
        pageUrl: `${origin}/pages/viewpage.action?pageId=${ids[0]}`, pageId: ids[0] },
      { kind: "extract-watch-changed", host: origin, pageIds: ids,
        rootTitle: "Lorem sequential", diff: { changed: ids } },
      settings,
    ),
  );
  try {
    await Promise.race([entered.promise, run.then(() => { throw new Error("No early entry"); })]);
    assert.deepEqual(reads, [ids[0]]);
    release.resolve();
    const summary = await run;
    assert.equal(packageCalls, 1);
    assert.equal(summary.outcome.successfulPages, 2);
    const binaries = entries.filter((entry) => typeof entry.body !== "string");
    assert.equal(binaries.length, 1);
    const archived = unzipSync(new Uint8Array(await summary.zipBlob.arrayBuffer()));
    assert.deepEqual(
      archived[`${summary.rootName}/${binaries[0].path}`],
      new Uint8Array(await (await originalFetch(origin + "/download/attachments/1700/lorem.png")).arrayBuffer()),
    );
    for (const [path, bytes] of Object.entries(archived).filter(([path]) => path.endsWith("/index.md"))) {
      for (const match of strFromU8(bytes).matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = decodeURIComponent(new URL(match[1], `https://archive.example/${path}`).pathname.slice(1));
        assert.ok(archived[target], `${path} -> ${match[1]}`);
      }
    }
  } finally {
    release.resolve();
    await run.catch(() => {});
    globalThis.fetch = originalFetch;
    for (const id of ids) store.pages.delete(id);
  }
});

test("real read-only Jira issue and search preserve package contents through the sequential emitter", async () => {
  const settings = migrateSettings(undefined);
  settings.exportDefaults = createExportDefaults("md-attachments");
  settings.maxRetries = 0;
  const source = { tabId: 1, windowId: 1, product: "jira", baseUrl: origin,
    pageUrl: origin + "/browse/LOR-12", issueKey: "LOR-12" };
  for (const request of [
    { kind: "extract-jira-issue", host: origin, issueKey: "LOR-12" },
    { kind: "extract-jira-search", host: origin, jql: "project = LOR" },
  ]) {
    const entries = [];
    let packageInfo;
    const summary = await collectExport(
      (prepared, context, emit) => produceJiraExport(prepared, {
        ...context,
        onPackage(info) {
          assert.equal(packageInfo, undefined);
          packageInfo = info;
          context.onPackage(info);
        },
      }, async (entry) => { assert.ok(packageInfo); entries.push(entry); await emit(entry); }),
      prepareExport(source, request, settings),
    );
    const index = entries.find((entry) => entry.path === "index.md");
    assert.ok(index.body.includes("Lorem issue"));
    assert.ok(index.body.includes("Lorem comment"));
    const binary = entries.find((entry) => entry.path.endsWith("/lorem.json"));
    const archived = unzipSync(new Uint8Array(await summary.zipBlob.arrayBuffer()));
    assert.deepEqual(
      JSON.parse(strFromU8(archived[`${packageInfo.rootName}/${binary.path}`])),
      { lorem: "ipsum", count: 3, visible: true },
    );
    const isSearch = request.kind === "extract-jira-search";
    assert.equal(summary.outcome.successfulPages, isSearch ? 3 : 1);
    assert.equal(summary.outcome.successfulResources, 1);
    assert.equal(summary.outcome.entriesWritten, entries.length);
    assert.equal(packageInfo.rootName, isSearch ? "issues" : "LOR-12");
    const json = JSON.parse(entries.find((entry) => entry.path === (isSearch ? "issues.json" : "issue.json")).body);
    assert.deepEqual(isSearch ? json.map((issue) => issue.key) : [json.key], isSearch ? ["LOR-12", "LOR-13", "LOR-14"] : ["LOR-12"]);
    if (isSearch) assert.ok(entries.find((entry) => entry.path === "issues.csv").body.includes("LOR-14"));
  }
});
