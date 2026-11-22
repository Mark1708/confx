import { readFile } from "node:fs/promises";
import { test, expect } from "./fixtures.mjs";
import { LOCAL_ORIGIN } from "./origin.mjs";
import {
  expectLocalMarkdownTargets,
  expectReadOnlyConversions,
  readDownloadedArchive,
  readZipArchive,
} from "./artifacts.mjs";

const JQL = "project = LOR ORDER BY key ASC";
const JIRA_KEYS = ["LOR-12", "LOR-13", "LOR-14"];

async function openJira(lab) {
  await lab.wiki.page.goto(`${LOCAL_ORIGIN}/browse/LOR-12`);
  await expect(
    lab.wiki.page.getByRole("heading", { name: "Lorem resources", exact: true }),
  ).toBeVisible();
  await lab.confx.targetWiki();
  await lab.confx.selectScope("Issue");
  await lab.confx.selectDestination("Download ZIP");
  await expect(lab.confx.startButton).toBeEnabled();
  return { url: lab.wiki.page.url(), html: await lab.wiki.page.locator("main").innerHTML() };
}

async function readJiraSources(lab, keys) {
  return Promise.all(
    keys.map(async (key) => {
      const raw = await lab.json(`/rest/api/2/issue/${key}`);
      const comments = await lab.json(`/rest/api/2/issue/${key}/comment`);
      const assets = [];
      for (const attachment of raw.fields.attachment) {
        expect(new URL(attachment.content).origin).toBe(LOCAL_ORIGIN);
        const response = await lab.context.request.get(attachment.content);
        expect(response.status()).toBe(200);
        assets.push({ filename: attachment.filename, bytes: await response.body() });
      }
      return { raw, comments, assets };
    }),
  );
}

function expectJiraIssue(actual, source, markdown) {
  const { raw, comments } = source;
  const { fields } = raw;
  expect(actual).toEqual({
    key: raw.key,
    project: fields.project.key,
    type: fields.issuetype.name,
    status: fields.status.name,
    priority: fields.priority.name,
    resolution: fields.resolution?.name ?? null,
    summary: fields.summary,
    assignee: fields.assignee.key,
    reporter: fields.reporter.key,
    labels: fields.labels,
    components: fields.components.map((component) => component.name),
    versions: fields.versions.map((version) => version.name),
    fixVersions: fields.fixVersions.map((version) => version.name),
    epicLink: null,
    created: fields.created,
    updated: fields.updated,
    dueDate: fields.duedate,
    baseUrl: LOCAL_ORIGIN,
    url: `${LOCAL_ORIGIN}/browse/${raw.key}`,
    description: fields.description,
    comments: comments.comments.map((comment) => ({
      id: comment.id,
      author: comment.author.key,
      createdAt: comment.created,
      body: comment.body,
      markdown: comment.body,
    })),
    attachments: fields.attachment.map((attachment) => ({
      id: attachment.id,
      fileName: attachment.filename,
      mediaType: attachment.mimeType,
      fileSize: attachment.size,
      contentUrl: attachment.content,
    })),
  });
  expect(markdown).toContain(`# ${raw.key} — ${fields.summary}`);
  expect(markdown).toContain(`key: ${raw.key}\nproject: LOR`);
  expect(markdown).toContain(`## Description\n\n${fields.description}`);
  for (const comment of comments.comments) {
    expect(markdown).toContain(`**${comment.author.key}**`);
    expect(markdown).toContain(comment.body);
  }
}

function expectJiraAssets(archive, sources, search) {
  const paths = [];
  for (const source of sources) {
    for (const asset of source.assets) {
      const path = `attachments/${search ? `${source.raw.key}/` : ""}${asset.filename}`;
      expect(Buffer.from(archive.entries[archive.root + path]), path).toEqual(asset.bytes);
      expect(JSON.parse(archive.text(path))).toEqual({ lorem: "ipsum", count: 3, visible: true });
      paths.push(path);
    }
  }
  expect(paths).toHaveLength(1);
  // Jira retains online contentUrl metadata; its fixture description has no attachment link.
  expectLocalMarkdownTargets(archive, ["index.md"]);
  return paths;
}

