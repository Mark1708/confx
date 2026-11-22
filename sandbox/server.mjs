import http from "node:http";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { catalog, assetDefinitions, jiraCatalog } from "./catalog.mjs";
import {
  CodecError,
  canonicalStorage,
  editorToStorage,
  storageToEditor,
  storageToView,
  escapeHtml,
} from "./codec.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const publicDirectory = resolve(directory, "public");
const vendorDirectory = resolve(directory, "../node_modules/tinymce");
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const AUTHOR = {
  type: "known",
  username: "lorem",
  userKey: "lorem-author",
  displayName: "Lorem Author",
};
const SCENARIOS = [
  { id: "normal", label: "Normal" },
  { id: "published-newer", label: "Newer published revision" },
  { id: "published-source-changed", label: "Published source changed at same revision" },
  { id: "draft-changed", label: "Independent changed draft" },
  { id: "conversion-loss", label: "Lossy candidate conversion" },
];
const MIME = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".gif": "image/gif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};
const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const invalid = (message) => {
  throw new HttpError(400, message);
};
const notFound = () => {
  throw new HttpError(404, "Local sandbox resource not found");
};
const revisionTime = (number) => new Date(Date.UTC(2026, 0, 1, 12, number - 1)).toISOString();
const revision = (number, message) => ({
  number,
  when: revisionTime(number),
  by: { ...AUTHOR },
  message,
  minorEdit: false,
});
const clone = (value) => structuredClone(value);

function renderContext(page) {
  return {
    pageId: page.id,
    children: catalog
      .filter((child) => child.parentId === page.id)
      .map(({ id, title }) => ({ id, title })),
    resolvePage: (title) => catalog.find((candidate) => candidate.title === title)?.id,
  };
}

function projections(storage, page) {
  const canonical = canonicalStorage(storage);
  return {
    storage: canonical,
    editor: storageToEditor(canonical),
    view: storageToView(canonical, renderContext(page)),
  };
}

let seeds;
function seedPages() {
  // Immutable strings can be shared between independent server stores; mutable revisions/drafts cannot.
  seeds ??= catalog.map((page) => ({ ...page, ...projections(page.storage, page) }));
  return new Map(
    seeds.map((seed) => [
      seed.id,
      {
        ...seed,
        components: [...seed.components],
        labels: [...seed.labels],
        expectations: clone(seed.expectations),
        version: 1,
        draft: null,
        scenario: "normal",
        revisions: [
          { ...revision(1, "Lorem initial specimen"), storage: seed.storage, title: seed.title },
        ],
      },
    ]),
  );
}

function loadAssets() {
  return new Map(
    assetDefinitions.map((definition) => {
      const source = safeFile(resolve(publicDirectory, "assets"), definition.file);
      const bytes =
        definition.encoding === "base64"
          ? Buffer.from(source.toString("ascii").trim(), "base64")
          : source;
      return [definition.filename, { ...definition, bytes }];
    }),
  );
}

