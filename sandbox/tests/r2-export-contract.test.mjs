import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { JSDOM } from "jsdom";
import { strFromU8, unzipSync } from "fflate";
import { createSandboxServer } from "../server.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const storageWrites = new Set();
let dom, vite, ConfluenceApi, prepareExport, createExportDefaults, migrateSettings;
let runExport, createMemoryZipSink, createDirectorySink, createStreamedZipSink, markerFile;
let treeCache, buildSubtreeSnapshot;

before(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  for (const name of [
    "document", "DOMParser", "Node", "NodeFilter", "Element", "HTMLElement",
    "HTMLAnchorElement", "HTMLImageElement", "HTMLTableElement", "HTMLTableRowElement",
    "HTMLTableCellElement", "Text",
  ]) globalThis[name] = dom.window[name];
  const storageArea = () => {
    const data = {};
    return {
      async get(keys) {
        const selected = keys === null ? Object.keys(data) : [].concat(keys);
        return structuredClone(Object.fromEntries(selected.filter((key) => key in data).map((key) => [key, data[key]])));
      },
      async set(items) {
        Object.assign(data, structuredClone(items));
        for (const listener of storageWrites) listener(items);
      },
      async remove(keys) {
        for (const key of [].concat(keys)) delete data[key];
      },
    };
  };
  globalThis.chrome = { storage: { sync: storageArea(), local: storageArea(), session: storageArea() } };
  vite = await createViteServer({
    root,
    configFile: false,
    resolve: { alias: { "@": new URL("../../src", import.meta.url).pathname } },
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
    logLevel: "error",
  });
  ({ ConfluenceApi } = await vite.ssrLoadModule("/src/lib/confluence-api.ts"));
  ({ prepareExport } = await vite.ssrLoadModule("/src/lib/export/prepare.ts"));
  ({ createExportDefaults, migrateSettings } = await vite.ssrLoadModule("/src/lib/settings.ts"));
  ({ runExport } = await vite.ssrLoadModule("/src/sidepanel/workspace/run-export.ts"));
  ({ createMemoryZipSink, createDirectorySink, createStreamedZipSink, EXPORT_MARKER_FILE: markerFile } =
    await vite.ssrLoadModule("/src/lib/export/sinks.ts"));
  treeCache = await vite.ssrLoadModule("/src/lib/tree-cache.ts");
  ({ buildSubtreeSnapshot } = await vite.ssrLoadModule("/src/lib/snapshot-walker.ts"));
  await chrome.storage.sync.set({ "cx.settings.v1": settingsFor("md-only") });
});

after(async () => {
  await vite?.close();
  dom?.window.close();
});

async function listen(t, server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeIdleConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t) {
  const { server, store } = createSandboxServer();
  const origin = await listen(t, server);
  const template = structuredClone(store.pages.get("1100"));
  store.pages.clear();
  return {
    origin,
    store,
    api: new ConfluenceApi(origin, { maxRetries: 0 }),
    putPage(id, { parentId = null, title = `Lorem page ${id}`, html = `<p>Lorem ${id}</p>`, labels = ["lorem"] } = {}) {
      const page = {
        ...structuredClone(template), id, parentId, title, labels,
        storage: html, view: html, editor: html,
        revisions: template.revisions.map((revision) => ({ ...revision, storage: html, title })),
      };
      store.pages.set(id, page);
      return page;
    },
  };
}

function settingsFor(presetId) {
  const settings = migrateSettings(undefined);
  settings.maxRetries = 0;
  settings.exportDefaults = createExportDefaults(presetId);
  settings.exportDefaults.package.editable = false;
  settings.exportDefaults.package.comments = false;
  settings.exportDefaults.package.history = false;
  settings.exportDefaults.package.plantUmlAssets = false;
  settings.exportDefaults.conversion.rewriteInternalLinks = true;
  settings.exportDefaults.conversion.deduplicateAssets = true;
  return settings;
}

function preparedFor(origin, request, settings, destination = "download-zip") {
  return prepareExport({
    tabId: 1, windowId: 1, product: "confluence", baseUrl: origin,
    pageUrl: `${origin}/pages/viewpage.action?pageId=1000`, pageId: "1000", spaceKey: "LOREM",
  }, { ...request, host: origin }, settings, settings.exportDefaults, destination);
}

async function archiveEntries(memory, rootName) {
  const archive = unzipSync(new Uint8Array(await (await memory.blob()).arrayBuffer()));
  const prefix = `${rootName}/`;
  const entries = {};
  for (const [path, bytes] of Object.entries(archive)) {
    assert.ok(path.startsWith(prefix), `member outside the package root: ${path}`);
    entries[path.slice(prefix.length)] = bytes;
  }
  return entries;
}