async function expectJiraUnchanged(lab, sourcePage, sources, cursor) {
  expect(lab.wiki.page.url()).toBe(sourcePage.url);
  expect(await lab.wiki.page.locator("main").innerHTML()).toBe(sourcePage.html);
  expect(await readJiraSources(lab, sources.map((source) => source.raw.key))).toEqual(sources);
  expect(
    (await lab.logsAfter(cursor)).filter((entry) => !["GET", "HEAD"].includes(entry.method)),
    "Read-only Jira export must not attempt source/backend writes",
  ).toEqual([]);
}

test("real Jira issue UI export downloads canonical Markdown, JSON and byte-exact attachments without writes", async ({
  lab,
}) => {
  const sourcePage = await openJira(lab);
  const sources = await readJiraSources(lab, ["LOR-12"]);
  expect(sources[0].raw.fields.summary).toBe("Lorem resources");
  const cursor = await lab.cursor();
  const download = await lab.confx.download(() => lab.confx.startButton.click(), ".zip");
  const archive = readZipArchive(await readFile(download.path));
  expect(archive.root).toBe("LOR-12/");
  const markdown = archive.text("index.md");
  expectJiraIssue(JSON.parse(archive.text("issue.json")), sources[0], markdown);
  expect(markdown).toContain("Lorem *ipsum* description.");
  expect(markdown).toContain("|| Lorem key || Lorem value ||");
  expect(markdown).toContain("Lorem comment for the resource specimen.");
  const assets = expectJiraAssets(archive, sources, false);
  // The established issue policy is Markdown + JSON, not a search CSV or editable sidecar.
  expect(Object.keys(archive.entries).sort()).toEqual(
    ["index.md", "issue.json", ...assets].map((path) => archive.root + path).sort(),
  );
  await expect
    .poll(async () => (await readActiveJob(lab.confx.page))?.status, {
      message: "A byte-complete Jira export must finish as a completed job",
    })
    .toBe("completed");
  const issueJob = await readActiveJob(lab.confx.page);
  expect(issueJob.counts.entriesWritten).toBe(Object.keys(archive.entries).length);
  expect(issueJob.result?.fileName).toBe("LOR-12.zip");
  await expectJiraUnchanged(lab, sourcePage, sources, cursor);
});