function pageSummary(page) {
  return {
    id: page.id,
    title: page.title,
    parentId: page.parentId,
    version: page.version,
    hasDraft: page.draft !== null,
    components: [...page.components],
    expectations: clone(page.expectations),
  };
}
function pageDetail(page, store) {
  return {
    page: pageSummary(page),
    published: { storage: page.storage, view: page.view, editor: page.editor },
    draft: clone(page.draft),
    scenario: page.scenario,
    generation: store.generation,
  };
}
function lookup(store, id) {
  const page = store.pages.get(id);
  if (!page) notFound();
  return page;
}
function ancestors(page, store) {
  const result = [];
  let parentId = page.parentId;
  while (parentId) {
    const parent = lookup(store, parentId);
    result.unshift({ id: parent.id, title: parent.title, type: "page" });
    parentId = parent.parentId;
  }
  return result;
}
function attachmentRecords(pageId, assets, origin) {
  if (pageId !== "1700") return [];
  return [...assets.values()].map((asset, index) => ({
    id: String(47001 + index),
    type: "attachment",
    status: "current",
    title: asset.filename,
    extensions: { mediaType: asset.mediaType, fileSize: asset.bytes.length },
    container: { id: pageId, type: "page" },
    version: revision(1, "Lorem local attachment"),
    _links: {
      base: origin,
      download: `/download/attachments/${pageId}/${encodeURIComponent(asset.filename)}`,
      self: `${origin}/rest/api/content/${47001 + index}`,
    },
  }));
}
function pageRaw(page, store, origin, assets, requestedRevision) {
  const historical =
    requestedRevision === undefined
      ? null
      : page.revisions.find((candidate) => candidate.number === requestedRevision);
  if (requestedRevision !== undefined && !historical) notFound();
  const published = historical ? projections(historical.storage, page) : page;
  const version =
    historical || page.revisions.find((candidate) => candidate.number === page.version);
  return {
    id: page.id,
    type: "page",
    status: "current",
    title: historical?.title || page.title,
    space: { key: "LOREM", name: "Lorem laboratory" },
    version: revision(version.number, version.message),
    ancestors: ancestors(page, store),
    body: {
      storage: { value: published.storage, representation: "storage" },
      view: { value: published.view, representation: "view" },
      editor: { value: published.editor, representation: "editor" },
    },
    children: {
      page: {
        results: [],
        size: [...store.pages.values()].filter((candidate) => candidate.parentId === page.id)
          .length,
      },
      attachment: {
        results: attachmentRecords(page.id, assets, origin),
        size: attachmentRecords(page.id, assets, origin).length,
      },
    },
    metadata: {
      labels: {
        results: page.labels.map((name) => ({ name, prefix: "global" })),
        size: page.labels.length,
      },
    },
    _links: {
      base: origin,
      context: "",
      webui: `/pages/viewpage.action?pageId=${page.id}`,
      editui: `/pages/editpage.action?pageId=${page.id}`,
      self: `${origin}/rest/api/content/${page.id}`,
    },
  };
}
function paginate(items, url, origin) {
  const startText = url.searchParams.get("start") ?? "0";
  const limitText = url.searchParams.get("limit") ?? "25";
  if (!/^\d+$/.test(startText) || !/^[1-9]\d*$/.test(limitText))
    invalid("Invalid pagination start or limit");
  const start = Number(startText);
  const limit = Math.min(Number(limitText), 200);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(Number(limitText)))
    invalid("Pagination exceeds its integer limit");
  const results = items.slice(start, start + limit);
  const links = { base: origin, self: url.pathname + url.search };
  if (start + results.length < items.length) {
    const next = new URL(url);
    next.searchParams.set("start", String(start + results.length));
    next.searchParams.set("limit", String(limit));
    links.next = next.pathname + next.search;
  }
  return { results, start, limit, size: results.length, totalSize: items.length, _links: links };
}

