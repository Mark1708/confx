import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { once } from "node:events";
import { createSandboxServer } from "../server.mjs";

async function fixture(t, options = {}) {
  const { server, store } = createSandboxServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const origin = `http://127.0.0.1:${server.address().port}`;
  const json = async (path, method = "GET", body, headers = {}) => {
    const response = await fetch(origin + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json(), response };
  };
  const page = async (id = "1000") => (await json(`/sandbox/api/pages/${id}`)).data;
  return { server, store, origin, json, page };
}

function raw(origin, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(new URL(origin), { path, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

function publishBody(
  detail,
  storage = detail.published.storage,
  version = detail.page.version + 1,
) {
  return {
    id: detail.page.id,
    type: "page",
    title: detail.page.title,
    version: { number: version },
    generation: detail.generation,
    body: { storage: { value: storage, representation: "storage" } },
  };
}

test("health, catalog and real page shell provide loopback metadata and explicit routes", async (t) => {
  const { origin, json } = await fixture(t);
  assert.equal((await json("/health")).status, 200);
  const state = (await json("/sandbox/api/state")).data;
  assert.deepEqual(
    state.pages.map((page) => page.id),
    ["1000", "1100", "1200", "1300", "1400", "1500", "1600", "1700", "1710", "1800"],
  );
  assert.deepEqual(
    state.scenarios.map((scenario) => scenario.id),
    ["normal", "published-newer", "published-source-changed", "draft-changed", "conversion-loss"],
  );
  for (const route of [
    "/",
    "/pages/viewpage.action?pageId=1100",
    "/pages/editpage.action?pageId=1100",
  ]) {
    const response = await fetch(origin + route);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const html = await response.text();
    assert.match(html, /name="ajs-page-id" content="(?:1000|1100)"/);
    assert.match(html, /name="ajs-context-path" content=""/);
    assert.ok(!html.includes("<!--sandbox:meta-->"));
  }
  for (const route of [
    "/unknown.js",
    "/rest/api/not-a-route",
    "/pages/viewpage.action?pageId=9999",
    "/sandbox/not-found",
    "/pages/viewpage.action?pageId=not-an-id",
  ])
    assert.equal((await fetch(origin + route)).status, 404, route);
  const vendor = await fetch(origin + "/vendor/tinymce/tinymce.min.js");
  assert.equal(vendor.status, 200);
  assert.match(await vendor.text(), /tinymce/i);
});

test("Confluence page, hierarchy, title search and space routes match actual fetcher shapes and pagination", async (t) => {
  const { origin, json } = await fixture(t);
  const page = (
    await json(
      "/rest/api/content/1710?expand=body.view,body.storage,version,ancestors,children.attachment,metadata.labels",
    )
  ).data;
  assert.equal(page.id, "1710");
  assert.equal(page.type, "page");
  assert.equal(page.status, "current");
  assert.equal(page.space.key, "LOREM");
  assert.equal(page.version.number, 1);
  assert.deepEqual(
    page.ancestors.map((ancestor) => ancestor.id),
    ["1000", "1700"],
  );
  assert.match(page.body.storage.value, /Lorem nested specimen/);
  assert.match(page.body.view.value, /Lorem nested specimen/);
  assert.equal(page._links.base, origin);
  assert.equal(page._links.webui, "/pages/viewpage.action?pageId=1710");
  assert.ok(page.metadata.labels.results.some((label) => label.name === "lorem"));
  let path = "/rest/api/content/1000/descendant/page?limit=2&start=0";
  const descendants = [];
  while (path) {
    const response = (await json(path)).data;
    assert.equal(response.size, response.results.length);
    descendants.push(...response.results.map((item) => item.id));
    path = response._links.next;
  }
  assert.equal(new Set(descendants).size, 9);
  assert.ok(descendants.includes("1710"));
  const children = (await json("/rest/api/content/1700/child/page?limit=1")).data;
  assert.deepEqual(
    children.results.map((item) => item.id),
    ["1710"],
  );
  const space = (await json("/rest/api/space/LOREM?expand=description.plain,homepage")).data;
  assert.equal(space.homepage.id, "1000");
  assert.equal(space.key, "LOREM");
  assert.equal(
    (await json("/rest/api/space/LOREM/content/page?limit=200")).data.results.length,
    10,
  );
  assert.deepEqual(
    (
      await json("/rest/api/content?spaceKey=LOREM&type=page&title=Lorem%20nested%20specimen")
    ).data.results.map((item) => item.id),
    ["1710"],
  );
  assert.equal(
    (
      await json(
        "/rest/api/content?cql=" +
          encodeURIComponent('space="LOREM" and type=page and label="lorem"'),
      )
    ).data.results.length,
    10,
  );
});

test("bounded content/search CQL decodes quoted/backslash label literals and rejects unsupported predicates", async (t) => {
  const { json, store } = await fixture(t);
  const label = 'lo"rem\\tag';
  store.pages.get("1710").labels = [label];
  const literal = label.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const query = `space="LOREM" and type=page and label="${literal}"`;
  const found = await json(`/rest/api/content/search?${new URLSearchParams({ cql: query, limit: "200" })}`);
  assert.equal(found.status, 200);
  assert.deepEqual(found.data.results.map((page) => page.id), ["1710"]);
  assert.equal(found.data.start, 0);
  assert.equal(found.data.size, 1);
  assert.equal((await json(`/rest/api/content/search?${new URLSearchParams({ cql: query, start: "1" })}`)).data.size, 0);
  for (const cql of [
    'space="OTHER" and type=page and label="lorem"',
    'space="LOREM" and type=attachment and label="lorem"',
  ]) {
    const result = await json(`/rest/api/content/search?${new URLSearchParams({ cql })}`);
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.results, []);
  }
  for (const cql of [
    'space="LOREM" OR type=page',
    'space="LOREM" and type=page and creator="lorem"',
    'space="LOREM" and type=page and label="unterminated',
    'space="LOREM" and type=page and label="invalid\\escape"',
    'space="LOREM" and type=page and label="lorem" ORDER BY id',
  ]) {
    assert.equal((await json(`/rest/api/content/search?${new URLSearchParams({ cql })}`)).status, 400, cql);
  }
});

test("read-only space and child collections include synthetic tails beyond 200 and 5000 entries", { timeout: 10_000 }, async (t) => {
  const { json, store } = await fixture(t);
  const root = store.pages.get("1000");
  store.pages = new Map([["1000", root]]);
  for (let i = 0; i < 6_001; i += 1) {
    const id = String(20_000 + i);
    store.pages.set(id, { ...root, id, title: `Lorem collection ${i}`, parentId: "1000" });
  }
  const space = await json("/rest/api/space/LOREM/content/page?start=200&limit=200");
  assert.equal(space.status, 200);
  assert.equal(space.data.results.length, 200);
  assert.equal(space.data.results[0].id, "20199");
  const tail = await json("/rest/api/content/1000/child/page?start=6000&limit=100&expand=version,version.by");
  assert.equal(tail.status, 200);
  assert.deepEqual(tail.data.results.map((page) => page.id), ["26000"]);
  assert.equal(tail.data.results[0].version.number, 1);
  assert.equal((await json("/rest/api/content/1000/child/page?start=6001&limit=100")).data.size, 0);
  const labelled = await json(`/rest/api/content/search?${new URLSearchParams({
    cql: 'space="LOREM" and type=page and label="lorem"',
    start: "6001",
    limit: "200",
  })}`);
  assert.equal(labelled.status, 200);
  assert.deepEqual(labelled.data.results.map((page) => page.id), ["26000"]);
});

test("attachments, synthetic comments, inline replies and revision history are genuinely downloadable", async (t) => {
  const { origin, json } = await fixture(t);
  const attachments = (await json("/rest/api/content/1700/child/attachment?limit=200&start=0"))
    .data;
  assert.deepEqual(
    attachments.results.map((item) => item.title),
    ["lorem.png", "lorem.json", "lorem.csv", "lorem.pdf"],
  );
  for (const attachment of attachments.results) {
    assert.equal(attachment.container.id, "1700");
    const response = await fetch(origin + attachment._links.download);
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type").split(";")[0],
      attachment.extensions.mediaType,
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(bytes.length, attachment.extensions.fileSize);
    if (attachment.title === "lorem.png")
      assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    if (attachment.title === "lorem.json")
      assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)), {
        lorem: "ipsum",
        count: 3,
        visible: true,
      });
    if (attachment.title === "lorem.csv")
      assert.match(new TextDecoder().decode(bytes), /lorem,ipsum/);
    if (attachment.title === "lorem.pdf") assert.match(new TextDecoder().decode(bytes), /^%PDF-/);
  }
  const comments = (await json("/rest/api/content/1700/comment?expand=body.view,version")).data
    .results;
  assert.ok(comments.length > 0);
  assert.match(comments[0].body.view.value, /Lorem comment/);
  assert.match(comments[0].version.by.displayName, /Lorem/);
  assert.equal((await json(`/rest/api/content/${comments[0].id}/child/attachment`)).status, 200);
  const inline = (await json("/rest/inlinecomments/1.0/comments?containerId=1700")).data;
  assert.ok(Array.isArray(inline));
  assert.match(inline[0].originalSelection, /Lorem/);
  assert.ok(
    (await json(`/rest/inlinecomments/1.0/comments/${inline[0].id}/replies`)).data.length > 0,
  );
  const history = (await json("/rest/api/content/1700/version?limit=50")).data.results;
  assert.equal(history.length, 1);
  assert.equal(history[0].number, 1);
  assert.match(history[0].by.displayName, /Lorem/);
});