function localMarkdownTargets(entries) {
  const targets = [];
  for (const [path, bytes] of Object.entries(entries)) {
    if (!path.endsWith(".md")) continue;
    for (const [, label, href] of strFromU8(bytes).matchAll(/!?\[([^\]]*)\]\(([^)]+)\)/g)) {
      if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(href)) continue;
      const target = posix.normalize(posix.join(posix.dirname(path), decodeURIComponent(href.split("#")[0])));
      assert.ok(!target.startsWith("../") && !posix.isAbsolute(target), `${path} -> ${href}`);
      assert.ok(entries[target], `missing local Markdown target: ${path} -> ${href}`);
      targets.push({ path, label, target });
    }
  }
  return targets;
}

// Node destination semantics only; native writable/OPFS and picker coverage belongs to browser E2E.
class MemoryFile {
  constructor(bytes = new Uint8Array()) {
    this.bytes = bytes;
    this.closeCalls = 0;
    this.abortCalls = 0;
    this.createWritableCalls = 0;
  }

  async createWritable() {
    this.createWritableCalls += 1;
    const parts = [];
    let state = "open";
    return {
      write: async (data) => {
        assert.equal(state, "open");
        parts.push(new Blob([data]));
      },
      close: async () => {
        assert.equal(state, "open");
        this.bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
        state = "closed";
        this.closeCalls += 1;
      },
      abort: async () => {
        assert.equal(state, "open");
        state = "aborted";
        this.abortCalls += 1;
      },
    };
  }
}

class MemoryDirectory {
  directories = new Map();
  files = new Map();

  async getDirectoryHandle(name, { create = false } = {}) {
    assert.ok(name && name !== "." && name !== ".." && !/[\\/]/.test(name));
    if (this.files.has(name)) throw new DOMException("A file already exists", "TypeMismatchError");
    if (!this.directories.has(name)) {
      if (!create) throw new DOMException("Directory not found", "NotFoundError");
      this.directories.set(name, new MemoryDirectory());
    }
    return this.directories.get(name);
  }

  async getFileHandle(name, { create = false } = {}) {
    assert.ok(name && name !== "." && name !== ".." && !/[\\/]/.test(name));
    if (this.directories.has(name)) throw new DOMException("A directory already exists", "TypeMismatchError");
    if (!this.files.has(name)) {
      if (!create) throw new DOMException("File not found", "NotFoundError");
      this.files.set(name, new MemoryFile());
    }
    return this.files.get(name);
  }

  entries(prefix = "") {
    const entries = {};
    for (const [name, file] of this.files) entries[prefix + name] = file.bytes;
    for (const [name, directory] of this.directories) Object.assign(entries, directory.entries(`${prefix}${name}/`));
    return entries;
  }
}

test("201 actual space pages reach the finished ZIP, including the tail CSV and an exactly escaped label", async (t) => {
  const { origin, api, putPage } = await fixture(t);
  const label = 'lo"rem\\tag';
  const ids = Array.from({ length: 201 }, (_, index) => index === 0 ? "1000" : String(20_000 + index));
  for (const [index, id] of ids.entries()) {
    putPage(id, {
      labels: index === 200 ? [label] : ["lorem", 'lo"remtag', "lorem\\tag"],
      html: `<h2>Lorem CSV ${id}</h2><table><tr><th>Page</th><th>Value</th></tr><tr><td>${id}</td><td>lorem-${index}</td></tr></table>`,
    });
  }
  assert.deepEqual((await api.getSpacePages("LOREM", { label })).map((page) => page.id), [ids.at(-1)]);
  const prepared = preparedFor(origin, { kind: "extract-space", spaceKey: "LOREM" }, settingsFor("tables-only"));
  let memory, rootName;
  const result = await runExport(prepared, () => {}, new AbortController().signal, (info) => {
    rootName = info.rootName;
    memory = createMemoryZipSink(rootName);
    return memory.sink;
  });
  const entries = await archiveEntries(memory, rootName);
  const manifest = JSON.parse(strFromU8(entries["space-manifest.json"]));
  assert.deepEqual(manifest.pages.map((page) => page.id), ids);
  assert.equal(result.outcome.successfulPages, ids.length);
  assert.equal(result.outcome.partial, false);
  const links = localMarkdownTargets(entries);
  for (const page of manifest.pages) {
    assert.ok(entries[page.archive_path], `missing archive_path for ${page.id}`);
    const tables = links.filter((link) => link.path === page.archive_path && link.target.endsWith(".csv"));
    assert.equal(tables.length, 1, `missing CSV service index for ${page.id}`);
    assert.ok(strFromU8(entries[tables[0].target]).includes(`${page.id},lorem-${ids.indexOf(page.id)}`));
  }
  assert.equal(Object.keys(entries).filter((path) => path.endsWith(".csv")).length, ids.length);
});