function filterCollectionCql(pages, cql) {
  const query = /^space="((?:[^"\\]|\\["\\])*)" and type=([A-Za-z\d_-]+) and label="((?:[^"\\]|\\["\\])*)"$/.exec(cql);
  if (!query) invalid("Only the local space/type/label CQL subset is supported");
  const space = query[1].replace(/\\(["\\])/g, "$1");
  const label = query[3].replace(/\\(["\\])/g, "$1");
  return space === "LOREM" && query[2] === "page"
    ? pages.filter((page) => page.labels.includes(label))
    : [];
}

function jiraPage(items, url, field) {
  const startText = url.searchParams.get("startAt") ?? "0";
  const limitText = url.searchParams.get("maxResults") ?? "50";
  if (!/^\d+$/.test(startText) || !/^[1-9]\d*$/.test(limitText))
    invalid("Invalid Jira pagination startAt or maxResults");
  const startAt = Number(startText);
  const requestedLimit = Number(limitText);
  if (!Number.isSafeInteger(startAt) || !Number.isSafeInteger(requestedLimit))
    invalid("Jira pagination exceeds its integer limit");
  const maxResults = Math.min(requestedLimit, 50);
  return { startAt, maxResults, total: items.length, [field]: items.slice(startAt, startAt + maxResults) };
}

function jiraIssueRaw(issue, assets, origin) {
  return {
    id: String(81000 + jiraCatalog.indexOf(issue)),
    key: issue.key,
    self: `${origin}/rest/api/2/issue/${issue.key}`,
    fields: {
      project: { key: "LOR", name: "Lorem Jira" },
      issuetype: { name: "Task" },
      status: { name: issue.status },
      priority: { name: "Medium" },
      resolution: issue.status === "Done" ? { name: "Done" } : null,
      summary: issue.summary,
      description: issue.description,
      assignee: { key: "lorem-assignee", displayName: "Lorem Assignee" },
      reporter: { key: "lorem-reporter", displayName: "Lorem Reporter" },
      labels: ["lorem", "sandbox"],
      components: [{ name: "Lorem component" }],
      versions: [{ name: "Lorem 1" }],
      fixVersions: [],
      created: revisionTime(1),
      updated: revisionTime(1),
      duedate: null,
      attachment: issue.attachments.map((filename, index) => {
        const asset = assets.get(filename);
        return {
          id: String(63000 + index),
          filename,
          mimeType: asset.mediaType,
          size: asset.bytes.length,
          content: `${origin}/jira/attachments/${issue.key}/${encodeURIComponent(filename)}`,
        };
      }),
    },
  };
}

function jiraSearch(jql) {
  const query = jql.trim();
  if (!query || /^project\s*=\s*(?:LOR|"LOR")(?:\s+ORDER\s+BY\s+key\s+ASC)?$/i.test(query))
    return jiraCatalog;
  const key = /^key\s*=\s*(?:"(LOR-\d+)"|(LOR-\d+))$/i.exec(query);
  if (key) return jiraCatalog.filter((issue) => issue.key === (key[1] || key[2]).toUpperCase());
  invalid("Only the local LOR project or a single LOR key is supported");
}

function loopbackOrigin(host) {
  if (typeof host !== "string" || !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i.test(host))
    throw new HttpError(403, "Only loopback Host values are allowed");
  const port = /:(\d+)$/.exec(host)?.[1];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535))
    throw new HttpError(403, "Invalid loopback Host port");
  const url = new URL(`http://${host}`);
  return url.origin;
}
function allowedOrigin(value, origin) {
  return (
    value === undefined ||
    value === origin ||
    /^chrome-extension:\/\/[a-p]{32}$/.test(value) ||
    /^moz-extension:\/\/[a-z\d-]{1,80}$/i.test(value)
  );
}
function requestPath(rawUrl) {
  if (!rawUrl || !rawUrl.startsWith("/")) invalid("Invalid local request target");
  let decoded;
  try {
    decoded = decodeURIComponent(rawUrl.split("?")[0]);
  } catch {
    invalid("Invalid encoded path");
  }
  if (
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.split("/").includes("..") ||
    decoded.startsWith("//")
  )
    invalid("Invalid local path traversal");
  return decoded;
}
function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) {
    req.resume();
    throw new HttpError(415, "Writes require application/json");
  }
  if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) {
    req.resume();
    throw new HttpError(413, "Request body exceeds the 2 MiB limit");
  }
  return new Promise((resolveBody, reject) => {
    let size = 0;
    let rejected = false;
    const chunks = [];
    req.on("data", (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        chunks.length = 0;
        reject(new HttpError(413, "Request body exceeds the 2 MiB limit"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (rejected) return;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        const value = JSON.parse(text);
        if (value === null || typeof value !== "object" || Array.isArray(value))
          invalid("JSON body must be an object");
        resolveBody(value);
      } catch (error) {
        reject(
          error instanceof HttpError ? error : new HttpError(400, "Invalid JSON request body"),
        );
      }
    });
    req.on("error", () => reject(new HttpError(400, "Incomplete request body")));
  });
}
function checkGeneration(body, req, store, required = false) {
  const header = req.headers["x-sandbox-generation"];
  if (required && body.generation === undefined && header === undefined)
    invalid("A current sandbox generation is required");
  for (const value of [body.generation, header === undefined ? undefined : Number(header)]) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1) invalid("Invalid sandbox generation");
    if (value !== store.generation)
      throw new HttpError(409, "Sandbox reset invalidated this write; reload the page");
  }
}
function safeFile(root, relative) {
  try {
    const actualRoot = realpathSync(root);
    const actual = realpathSync(resolve(actualRoot, relative));
    if (!actual.startsWith(actualRoot + sep) || !statSync(actual).isFile()) notFound();
    return readFileSync(actual);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    notFound();
  }
}
function clip(value, limit) {
  const source = typeof value === "string" ? value : JSON.stringify(value);
  return source.length <= limit
    ? { value: source, truncated: false }
    : { value: source.slice(0, Math.max(0, limit - 20)) + "\n[truncated]", truncated: true };
}
function appendInsidePage(storage, paragraph) {
  // Layout fixtures keep ordinary specimen additions inside their first cell.
  const marker = "</ac:layout-cell>";
  return storage.includes(marker)
    ? storage.replace(marker, paragraph + marker)
    : storage + paragraph;
}
function corruptCandidate(storage) {
  const opening = storage.indexOf("<ac:structured-macro");
  if (opening !== -1) {
    const end = storage.indexOf("</ac:structured-macro>", opening);
    if (end !== -1)
      return storage.slice(0, opening) + storage.slice(end + "</ac:structured-macro>".length);
  }
  // Loss scenarios also work on plain pages, without making the live baseline lossy.
  const paragraph = /<p(?:\s[^>]*)?>[\s\S]*?<\/p>/.exec(storage);
  return paragraph
    ? storage.slice(0, paragraph.index) + storage.slice(paragraph.index + paragraph[0].length)
    : storage + "<p>Lorem injected conversion loss.</p>";
}