test("conversion transforms supplied edits without writing published, draft or revision state", async (t) => {
  const { json, page } = await fixture(t);
  const before = await page("1000");
  const editor = await json("/rest/api/contentbody/convert/editor", "POST", {
    value: before.published.storage,
    representation: "storage",
    content: { id: "1000" },
  });
  assert.equal(editor.status, 200);
  assert.equal(editor.data.representation, "editor");
  const edited = editor.data.value.replace("Lorem sandbox overview", "Lorem edited overview");
  assert.notEqual(edited, editor.data.value);
  const storage = await json("/rest/api/contentbody/convert/storage", "POST", {
    value: edited,
    representation: "editor",
    content: { id: "1000" },
  });
  assert.equal(storage.status, 200);
  assert.match(storage.data.value, /Lorem edited overview/);
  assert.ok(storage.data.value.includes('ac:macro-id="lorem-root-note"'));
  assert.deepEqual(await page("1000"), before);
  assert.equal((await json("/rest/api/content/1000/version")).data.results.length, 1);
  const entries = (await json("/sandbox/api/logs")).data.entries;
  const conversions = entries.filter((entry) => entry.kind === "conversion");
  assert.equal(conversions.length, 2);
  assert.ok(conversions.every((entry) => entry.pageId === "1000" && entry.status === 200));
  assert.ok(!entries.some((entry) => ["draft", "publish"].includes(entry.kind)));
});