test("real API, cached tree and watch snapshot all retain the 6001st child without duplicates", { timeout: 30_000 }, async (t) => {
  const { origin, api, putPage } = await fixture(t);
  putPage("1000");
  const ids = Array.from({ length: 6_001 }, (_, index) => String(20_000 + index));
  for (const id of ids) putPage(id, { parentId: "1000" });
  assert.deepEqual((await api.getChildren("1000")).map((page) => page.id), ids);
  let cache;
  const unsubscribe = treeCache.subscribe(origin, (next) => { cache = next; });
  t.after(unsubscribe);
  const persisted = Promise.withResolvers();
  const key = `cx.tree-cache.v1:${origin}`;
  const observe = (items) => { if (items[key]) persisted.resolve(); };
  storageWrites.add(observe);
  t.after(() => storageWrites.delete(observe));
  await treeCache.ensureChildren(origin, "1000");
  assert.equal(cache["1000"].childrenLoaded, true);
  assert.deepEqual(cache["1000"].childrenIds, ids);
  assert.equal(cache[ids.at(-1)].hasChildren, false);
  await persisted.promise;
  const saved = (await chrome.storage.local.get(key))[key];
  assert.deepEqual(saved["1000"].childrenIds, ids);
  const { snapshot } = await buildSubtreeSnapshot(api, "1000", { maxDepth: 1 });
  assert.deepEqual(Object.keys(snapshot).filter((id) => id !== "1000"), ids);
  assert.equal(snapshot[ids.at(-1)].parentId, "1000");
  assert.equal(snapshot[ids.at(-1)].version, 1);
});