test("real bounded Jira search UI export preserves all three aggregate records, CSV and written attachments", async ({
  lab,
}) => {
  const sourcePage = await openJira(lab);
  const sources = await readJiraSources(lab, JIRA_KEYS);
  const searchPath = `/rest/api/2/search?${new URLSearchParams({ jql: JQL, maxResults: "50" })}`;
  const before = await lab.json(searchPath);
  expect(before).toMatchObject({ startAt: 0, maxResults: 50, total: 3 });
  expect(before.issues.map((issue) => issue.key)).toEqual(JIRA_KEYS);
  const page = lab.confx.page;
  await lab.confx.selectScope("Search");
  await page.getByRole("textbox", { name: "JQL query", exact: true }).fill(JQL);
  await lab.confx.selectDestination("Download ZIP");
  const extract = lab.confx.startButton;
  await expect(extract).toBeEnabled();
  const cursor = await lab.cursor();
  const searches = [];
  const recordSearch = (request) => {
    const url = new URL(request.url());
    if (url.origin === LOCAL_ORIGIN && url.pathname === "/rest/api/2/search") {
      searches.push({ method: request.method(), url });
    }
  };
  lab.context.on("request", recordSearch);
  let download;
  try {
    download = await lab.confx.download(() => extract.click(), ".zip");
  } finally {
    lab.context.off("request", recordSearch);
  }
  expect(
    searches,
    "The existing Jira search is one request capped at 50, not unbounded pagination",
  ).toHaveLength(1);
  expect(searches[0].method).toBe("GET");
  expect(searches[0].url.searchParams.get("jql")).toBe(JQL);
  expect(searches[0].url.searchParams.get("maxResults")).toBe("50");
  expect(searches[0].url.searchParams.get("startAt") ?? "0").toBe("0");
  const archive = readZipArchive(await readFile(download.path));
  expect(archive.root).toBe("issues/");
  const issues = JSON.parse(archive.text("issues.json"));
  expect(issues.map((issue) => issue.key)).toEqual(JIRA_KEYS);
  const markdown = archive.text("index.md");
  expect(markdown.match(/^# LOR-\d+ — /gm)).toHaveLength(3);
  for (const [index, source] of sources.entries()) expectJiraIssue(issues[index], source, markdown);
  expect(markdown).toContain("Lorem second issue with an independent plain-text paragraph.");
  expect(markdown).toContain("const lorem = 42;");
  const csv = archive
    .text("issues.csv")
    .trimEnd()
    .split(/\r?\n/)
    .map((row) => row.split(","));
  expect(csv).toEqual([
    [
      "key",
      "project",
      "type",
      "status",
      "priority",
      "resolution",
      "assignee",
      "reporter",
      "epic",
      "created",
      "updated",
    ],
    ...sources.map(({ raw }) => [
      raw.key,
      "LOR",
      "Task",
      raw.fields.status.name,
      "Medium",
      raw.fields.resolution?.name ?? "",
      "lorem-assignee",
      "lorem-reporter",
      "",
      raw.fields.created,
      raw.fields.updated,
    ]),
  ]);
  const assets = expectJiraAssets(archive, sources, true);
  expect(Object.keys(archive.entries).sort()).toEqual(
    ["index.md", "issues.json", "issues.csv", ...assets].map((path) => archive.root + path).sort(),
  );
  await expect
    .poll(async () => (await readActiveJob(page))?.status, {
      message: "A byte-complete search export must finish as a completed job",
    })
    .toBe("completed");
  const searchJob = await readActiveJob(page);
  expect(searchJob.counts.entriesWritten).toBe(Object.keys(archive.entries).length);
  expect(searchJob.result?.fileName).toBe("jira-search.zip");
  expect(await lab.json(searchPath)).toEqual(before);
  await expectJiraUnchanged(lab, sourcePage, sources, cursor);
});

async function readActiveJob(page) {
  return page.evaluate(async () => {
    const activeKey = "cx.export.active.v2";
    const id = (await chrome.storage.session.get(activeKey))[activeKey];
    if (typeof id !== "string") return null;
    const key = `cx.exportJob.v2:${id}`;
    const value = (await chrome.storage.session.get(key))[key];
    return typeof value === "string" ? JSON.parse(value) : null;
  });
}

test("a later subtree source failure after real root writes is fatal and never hands a ZIP to Chrome downloads", async ({
  lab,
}) => {
  const owner = lab.confx.page;
  await owner.evaluate(async () => {
    const key = "cx.settings.v1";
    const settings = (await chrome.storage.sync.get(key))[key];
    await chrome.storage.sync.set({ [key]: { ...settings, maxRetries: 0 } });
  });
  // Reload to consume the real stored network setting before preparing this run.
  await owner.reload();
  await lab.wiki.open("1000");
  await lab.confx.selectSubtreeRoot("1000");
  await lab.confx.selectDestination("Download ZIP");
  const extract = lab.confx.startButton;
  await expect(extract).toBeEnabled();
  const initial = await lab.snapshot();
  const cursor = await lab.cursor();
  const releaseFailure = Promise.withResolvers();
  const rootDeliveries = [];
  const deliveryErrors = [];
  const pendingDeliveries = [];
  const childFailures = [];
  const routeErrors = [];
  const pendingRoutes = new Set();
  let heldChild = false;
  const isBodyView = (request, pageId) => {
    const url = new URL(request.url());
    return (
      request.method() === "GET" &&
      url.origin === LOCAL_ORIGIN &&
      url.pathname === `/rest/api/content/${pageId}` &&
      (url.searchParams.get("expand") ?? "").split(",").includes("body.view")
    );
  };
  const recordRoot = (response) => {
    if (!isBodyView(response.request(), "1000")) return;
    pendingDeliveries.push(
      response.json().then(
        (body) => rootDeliveries.push({ status: response.status(), body }),
        (error) => deliveryErrors.push(error.message),
      ),
    );
  };
  const routeRead = (route) => {
    const task = (async () => {
      if (!isBodyView(route.request(), "1100")) {
        await route.fallback();
        return;
      }
      heldChild = true;
      await releaseFailure.promise;
      childFailures.push({ url: route.request().url(), rootDeliveries: rootDeliveries.length });
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "Lorem later page source unavailable" }),
      });
    })().catch((error) => routeErrors.push(error.message));
    pendingRoutes.add(task);
    void task.finally(() => pendingRoutes.delete(task));
    return task;
  };
  const beforeDownloads = await owner.evaluate(async () => {
    const created = [];
    const changed = [];
    const onCreated = (item) =>
      created.push({ id: item.id, filename: item.filename, state: item.state });
    const onChanged = (delta) => changed.push(delta);
    globalThis.__confxStage7Downloads = { created, changed, onCreated, onChanged };
    chrome.downloads.onCreated.addListener(onCreated);
    chrome.downloads.onChanged.addListener(onChanged);
    return (await chrome.downloads.search({})).map((item) => item.id);
  });
  owner.on("response", recordRoot);
  const routePattern = "**/rest/api/content/**";
  let rootWritten;
  let terminal;
  let downloadObservation;
  try {
    expect(beforeDownloads).toEqual([]);
    await owner.route(routePattern, routeRead);
    await extract.click();
    await expect
      .poll(() => heldChild, { message: "Discovery must reach the later child source" })
      .toBe(true);
    await expect
      .poll(() => rootDeliveries.length, {
        message: "The real root body must be delivered before failing its child",
      })
      .toBe(1);
    expect(rootDeliveries[0].status).toBe(200);
    expect(rootDeliveries[0].body.id).toBe("1000");
    expect(rootDeliveries[0].body.body.view.value).toContain("Lorem sandbox overview");
    expect(rootDeliveries[0].body.body.storage.value).toBe(
      initial.details.find((detail) => detail.page.id === "1000").published.storage,
    );
    await expect
      .poll(
        async () => {
          rootWritten = await readActiveJob(owner);
          return rootWritten?.counts.successfulPages;
        },
        {
          message:
            "The committed pages must be written before the held last child source fails",
        },
      )
      .toBe(initial.state.pages.length - 1);
    expect(rootWritten.status).toBe("running");
    expect(rootWritten.counts.processed).toBe(initial.state.pages.length - 1);
    expect(rootWritten.counts.entriesWritten).toBeGreaterThanOrEqual(2);
    expect(rootWritten.counts.bytesWritten).toBeGreaterThan(0);
    releaseFailure.resolve();
    await expect(owner.getByText("Export did not finish", { exact: true })).toBeVisible();
    await expect(
      owner.getByRole("alert").filter({ hasText: "Export did not finish" })
        .getByText("Failed to export page 1100", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(async () => {
        terminal = await readActiveJob(owner);
        return terminal?.status;
      })
      .toBe("failed");
    await expect
      .poll(() =>
        owner.evaluate(async () =>
          (await navigator.locks.query()).held.some((lock) => lock.name === "cx.export.v2"),
        ),
      )
      .toBe(false);
    await expect(owner.getByText("Export ready", { exact: true })).toHaveCount(0);
    await expect(owner.getByText("Export is incomplete", { exact: true })).toHaveCount(0);
    await expect(owner.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
    await expect(extract).toBeEnabled();
    expect(
      childFailures,
      "maxRetries=0 still preserves the two subtree source attempts",
    ).toHaveLength(2);
    expect(childFailures.every((failure) => failure.rootDeliveries === 1)).toBe(true);
    expect(rootDeliveries).toHaveLength(1);
    expect(terminal.result).toBeUndefined();
    expect(terminal.counts.successfulPages).toBe(initial.state.pages.length - 1);
    expect(terminal.counts.failedPages).toBe(1);
    expect(terminal.counts.entriesWritten).toBe(rootWritten.counts.entriesWritten);
    expect((await lab.snapshot()).details).toEqual(initial.details);
    const logs = await lab.logsAfter(cursor);
    expectReadOnlyConversions(logs);
    expect(logs.filter((entry) => /^(PUT|PATCH|DELETE)$/.test(entry.method))).toEqual([]);
  } finally {
    releaseFailure.resolve();
    try {
      await owner.unroute(routePattern, routeRead);
      await Promise.all([...pendingRoutes]);
    } finally {
      owner.off("response", recordRoot);
      await Promise.all(pendingDeliveries);
      downloadObservation = await owner.evaluate(async () => {
        const observer = globalThis.__confxStage7Downloads;
        chrome.downloads.onCreated.removeListener(observer.onCreated);
        chrome.downloads.onChanged.removeListener(observer.onChanged);
        delete globalThis.__confxStage7Downloads;
        return {
          created: observer.created,
          changed: observer.changed,
          downloads: await chrome.downloads.search({}),
        };
      });
    }
  }
  expect(deliveryErrors).toEqual([]);
  expect(
    routeErrors,
    "Every custom route is handled once, with fallback only for nonmatches",
  ).toEqual([]);
  expect(
    downloadObservation.created,
    "A fatal source failure must not create even a transient Chrome download",
  ).toEqual([]);
  expect(downloadObservation.changed).toEqual([]);
  expect(downloadObservation.downloads.map((item) => item.id)).toEqual(beforeDownloads);
  await lab.testInfo.attach("sequential-source-failure", {
    body: JSON.stringify({ rootWritten, terminal, childFailures, downloadObservation }, null, 2),
    contentType: "application/json",
  });
});

test("the Jira Fragment scope exports the selected rendered block without an issue-body import or source writes", async ({
  lab,
}) => {
  const sourcePage = await openJira(lab);
  const sources = await readJiraSources(lab, ["LOR-12"]);
  const savedDefaults = await lab.confx.page.evaluate(async () =>
    chrome.storage.sync.get("cx.settings.v1"),
  );
  await lab.confx.selectScope("Fragment");
  await lab.confx.selectTemplate("Markdown + attachments");
  for (const name of [
    "Editable Markdown sidecar",
    "File attachments",
    "Page comments",
    "Version history",
  ]) {
    const control = lab.confx.page.getByRole("switch", { name, exact: true });
    await expect(control).toBeVisible();
    await expect(control).toBeDisabled();
    await expect(control).toHaveAttribute("aria-checked", "false");
  }
  const cursor = await lab.cursor();
  await lab.confx.pickFragment(
    lab.wiki.page.locator("main").getByRole("heading", { name: "Lorem resources", exact: true }),
  );
  const archive = await readDownloadedArchive(
    await lab.confx.download(() => lab.confx.startButton.click(), ".zip"),
  );
  expect(archive.manifest).toMatchObject({
    type: "block",
    source: { host: LOCAL_ORIGIN },
    counts: { pages: 1, images: 0, attachments: 0 },
    failures: [],
  });
  expect(archive.manifest.pages[0].editable).toMatchObject({
    status: "unavailable",
    reason: "partial-export",
  });
  expect(archive.text("index.md")).toContain("# Lorem resources");
  expect(archive.text("index.md")).not.toContain(sources[0].raw.fields.description);
  expect(Object.keys(archive.entries).sort()).toEqual(
    ["index.md", "manifest.json"].map((path) => archive.root + path).sort(),
  );
  expect(
    await lab.confx.page.evaluate(async () => chrome.storage.sync.get("cx.settings.v1")),
    "Jira fragments preserve the saved true companion preferences",
  ).toEqual(savedDefaults);
  await expect(lab.confx.sectionTab("Update page")).toBeEnabled();
  await lab.confx.selectSection("Update page");
  await expect(
    lab.confx.page.getByRole("button", { name: "Export editable MD", exact: true }),
  ).toBeDisabled();
  await expect(lab.confx.applyButton).toBeDisabled();
  await expect(lab.confx.page.locator("#editor-markdown")).toBeVisible();
  await expectJiraUnchanged(lab, sourcePage, sources, cursor);
});