export function createSandboxServer({ logLimit = 200, logBodyLimit = 4096 } = {}) {
  if (
    !Number.isInteger(logLimit) ||
    logLimit < 1 ||
    logLimit > 1000 ||
    !Number.isInteger(logBodyLimit) ||
    logBodyLimit < 80 ||
    logBodyLimit > 16384
  )
    throw new Error("Invalid bounded request log configuration");
  const assets = loadAssets();
  const store = { generation: 1, pages: seedPages(), logs: [], nextSeq: 1 };
  const record = (entry) => {
    store.logs.push({ seq: store.nextSeq++, at: new Date().toISOString(), ...entry });
    if (store.logs.length > logLimit) store.logs.splice(0, store.logs.length - logLimit);
  };
  const server = http.createServer(async (req, res) => {
    let path = "/";
    let kind = "read";
    let pageId;
    let requestLog;
    let responseLog;
    let truncated = false;
    let suppressLog = false;
    const send = (
      status,
      value,
      contentType = "application/json; charset=utf-8",
      extraHeaders = {},
    ) => {
      res.writeHead(status, { ...securityHeaders, "Content-Type": contentType, ...extraHeaders });
      res.end(Buffer.isBuffer(value) || typeof value === "string" ? value : JSON.stringify(value));
      if (!suppressLog) {
        const entry = { method: req.method, path, status, kind };
        if (pageId) entry.pageId = pageId;
        if (requestLog !== undefined) entry.request = requestLog;
        if (responseLog !== undefined) entry.response = responseLog;
        if (truncated) entry.truncated = true;
        record(entry);
      }
    };
    const logBodies = (requestBody, responseBody) => {
      const request = clip(requestBody, logBodyLimit);
      const response = clip(responseBody, logBodyLimit);
      requestLog = request.value;
      responseLog = response.value;
      truncated = request.truncated || response.truncated;
    };
    try {
      const origin = loopbackOrigin(req.headers.host);
      path = requestPath(req.url);
      const url = new URL(req.url, origin);
      const write = ["POST", "PUT", "DELETE", "PATCH"].includes(req.method);
      if ((write || req.method === "OPTIONS") && !allowedOrigin(req.headers.origin, origin)) {
        kind = "security";
        req.resume();
        throw new HttpError(403, "Foreign web origins cannot write to the local sandbox");
      }
      if (req.headers.origin && allowedOrigin(req.headers.origin, origin)) {
        res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
        res.setHeader("Vary", "Origin");
      }
      if (req.method === "OPTIONS") {
        send(204, "", "text/plain", {
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Sandbox-Generation",
        });
        return;
      }
      let payload;
      if (write) payload = await readJson(req);
      const get = req.method === "GET";
      const requireMethod = (method) => {
        if (req.method !== method)
          throw new HttpError(405, "Method not supported by this sandbox route");
      };
      const raw = (page, version) => {
        const value = pageRaw(page, store, origin, assets, version);
        if (url.searchParams.get("expand")?.split(",").includes("childTypes.page")) {
          value.childTypes = { page: { value: value.children.page.size > 0 } };
        }
        return value;
      };
      const collection = (items) => paginate(items, url, origin);
      const pageCollection = (pages) => {
        const batch = collection(pages);
        return { ...batch, results: batch.results.map((page) => raw(page)) };
      };
      if (path === "/health") {
        requireMethod("GET");
        send(200, { status: "ok", sandbox: "lorem", generation: store.generation });
        return;
      }
      if (path === "/sandbox/api/state") {
        requireMethod("GET");
        send(200, {
          generation: store.generation,
          pages: [...store.pages.values()].map(pageSummary),
          scenarios: clone(SCENARIOS),
        });
        return;
      }
      if (path === "/sandbox/api/logs") {
        requireMethod("GET");
        suppressLog = true;
        send(200, { entries: clone(store.logs) });
        return;
      }
      if (path === "/sandbox/api/reset") {
        requireMethod("POST");
        if (payload.confirm !== "reset-lorem")
          invalid("Reset requires explicit reset-lorem confirmation");
        checkGeneration(payload, req, store);
        store.pages = seedPages();
        store.generation += 1;
        kind = "reset";
        const result = { generation: store.generation };
        logBodies({ confirm: payload.confirm }, result);
        send(200, result);
        return;
      }
      const localPage = /^\/sandbox\/api\/pages\/([1-9]\d*)(?:\/(draft|scenario))?$/.exec(path);
      if (localPage) {
        pageId = localPage[1];
        const page = lookup(store, pageId);
        if (!localPage[2]) {
          requireMethod("GET");
          send(200, pageDetail(page, store));
          return;
        }
        if (localPage[2] === "draft") {
          if (!["POST", "DELETE"].includes(req.method))
            throw new HttpError(405, "Draft supports POST and DELETE");
          checkGeneration(payload, req, store, true);
          let result;
          if (req.method === "DELETE") {
            page.draft = null;
            result = { generation: store.generation };
          } else {
            if (typeof payload.editor !== "string") invalid("Draft requires native editor HTML");
            const suppliedBase = payload.baseVersion;
            if (
              suppliedBase !== undefined &&
              (!Number.isSafeInteger(suppliedBase) ||
                suppliedBase < 1 ||
                suppliedBase > page.version ||
                !page.revisions.some((entry) => entry.number === suppliedBase))
            )
              invalid("Invalid draft baseVersion");
            const storage = editorToStorage(payload.editor);
            const projected = projections(storage, page);
            page.draft = {
              storage: projected.storage,
              editor: projected.editor,
              baseVersion: page.draft?.baseVersion ?? suppliedBase ?? page.version,
            };
            result = { draft: clone(page.draft), generation: store.generation };
          }
          kind = "draft";
          logBodies(
            req.method === "DELETE"
              ? { generation: payload.generation }
              : {
                  editor: payload.editor,
                  generation: payload.generation,
                  baseVersion: payload.baseVersion,
                },
            result,
          );
          send(200, result);
          return;
        }
        requireMethod("POST");
        checkGeneration(payload, req, store);
        if (!SCENARIOS.some((scenario) => scenario.id === payload.scenario))
          invalid("Unsupported guard scenario");
        if (payload.scenario === "published-newer") {
          const projected = projections(
            appendInsidePage(page.storage, "<p>Lorem newer published revision.</p>"),
            page,
          );
          page.version += 1;
          Object.assign(page, projected);
          page.revisions.push({
            ...revision(page.version, "Lorem scenario publication"),
            storage: page.storage,
            title: page.title,
          });
        } else if (payload.scenario === "published-source-changed") {
          Object.assign(
            page,
            projections(
              appendInsidePage(
                page.storage,
                "<p>Lorem published source changed at the same revision.</p>",
              ),
              page,
            ),
          );
          const current = page.revisions.find((entry) => entry.number === page.version);
          current.storage = page.storage;
        } else if (payload.scenario === "draft-changed") {
          const projected = projections(
            appendInsidePage(
              page.draft?.storage ?? page.storage,
              "<p>Lorem independently changed draft.</p>",
            ),
            page,
          );
          page.draft = {
            storage: projected.storage,
            editor: projected.editor,
            baseVersion: page.draft?.baseVersion ?? page.version,
          };
        }
        page.scenario = payload.scenario;
        kind = "scenario";
        logBodies(
          { scenario: payload.scenario },
          { scenario: page.scenario, version: page.version, generation: store.generation },
        );
        send(200, pageDetail(page, store));
        return;
      }
      const conversion = /^\/rest\/api\/contentbody\/convert\/(editor|storage|view)$/.exec(path);
      if (conversion) {
        requireMethod("POST");
        const to = conversion[1];
        if (
          typeof payload.value !== "string" ||
          !["storage", "editor"].includes(payload.representation) ||
          payload.representation === to ||
          (to === "view" && payload.representation !== "storage")
        )
          invalid("Unsupported body conversion pair");
        const contentId = payload.content?.id;
        if (
          contentId !== undefined &&
          (typeof contentId !== "string" || !/^[1-9]\d*$/.test(contentId))
        )
          invalid("Invalid conversion page context");
        if (to !== "view" && contentId === undefined)
          invalid("Native conversions require local page context");
        const page = contentId === undefined ? lookup(store, "1000") : lookup(store, contentId);
        pageId = page.id;
        let value =
          to === "editor"
            ? storageToEditor(payload.value)
            : to === "view"
              ? storageToView(payload.value, renderContext(page))
              : editorToStorage(payload.value);
        if (
          page.scenario === "conversion-loss" &&
          to === "storage" &&
          value !== page.storage &&
          value !== page.draft?.storage
        )
          value = corruptCandidate(value);
        const result = { value, representation: to };
        kind = "conversion";
        logBodies(
          {
            value: payload.value,
            representation: payload.representation,
            ...(contentId ? { content: { id: contentId } } : {}),
          },
          result,
        );
        send(200, result);
        return;
      }
      if (path === "/rest/api/2/search") {
        requireMethod("GET");
        const issues = jiraSearch(url.searchParams.get("jql") ?? "");
        send(200, jiraPage(issues.map((issue) => jiraIssueRaw(issue, assets, origin)), url, "issues"));
        return;
      }
      const jiraIssue = /^\/rest\/api\/2\/issue\/(LOR-\d+)(?:\/(.*))?$/.exec(path);
      if (jiraIssue) {
        requireMethod("GET");
        const issue = jiraCatalog.find((candidate) => candidate.key === jiraIssue[1]);
        if (!issue) notFound();
        if (!jiraIssue[2]) send(200, jiraIssueRaw(issue, assets, origin));
        else if (jiraIssue[2] === "comment") {
          const comments = issue.comments.map((comment) => ({
            ...comment,
            author: { key: "lorem-reviewer", displayName: "Lorem Reviewer" },
            created: revisionTime(1),
            updated: revisionTime(1),
          }));
          send(200, jiraPage(comments, url, "comments"));
        } else notFound();
        return;
      }
      const jiraAttachment = /^\/jira\/attachments\/(LOR-\d+)\/([^/]+)$/.exec(path);
      if (jiraAttachment) {
        requireMethod("GET");
        const issue = jiraCatalog.find((candidate) => candidate.key === jiraAttachment[1]);
        if (!issue?.attachments.includes(jiraAttachment[2])) notFound();
        const asset = assets.get(jiraAttachment[2]);
        kind = "asset";
        send(200, asset.bytes, asset.mediaType);
        return;
      }
      const jiraShell = /^\/browse\/(LOR-\d+)$/.exec(path);
      if (jiraShell) {
        requireMethod("GET");
        const issue = jiraCatalog.find((candidate) => candidate.key === jiraShell[1]);
        if (!issue) notFound();
        const meta = `<meta name="ajs-issue-key" content="${issue.key}"><meta name="ajs-context-path" content="">`;
        const issueLinks = jiraCatalog.map((item) => `<a href="/browse/${item.key}">${item.key}</a>`).join(" · ");
        const shell = `<!doctype html><html lang="en"><head><meta charset="utf-8">${meta}<title>${issue.key} — Lorem Jira sandbox</title><link rel="stylesheet" href="/sandbox/styles.css"></head><body><main><p><a href="/">Lorem sandbox</a> · Jira read-only specimens</p><nav>${issueLinks}</nav><h1 id="summary-val">${escapeHtml(issue.summary)}</h1><p id="key-val">${issue.key}</p><div id="type-val">Task</div><div id="status-val">${escapeHtml(issue.status)}</div><div id="description-val"><pre>${escapeHtml(issue.description)}</pre></div><p>Export-only fixture. No Jira editing, publishing or general JQL backend.</p></main></body></html>`;
        kind = "shell";
        send(200, shell, "text/html; charset=utf-8");
        return;
      }
      if (["/rest/api/content", "/rest/api/content/search"].includes(path)) {
        requireMethod("GET");
        let pages = [...store.pages.values()];
        if (url.searchParams.has("type") && url.searchParams.get("type") !== "page") pages = [];
        if (url.searchParams.has("spaceKey") && url.searchParams.get("spaceKey") !== "LOREM")
          pages = [];
        if (url.searchParams.has("title"))
          pages = pages.filter((page) => page.title === url.searchParams.get("title"));
        if (path === "/rest/api/content/search" && !url.searchParams.has("cql")) {
          invalid("Local content/search requires the bounded space/type/label CQL query");
        }
        if (url.searchParams.has("cql")) {
          pages = filterCollectionCql(pages, url.searchParams.get("cql"));
        }
        send(200, pageCollection(pages));
        return;
      }
      const content = /^\/rest\/api\/content\/([1-9]\d*)(?:\/(.*))?$/.exec(path);
      if (content) {
        pageId = content[1];
        const suffix = content[2] || "";
        if (suffix === "child/attachment" && ["27001", "37001", "37002"].includes(pageId)) {
          requireMethod("GET");
          send(200, collection([]));
          return;
        }
        const page = lookup(store, pageId);
        if (!suffix) {
          if (get) {
            let version;
            if (url.searchParams.has("version")) {
              const text = url.searchParams.get("version");
              if (!/^[1-9]\d*$/.test(text)) invalid("Invalid requested revision");
              version = Number(text);
            }
            send(200, raw(page, version));
            return;
          }
          requireMethod("PUT");
          checkGeneration(payload, req, store);
          if (
            payload.id !== pageId ||
            payload.type !== "page" ||
            typeof payload.title !== "string" ||
            !payload.title.trim() ||
            payload.title.length > 200 ||
            /[\x00-\x1f]/.test(payload.title) ||
            payload.body?.storage?.representation !== "storage" ||
            typeof payload.body.storage.value !== "string" ||
            !Number.isSafeInteger(payload.version?.number)
          )
            invalid("Invalid local publish payload");
          if (payload.version.number !== page.version + 1)
            throw new HttpError(409, "Published revision changed; reload before publishing");
          const projected = projections(payload.body.storage.value, page);
          page.title = payload.title;
          page.version = payload.version.number;
          Object.assign(page, projected);
          page.draft = null;
          page.revisions.push({
            ...revision(page.version, "Lorem explicit sandbox publish"),
            storage: page.storage,
            title: page.title,
          });
          kind = "publish";
          logBodies(
            {
              id: pageId,
              title: page.title,
              version: { number: page.version },
              body: { storage: { value: page.storage, representation: "storage" } },
            },
            { id: pageId, version: { number: page.version } },
          );
          send(200, raw(page));
          return;
        }
        requireMethod("GET");
        if (["child/page", "descendant/page"].includes(suffix)) {
          const pages = [...store.pages.values()].filter((candidate) =>
            suffix === "child/page"
              ? candidate.parentId === pageId
              : ancestors(candidate, store).some((ancestor) => ancestor.id === pageId),
          );
          send(200, pageCollection(pages));
          return;
        }
        if (suffix === "child/attachment") {
          send(200, collection(attachmentRecords(pageId, assets, origin)));
          return;
        }
        if (["comment", "child/comment"].includes(suffix)) {
          const comments =
            pageId === "1700"
              ? [
                  {
                    id: "27001",
                    type: "comment",
                    status: "current",
                    title: "Lorem comment",
                    container: { id: pageId },
                    body: {
                      view: {
                        value: "<p>Lorem comment by a synthetic author.</p>",
                        representation: "view",
                      },
                    },
                    version: revision(1, "Lorem comment specimen"),
                    _links: {
                      base: origin,
                      webui: `/pages/viewpage.action?pageId=${pageId}#comment-27001`,
                    },
                  },
                ]
              : [];
          send(200, collection(comments));
          return;
        }
        if (suffix === "version") {
          send(
            200,
            collection(
              [...page.revisions].reverse().map(({ storage, title, ...version }) => clone(version)),
            ),
          );
          return;
        }
        if (/^(?:version|history)\/[1-9]\d*$/.test(suffix)) {
          const number = Number(suffix.split("/")[1]);
          const version = page.revisions.find((candidate) => candidate.number === number);
          if (!version) notFound();
          send(200, revision(version.number, version.message));
          return;
        }
        if (suffix === "history") {
          send(200, {
            latest: true,
            createdBy: { ...AUTHOR },
            createdDate: revisionTime(1),
            lastUpdated: revision(page.version, "Lorem latest publication"),
            previousVersion:
              page.version > 1 ? revision(page.version - 1, "Lorem previous publication") : null,
            _links: { base: origin, self: `${origin}${path}` },
          });
          return;
        }
        notFound();
      }
      if (path === "/rest/api/space/LOREM") {
        requireMethod("GET");
        send(200, {
          id: "1",
          key: "LOREM",
          name: "Lorem laboratory",
          type: "global",
          description: {
            plain: {
              value: "Synthetic Lorem sandbox; no workplace data.",
              representation: "plain",
            },
          },
          homepage: { id: "1000", title: lookup(store, "1000").title },
          _links: { base: origin, webui: "/pages/viewpage.action?pageId=1000" },
        });
        return;
      }
      if (["/rest/api/space/LOREM/content/page", "/rest/api/space/LOREM/content"].includes(path)) {
        requireMethod("GET");
        send(200, pageCollection([...store.pages.values()]));
        return;
      }
      if (path === "/rest/inlinecomments/1.0/comments") {
        requireMethod("GET");
        const owner = url.searchParams.get("containerId");
        lookup(store, owner);
        send(
          200,
          owner === "1700"
            ? [
                {
                  id: "37001",
                  authorDisplayName: "Lorem Reviewer",
                  lastModificationDate: revisionTime(1),
                  body: "<p>Lorem inline comment.</p>",
                  originalSelection: "Lorem asset specimen",
                  markerRef: "lorem-inline-001",
                  resolveProperties: { resolved: false },
                },
              ]
            : [],
        );
        return;
      }
      if (path === "/rest/inlinecomments/1.0/comments/37001/replies") {
        requireMethod("GET");
        send(200, [
          {
            id: "37002",
            authorDisplayName: "Ipsum Reviewer",
            lastModificationDate: revisionTime(1),
            body: "<p>Lorem inline reply.</p>",
          },
        ]);
        return;
      }
      const download = /^\/download\/attachments\/1700\/([^/]+)$/.exec(path);
      if (download || path.startsWith("/sandbox/assets/")) {
        requireMethod("GET");
        const name = download ? download[1] : path.slice("/sandbox/assets/".length);
        const asset = assets.get(name);
        if (!asset) notFound();
        kind = "asset";
        send(200, asset.bytes, asset.mediaType, {
          "Content-Disposition": `${asset.mediaType.startsWith("image/") ? "inline" : "attachment"}; filename="${asset.filename}"`,
        });
        return;
      }
      if (path === "/" || ["/pages/viewpage.action", "/pages/editpage.action"].includes(path)) {
        requireMethod("GET");
        const id = path === "/" ? "1000" : url.searchParams.get("pageId");
        const page = lookup(store, id);
        pageId = page.id;
        const meta = `<meta name="ajs-page-id" content="${page.id}"><meta name="ajs-page-title" content="${escapeHtml(page.title)}"><meta name="ajs-context-path" content=""><title>${escapeHtml(page.title)} — Lorem sandbox</title>`;
        const html = safeFile(publicDirectory, "index.html")
          .toString("utf8")
          .replace("<!--sandbox:meta-->", meta);
        kind = "shell";
        send(200, html, "text/html; charset=utf-8");
        return;
      }
      const frontendFiles = {
        "/sandbox/app.js": "app.js",
        "/sandbox/styles.css": "styles.css",
        "/sandbox/editor-content.css": "editor-content.css",
      };
      if (Object.hasOwn(frontendFiles, path)) {
        requireMethod("GET");
        const file = frontendFiles[path];
        const extension = file.slice(file.lastIndexOf("."));
        kind = "asset";
        send(200, safeFile(publicDirectory, file), MIME[extension]);
        return;
      }
      if (path.startsWith("/vendor/tinymce/")) {
        requireMethod("GET");
        const relative = path.slice("/vendor/tinymce/".length);
        if (
          !relative ||
          relative.split("/").some((part) => !part || part === "." || part === "..") ||
          !/^[A-Za-z\d_./-]+$/.test(relative)
        )
          notFound();
        const extension = relative.slice(relative.lastIndexOf("."));
        if (!MIME[extension]) notFound();
        kind = "asset";
        send(200, safeFile(vendorDirectory, relative), MIME[extension]);
        return;
      }
      notFound();
    } catch (error) {
      req.resume();
      requestLog = undefined;
      responseLog = undefined;
      const status =
        error instanceof HttpError ? error.status : error instanceof CodecError ? 422 : 500;
      if (status === 403) kind = "security";
      send(status, { error: status === 500 ? "Local sandbox request failed" : error.message });
    }
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 50;
  return { server, store };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.SANDBOX_PORT ?? 4177);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("SANDBOX_PORT must be an integer from 0 to 65535.");
    process.exitCode = 1;
  } else {
    const { server } = createSandboxServer();
    server.on("error", () => {
      console.error("Unable to start the local Lorem sandbox.");
      process.exitCode = 1;
    });
    server.listen(port, "127.0.0.1", () =>
      console.log(`Lorem sandbox ready at http://127.0.0.1:${server.address().port}`),
    );
  }
}