test("real sink writes precede a gated final source and same-named shared/different resources resolve to exact offline bytes", async (t) => {
  const { origin, putPage } = await fixture(t);
  const svg = (fill) => new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="${fill}"/></svg>`);
  const common = svg("#123456"), first = svg("#456789"), last = svg("#789abc");
  const resources = new Map([["/common-a/lorem.svg", common], ["/common-b/lorem.svg", common], ["/first/lorem.svg", first], ["/last/lorem.svg", last]]);
  const assetOrigin = await listen(t, createServer((request, response) => {
    const bytes = resources.get(request.url);
    response.writeHead(bytes ? 200 : 404, { "Content-Type": "image/svg+xml" });
    response.end(bytes ?? "Not found");
  }));
  const image = (path, alt) => `<img src="${assetOrigin}${path}" data-linked-resource-default-alias="lorem.svg" alt="${alt}"/>`;
  putPage("1000", { html: image("/common-a/lorem.svg", "Shared first") + image("/first/lorem.svg", "Distinct first") + '<p><a href="/pages/viewpage.action?pageId=20000">Next page</a></p>' });
  putPage("20000", { parentId: "1000", html: image("/common-b/lorem.svg", "Shared last") + image("/last/lorem.svg", "Distinct last") + '<p><a href="/pages/viewpage.action?pageId=1000">Previous page</a></p>' });
  const settings = settingsFor("md-attachments");
  settings.exportDefaults.package.attachments = false;
  const prepared = preparedFor(origin, { kind: "extract-subtree", rootPageId: "1000" }, settings);
  const fetchedLast = Promise.withResolvers(), releaseLast = Promise.withResolvers();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    const url = new URL(String(input));
    if (url.origin === origin && url.pathname === "/rest/api/content/20000" && url.searchParams.get("expand")?.includes("body.view")) {
      fetchedLast.resolve();
      await releaseLast.promise;
    }
    return response;
  };
  let memory, rootName;
  const running = runExport(prepared, () => {}, new AbortController().signal, (info) => {
    rootName = info.rootName;
    memory = createMemoryZipSink(rootName);
    return memory.sink;
  });
  try {
    await Promise.race([fetchedLast.promise, running.then(() => assert.fail("Export finished before the gated source read"))]);
    assert.ok(memory.sink.stats().entriesWritten > 0, "the first page must already be written");
    await assert.rejects(memory.blob());
    releaseLast.resolve();
    const result = await running;
    assert.equal(result.outcome.successfulPages, 2);
    assert.equal(result.outcome.successfulResources, 3);
    assert.equal(result.outcome.partial, false);
    const entries = await archiveEntries(memory, rootName);
    const targets = new Map(localMarkdownTargets(entries).map(({ label, target }) => [label, target]));
    assert.equal(targets.get("Shared first"), targets.get("Shared last"));
    assert.notEqual(targets.get("Distinct first"), targets.get("Shared first"));
    assert.notEqual(targets.get("Distinct last"), targets.get("Shared first"));
    assert.notEqual(targets.get("Distinct first"), targets.get("Distinct last"));
    for (const [label, bytes] of [["Shared first", common], ["Shared last", common], ["Distinct first", first], ["Distinct last", last]]) {
      assert.deepEqual(entries[targets.get(label)], bytes, `wrong offline resource for ${label}`);
    }
    assert.equal(Object.keys(entries).filter((path) => path.endsWith(".svg")).length, 3);
    const manifest = JSON.parse(strFromU8(entries["manifest.json"]));
    const firstPage = manifest.pages.find((page) => page.id === "1000");
    assert.ok(strFromU8(entries[firstPage.archive_path]).includes(`${origin}/pages/viewpage.action?pageId=20000`));
  } finally {
    releaseLast.resolve();
    await running.catch(() => {});
    globalThis.fetch = originalFetch;
  }
});

for (const destination of ["download-zip", "streamed-zip", "directory"]) {
  test(`a failed forward-linked page cannot complete ${destination} after its predecessor is written`, async (t) => {
    const { origin, store, putPage } = await fixture(t);
    const forwardUrl = `${origin}/pages/viewpage.action?pageId=20000`;
    putPage("1000", { html: `<p><a href="${forwardUrl}">Unavailable page</a></p>` });
    putPage("20000", { parentId: "1000" });
    const prepared = preparedFor(origin, { kind: "extract-subtree", rootPageId: "1000" }, settingsFor("md-only"), destination);
    const parent = new MemoryDirectory();
    const existingBytes = new TextEncoder().encode("Lorem existing user file");
    const existing = new MemoryFile(existingBytes);
    parent.files.set("existing.zip", existing);
    const signal = new AbortController().signal;
    const progress = [];
    let memory, streamedName, missingReads = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === origin && url.pathname === "/rest/api/content/20000" && url.searchParams.get("expand")?.includes("body.view")) {
        missingReads += 1;
        store.pages.delete("20000");
      }
      return originalFetch(input, init);
    };
    try {
      await assert.rejects(runExport(prepared, (event) => progress.push(event), signal, async (info) => {
        if (destination === "directory") return createDirectorySink(parent, { rootName: info.rootName, jobId: prepared.id }, signal);
        if (destination === "streamed-zip") {
          streamedName = `${info.rootName}-${prepared.id}.zip`;
          return createStreamedZipSink(parent, { rootName: info.rootName, jobId: prepared.id }, signal);
        }
        memory = createMemoryZipSink(info.rootName);
        return memory.sink;
      }), (error) => error.name === "PageSourceError" && error.pageId === "20000");
      assert.equal(missingReads, 2, "only the existing pre-emit page-source retry is allowed");
      assert.deepEqual(existing.bytes, existingBytes);
      assert.equal(existing.createWritableCalls, 0);
      assert.equal(progress.at(-1).counts.successfulPages, 1);
      assert.equal(progress.at(-1).counts.failedPages, 1);
      assert.equal(progress.at(-1).counts.entriesWritten, 1);
      if (destination === "download-zip") {
        assert.equal(memory.sink.stats().entriesWritten, 1);
        await assert.rejects(memory.blob());
      } else if (destination === "streamed-zip") {
        const file = parent.files.get(streamedName);
        assert.ok(file, "the streamed factory creates a new unique ZIP in the selected parent");
        assert.equal(file.closeCalls, 0);
        assert.equal(file.abortCalls, 1);
        assert.equal(file.bytes.byteLength, 0, "an aborted new ZIP is not committed");
      } else {
        assert.equal(parent.directories.size, 1);
        const entries = parent.directories.values().next().value.entries();
        const marker = JSON.parse(strFromU8(entries[markerFile]));
        assert.equal(marker.schema, 1);
        assert.equal(marker.jobId, prepared.id);
        assert.equal(marker.status, "failed");
        assert.equal(marker.unexportedPageId, "20000");
        const closed = Object.keys(entries).filter((path) => path !== markerFile);
        assert.equal(closed.length, 1);
        assert.ok(closed[0].endsWith("/index.md"));
        assert.ok(strFromU8(entries[closed[0]]).includes(forwardUrl));
        assert.equal(marker.counts.entriesWritten, 1);
        assert.equal(marker.counts.bytesWritten, entries[closed[0]].byteLength);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}