test("draft save, discard and explicit publish preserve independent bodies and optimistic revisions", async (t) => {
  const { json, page } = await fixture(t);
  const before = await page("1100");
  const draftEditor = before.published.editor.replace(
    "Lorem typography paragraph",
    "Lorem independently saved draft paragraph",
  );
  assert.notEqual(draftEditor, before.published.editor);
  const saved = await json("/sandbox/api/pages/1100/draft", "POST", {
    editor: draftEditor,
    generation: before.generation,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.draft.baseVersion, 1);
  const drafted = await page("1100");
  assert.deepEqual(drafted.published, before.published);
  assert.equal(drafted.page.version, 1);
  assert.equal(drafted.page.hasDraft, true);
  assert.match(drafted.draft.storage, /independently saved draft/);
  assert.equal((await json("/rest/api/content/1100/version")).data.results.length, 1);
  const published = await json(
    "/rest/api/content/1100",
    "PUT",
    publishBody(drafted, drafted.draft.storage),
  );
  assert.equal(published.status, 200);
  assert.equal(published.data.version.number, 2);
  const after = await page("1100");
  assert.equal(after.page.version, 2);
  assert.equal(after.draft, null);
  assert.match(after.published.storage, /independently saved draft/);
  assert.equal((await json("/rest/api/content/1100/version")).data.results.length, 2);
  assert.match(
    (await json("/rest/api/content/1100?version=1")).data.body.storage.value,
    /Lorem typography paragraph/,
  );
  assert.equal((await json("/rest/api/content/1100", "PUT", publishBody(before))).status, 409);
  assert.deepEqual(await page("1100"), after);
  await json("/sandbox/api/pages/1100/draft", "POST", {
    editor: after.published.editor + "<p>Lorem discard me</p>",
    generation: after.generation,
  });
  assert.equal(
    (await json("/sandbox/api/pages/1100/draft", "DELETE", { generation: after.generation }))
      .status,
    200,
  );
  assert.deepEqual(await page("1100"), after);
});

test("a stale editor saved without a previous draft retains its explicit revision base", async (t) => {
  const { json, page } = await fixture(t);
  const original = await page("1100");
  await json("/sandbox/api/pages/1100/scenario", "POST", { scenario: "published-newer" });
  const saved = await json("/sandbox/api/pages/1100/draft", "POST", {
    editor: original.published.editor + "<p>Lorem stale editor</p>",
    generation: original.generation,
    baseVersion: original.page.version,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.draft.baseVersion, original.page.version);
  assert.equal((await page("1100")).draft.baseVersion, original.page.version);
  assert.equal(
    (
      await json("/sandbox/api/pages/1100/draft", "POST", {
        editor: original.published.editor,
        generation: original.generation,
        baseVersion: 999,
      })
    ).status,
    400,
  );
});

test("guard scenarios model newer publication, same-version raw-source changes, independent drafts and conversion loss", async (t) => {
  const { json, page } = await fixture(t);
  const initial = await page("1000");
  const draft = await json("/sandbox/api/pages/1000/scenario", "POST", {
    scenario: "draft-changed",
  });
  assert.equal(draft.data.page.version, 1);
  assert.equal(draft.data.draft.baseVersion, 1);
  assert.notEqual(draft.data.draft.storage, initial.published.storage);
  assert.deepEqual(draft.data.published, initial.published);
  const newer = await json("/sandbox/api/pages/1000/scenario", "POST", {
    scenario: "published-newer",
  });
  assert.equal(newer.data.page.version, 2);
  assert.notEqual(newer.data.published.storage, initial.published.storage);
  assert.equal(newer.data.draft.baseVersion, 1);
  const resaved = await json("/sandbox/api/pages/1000/draft", "POST", {
    editor: newer.data.draft.editor + "<p>Lorem stale draft edit</p>",
    generation: initial.generation,
  });
  assert.equal(
    resaved.data.draft.baseVersion,
    1,
    "saving a stale draft does not silently rebase it",
  );
  assert.equal((await json("/rest/api/content/1000", "PUT", publishBody(initial))).status, 409);
  const sameVersion = await json("/sandbox/api/pages/1000/scenario", "POST", {
    scenario: "published-source-changed",
  });
  assert.equal(sameVersion.data.page.version, 2);
  assert.notEqual(sameVersion.data.published.storage, newer.data.published.storage);
  const loss = await json("/sandbox/api/pages/1000/scenario", "POST", {
    scenario: "conversion-loss",
  });
  const baseline = await json("/rest/api/contentbody/convert/storage", "POST", {
    representation: "editor",
    value: loss.data.published.editor,
    content: { id: "1000" },
  });
  assert.equal(
    baseline.data.value,
    loss.data.published.storage,
    "live baseline still reaches the dedicated conversion-loss guard",
  );
  const lossy = await json("/rest/api/contentbody/convert/storage", "POST", {
    representation: "editor",
    value: loss.data.published.editor + "<p>Lorem loss probe</p>",
    content: { id: "1000" },
  });
  assert.equal(lossy.status, 200);
  assert.ok(!lossy.data.value.includes('ac:macro-id="lorem-root-note"'));
  assert.deepEqual(await page("1000"), loss.data, "loss injection remains conversion-only");
  const normal = await json("/sandbox/api/pages/1000/scenario", "POST", { scenario: "normal" });
  assert.equal(normal.data.scenario, "normal");
  assert.equal(
    normal.data.published.storage,
    loss.data.published.storage,
    "normal clears flag, not edits",
  );
  assert.equal(
    (await json("/sandbox/api/pages/1000/scenario", "POST", { scenario: "invented" })).status,
    400,
  );
});

test("reset restores deterministic catalog and rejects all stale draft/discard/publish writes", async (t) => {
  const { json, page } = await fixture(t);
  const initial = await page("1000");
  await json("/sandbox/api/pages/1000/scenario", "POST", { scenario: "published-newer" });
  await json("/sandbox/api/pages/1000/scenario", "POST", { scenario: "draft-changed" });
  assert.equal((await json("/sandbox/api/reset", "POST", { confirm: "wrong" })).status, 400);
  const reset = await json("/sandbox/api/reset", "POST", { confirm: "reset-lorem" });
  assert.equal(reset.data.generation, 2);
  const restored = await page("1000");
  assert.deepEqual(restored.published, initial.published);
  assert.equal(restored.draft, null);
  assert.equal(restored.page.version, 1);
  assert.equal(restored.scenario, "normal");
  assert.equal(
    (
      await json("/sandbox/api/pages/1000/draft", "POST", {
        editor: initial.published.editor,
        generation: 1,
      })
    ).status,
    409,
  );
  assert.equal(
    (await json("/sandbox/api/pages/1000/draft", "DELETE", { generation: 1 })).status,
    409,
  );
  assert.equal((await json("/rest/api/content/1000", "PUT", publishBody(initial))).status, 409);
  assert.deepEqual(await page("1000"), restored);
});

test("request logs are bounded, ordered, clipped, and omit credentials and rejected request source", async (t) => {
  const { json, origin } = await fixture(t, { logLimit: 6, logBodyLimit: 160 });
  for (let index = 0; index < 9; index += 1) await json("/health");
  const value = `<p>${"Lorem ipsum ".repeat(100)}</p>`;
  await json(
    "/rest/api/contentbody/convert/editor",
    "POST",
    { value, representation: "storage", content: { id: "1000" } },
    { Authorization: "Bearer NEVER_LOG_LOREM", Cookie: "secret=NEVER_LOG_COOKIE" },
  );
  await fetch(origin + "/sandbox/api/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://foreign.invalid" },
    body: JSON.stringify({ confirm: "NEVER_LOG_REJECTED_BODY" }),
  });
  const entries = (await json("/sandbox/api/logs")).data.entries;
  assert.ok(entries.length <= 6);
  assert.ok(entries.every((entry, index) => index === 0 || entry.seq > entries[index - 1].seq));
  const conversion = entries.find((entry) => entry.kind === "conversion");
  assert.equal(conversion.truncated, true);
  assert.match(conversion.request, /truncated/);
  const serialized = JSON.stringify(entries);
  for (const secret of [
    "NEVER_LOG_LOREM",
    "NEVER_LOG_COOKIE",
    "NEVER_LOG_REJECTED_BODY",
    "authorization",
    "cookie",
    "stack",
  ])
    assert.ok(!serialized.toLowerCase().includes(secret.toLowerCase()));
});

test("loopback Host and same-origin/extension JSON write policy reject foreign web traffic", async (t) => {
  const { origin, json, page } = await fixture(t);
  const before = await page();
  assert.equal((await raw(origin, "/health", { Host: "foreign.invalid" })).status, 403);
  assert.equal((await raw(origin, "/health", { Host: "127.0.0.1.foreign.invalid" })).status, 403);
  const payload = { value: "<p>Lorem</p>", representation: "storage", content: { id: "1000" } };
  for (const Origin of ["https://foreign.invalid", "null", "http://localhost:1"])
    assert.equal(
      (await json("/rest/api/contentbody/convert/editor", "POST", payload, { Origin })).status,
      403,
    );
  for (const Origin of [
    origin,
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    "moz-extension://00000000-0000-0000-0000-000000000000",
  ])
    assert.equal(
      (await json("/rest/api/contentbody/convert/editor", "POST", payload, { Origin })).status,
      200,
    );
  assert.equal(
    (
      await fetch(origin + "/sandbox/api/reset", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: '{"confirm":"reset-lorem"}',
      })
    ).status,
    415,
  );
  assert.deepEqual(await page(), before);
});

test("path traversal, unknown assets, oversized and unsafe conversion/publish requests fail without state changes", async (t) => {
  const { origin, json, page } = await fixture(t);
  const before = await page();
  for (const path of [
    "/sandbox/%2e%2e/server.mjs",
    "/vendor/tinymce/%2e%2e/%2e%2e/package.json",
    "/download/attachments/1700/%2e%2e%2fserver.mjs",
    "/sandbox/assets/no-file.png",
    "/vendor/tinymce/no-file.js",
  ])
    assert.ok([400, 404].includes((await raw(origin, path)).status), path);
  assert.equal(
    (
      await fetch(origin + "/rest/api/contentbody/convert/editor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      })
    ).status,
    400,
  );
  const oversized = await json("/rest/api/contentbody/convert/editor", "POST", {
    value: "x".repeat(2 * 1024 * 1024 + 1),
    representation: "storage",
    content: { id: "1000" },
  });
  assert.equal(oversized.status, 413);
  for (const storage of [
    '<p onclick="alert(1)">Lorem</p>',
    '<p><a href="javascript:alert(1)">Lorem</a></p>',
    "<p><video>ipsum</video></p>",
  ]) {
    assert.equal(
      (
        await json("/rest/api/contentbody/convert/editor", "POST", {
          value: storage,
          representation: "storage",
          content: { id: "1000" },
        })
      ).status,
      422,
    );
    assert.equal(
      (await json("/rest/api/content/1000", "PUT", publishBody(before, storage))).status,
      422,
    );
  }
  assert.equal(
    (
      await json("/rest/api/contentbody/convert/storage", "POST", {
        value: "<p>Lorem</p>",
        representation: "storage",
        content: { id: "1000" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await json("/rest/api/contentbody/convert/editor", "POST", {
        value: "<p>Lorem</p>",
        representation: "storage",
        content: { id: "9999" },
      })
    ).status,
    404,
  );
  assert.equal((await json("/rest/api/content", "POST", { title: "Lorem" })).status, 405);
  assert.deepEqual(await page(), before);
});

test("read-only Jira search paginates the bounded local project and rejects unsupported JQL", async (t) => {
  const { json } = await fixture(t);
  const query = encodeURIComponent("project = LOR ORDER BY key ASC");
  const pages = [];
  for (const startAt of [0, 1, 2, 3]) {
    const { status, data } = await json(
      `/rest/api/2/search?jql=${query}&startAt=${startAt}&maxResults=1`,
    );
    assert.equal(status, 200);
    assert.equal(data.startAt, startAt);
    assert.equal(data.maxResults, 1);
    assert.equal(data.total, 3);
    pages.push(data.issues.map((issue) => issue.key));
  }
  assert.deepEqual(pages, [["LOR-12"], ["LOR-13"], ["LOR-14"], []]);
  assert.equal(
    (await json("/rest/api/2/search?jql=" + encodeURIComponent("project = OTHER OR project = LOR"))).status,
    400,
  );
  assert.equal((await json(`/rest/api/2/search?jql=${query}&startAt=-1`)).status, 400);
  assert.equal((await json(`/rest/api/2/search?jql=${query}&maxResults=0`)).status, 400);
});

test("Jira fixtures have loopback resources and reject issue, comment and attachment writes", async (t) => {
  const { origin, json } = await fixture(t);
  const { status, data: issue } = await json("/rest/api/2/issue/LOR-12");
  assert.equal(status, 200);
  const resource = issue.fields.attachment[0];
  assert.equal(new URL(resource.content).origin, origin);
  const download = await fetch(resource.content);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), resource.mimeType);
  assert.equal((await download.arrayBuffer()).byteLength, resource.size);
  assert.equal((await json("/rest/api/2/issue/LOR-999")).status, 404);
  for (const route of [
    "/rest/api/2/issue/LOR-12",
    "/rest/api/2/issue/LOR-12/comment",
    "/rest/api/2/issue/LOR-12/attachments",
  ]) {
    for (const method of ["POST", "PUT", "DELETE"])
      assert.equal((await json(route, method, {})).status, 405);
  }
  assert.deepEqual((await json("/rest/api/2/issue/LOR-12")).data, issue);
});
