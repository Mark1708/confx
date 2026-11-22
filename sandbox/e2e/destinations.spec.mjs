import { test, expect } from "./fixtures.mjs";
import { LOCAL_ORIGIN } from "./origin.mjs";
import { unzipSync } from "fflate";
import { expectReadOnlyConversions } from "./artifacts.mjs";

// Stage 8 slice C: all three export destinations against the real built
// extension and real Chromium OPFS. Only the native picker boundary is
// substituted (the Runtime test seam); production code always handles genuine
// FileSystemDirectoryHandle / FileSystemFileHandle / writable streams.
const MARKER_FILE = ".confx-export.json";
const SUBTREE_PAGE = "1700";
const HELD_CHILD_PAGE = "1710";
const EXPORT_LOCK = "cx.export.v2";
const EXPORTED_AT_LINE = /^exported_at: .+$/gm;
const API_UNAVAILABLE_REASON = "This browser does not provide the File System Access API.";

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

function isPageBodyView(request, pageId) {
  const url = new URL(request.url());
  return (
    request.method() === "GET" &&
    url.origin === LOCAL_ORIGIN &&
    url.pathname === `/rest/api/content/${pageId}` &&
    (url.searchParams.get("expand") ?? "").split(",").includes("body.view")
  );
}

/** Holds one real page body request open; every other matching request falls through. */
async function holdPageSource(owner, pageId) {
  const gate = Promise.withResolvers();
  const pending = new Set();
  const errors = [];
  let held = false;
  const abortedRequests = new Set();
  const onFailed = (request) => {
    if (isPageBodyView(request, pageId) && /ABORTED/i.test(request.failure()?.errorText ?? "")) {
      abortedRequests.add(request);
    }
  };
  owner.on("requestfailed", onFailed);
  const handler = (route) => {
    const request = route.request();
    const canContinue = () => !owner.isClosed() && !abortedRequests.has(request) && !request.failure();
    const task = (async () => {
      if (!isPageBodyView(request, pageId)) {
        if (canContinue()) await route.fallback();
        return;
      }
      held = true;
      await gate.promise;
      // An aborted fetch no longer has a live route to fall back through.
      if (canContinue()) await route.continue();
    })().catch((error) => {
      if (canContinue()) errors.push(error.message);
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
    return task;
  };
  await owner.route("**/rest/api/content/**", handler);
  return {
    held: () => held,
    aborted: () => abortedRequests.size > 0,
    release: () => gate.resolve(),
    async stop() {
      gate.resolve();
      await Promise.allSettled([...pending]);
      if (!owner.isClosed()) await owner.unroute("**/rest/api/content/**", handler);
      owner.off("requestfailed", onFailed);
      expect(errors, "Every held route resolves exactly once").toEqual([]);
    },
  };
}

async function downloadIds(owner) {
  return owner.evaluate(async () => (await chrome.downloads.search({})).map((item) => item.id));
}

async function lockReleased(owner) {
  return owner.evaluate(
    async (name) => !(await navigator.locks.query()).held.some((lock) => lock.name === name),
    EXPORT_LOCK,
  );
}

async function readMarker(lab, parent, child) {
  const base64 = await lab.opfs.readFileB64(parent, `${child}/${MARKER_FILE}`);
  if (base64 === null) return null;
  return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
}

async function onlyChildEntry(lab, parent, kind) {
  const children = await lab.opfs.listChildren(parent);
  expect(children, JSON.stringify(children)).toHaveLength(1);
  expect(children[0].kind).toBe(kind);
  return children[0].name;
}

/** Asserts a single content root and returns entries relative to it. */
function rootedEntries(rawNames, getBytes, expectedRoot) {
  const names = [...rawNames];
  expect(names.length, "A real export package has entries").toBeGreaterThan(0);
  const roots = [...new Set(names.map((name) => name.split("/")[0]))];
  expect(roots, "A real export package has one content root").toHaveLength(1);
  if (expectedRoot !== undefined) {
    expect(roots[0], "Strip only the chosen outer package directory").toBe(expectedRoot);
  }
  const prefix = `${roots[0]}/`;
  const entries = new Map();
  for (const name of names) {
    expect(name.startsWith(prefix), `${name} lives under the package root`).toBe(true);
    entries.set(name.slice(prefix.length), Buffer.from(getBytes(name)));
  }
  return entries;
}

function zipEntries(archive) {
  return rootedEntries(Object.keys(archive.entries), (name) => archive.entries[name]);
}

function directoryEntries(files, child) {
  const prefix = `${child}/`;
  return rootedEntries(
    files.filter((file) => file.path !== `${prefix}${MARKER_FILE}`).map((file) => file.path),
    (path) => Buffer.from(files.find((file) => file.path === path).b64, "base64"),
    child,
  );
}

function comparableText(buffer) {
  return buffer.toString("utf8").replace(EXPORTED_AT_LINE, "exported_at: <normalized>");
}

function comparableManifest(buffer) {
  const parsed = JSON.parse(buffer.toString("utf8"));
  delete parsed.exported_at;
  return parsed;
}

/** Two real packages of the same source: identical members, bytes equal except run timestamps. */
function expectPackagesEqual(actual, expected, label) {
  expect([...actual.keys()].sort(), `${label}: member names`).toEqual([...expected.keys()].sort());
  for (const path of expected.keys()) {
    const left = actual.get(path);
    const right = expected.get(path);
    expect(Buffer.isBuffer(left) && Buffer.isBuffer(right), `${label}: ${path} is binary`).toBe(
      true,
    );
    if (path === "manifest.json") {
      expect(comparableManifest(left), `${label}: ${path}`).toEqual(comparableManifest(right));
      continue;
    }
    if (path.endsWith(".md")) {
      expect(comparableText(left), `${label}: ${path}`).toBe(comparableText(right));
      continue;
    }
    expect(left.equals(right), `${label}: ${path} bytes`).toBe(true);
  }
}

function treeStats(files, child) {
  const content = files.filter((file) => file.path !== `${child}/${MARKER_FILE}`);
  return {
    entries: content.length,
    bytes: content.reduce((total, file) => total + file.size, 0),
  };
}

async function exportStartButton(owner) {
  const start = owner.locator("[data-export-start]");
  await expect(start).toHaveText("Start export");
  await expect(start).toBeEnabled();
  return start;
}

test("a real subtree exported to a new OPFS folder equals the download ZIP package and completes its marker", async ({
  lab,
}) => {
  const owner = lab.confx.page;
  await lab.wiki.open(SUBTREE_PAGE);
  await lab.confx.selectSubtreeRoot(SUBTREE_PAGE);
  const before = await lab.snapshot();
  const reference = await lab.confx.exportSubtree();
  expect(reference.manifest.counts.pages).toBe(2);

  const parent = "confx-dest-directory";
  await lab.opfs.resetParent(parent);
  await lab.confx.installExportPickers(parent);
  await lab.confx.selectDestination("New folder");
  await lab.confx.selectSubtreeRoot(SUBTREE_PAGE);
  const extract = await exportStartButton(owner);
  const downloadsBefore = await downloadIds(owner);
  const cursor = await lab.cursor();
  const hold = await holdPageSource(owner, HELD_CHILD_PAGE);
  let child = null;
  let runningMarker = null;
  try {
    await extract.click();
    await expect
      .poll(() => hold.held(), { message: "Discovery must reach the held child source" })
      .toBe(true);
    child = await onlyChildEntry(lab, parent, "directory");
    await expect
      .poll(
        async () => {
          runningMarker = await readMarker(lab, parent, child);
          const job = await readActiveJob(owner);
          return (
            runningMarker?.status === "running" &&
            runningMarker?.counts?.entriesWritten >= 1 &&
            job?.status === "running"
          );
        },
        { message: "The folder marker must be running with confirmed writes before the tail" },
      )
      .toBe(true);
    const runningJob = await readActiveJob(owner);
    expect(runningMarker).toMatchObject({ schema: 1, jobId: runningJob.id, status: "running" });
    expect(child).toBe(`${reference.root.slice(0, -1)}-${runningJob.id}`);
    expect(runningMarker.counts.bytesWritten).toBeGreaterThan(0);
    expect(runningMarker.unexportedPageId).toBeUndefined();
    hold.release();
    await expect
      .poll(
        async () => {
          const job = await readActiveJob(owner);
          return job?.status === "completed" && job?.result?.directoryName === child
            ? "completed"
            : "waiting";
        },
        { message: "The folder export must finish with its directory receipt", timeout: 45_000 },
      )
      .toBe("completed");
  } finally {
    await hold.stop();
  }
  const completedCard = owner.getByRole("status").filter({ hasText: "Export ready" });
  await expect(completedCard).toBeVisible();
  await expect(completedCard.getByText(`Folder: ${child}`, { exact: true })).toBeVisible();

  const terminal = await readActiveJob(owner);
  expect(terminal.status).toBe("completed");
  const files = await lab.opfs.snapshot(parent);
  expectPackagesEqual(directoryEntries(files, child), zipEntries(reference), "directory");
  const stats = treeStats(files, child);
  const completedMarker = await readMarker(lab, parent, child);
  expect(completedMarker).toMatchObject({
    schema: 1,
    jobId: terminal.id,
    status: "completed",
  });
  expect(completedMarker.counts).toEqual({
    entriesWritten: stats.entries,
    bytesWritten: stats.bytes,
  });
  expect(completedMarker.counts.entriesWritten).toBe(Object.keys(reference.entries).length);
  expect(completedMarker.unexportedPageId).toBeUndefined();
  await expect
    .poll(() => lockReleased(owner), { message: "The export lock must be released" })
    .toBe(true);
  expect(await downloadIds(owner), "The folder destination never downloads").toEqual(
    downloadsBefore,
  );
  expect((await lab.snapshot()).details).toEqual(before.details);
  expectReadOnlyConversions(await lab.logsAfter(cursor));
  await lab.testInfo.attach("directory-destination", {
    body: JSON.stringify({ child, runningMarker, completedMarker, terminal }, null, 2),
    contentType: "application/json",
  });
});

test("a streamed ZIP creates a unique OPFS archive equal to the download package even without the Save File API", async ({
  lab,
}) => {
  const owner = lab.confx.page;
  await lab.wiki.open(SUBTREE_PAGE);
  await lab.confx.selectSubtreeRoot(SUBTREE_PAGE);
  const before = await lab.snapshot();
  const reference = await lab.confx.exportSubtree();
  expect(reference.manifest.counts.pages).toBe(2);

  await owner.addInitScript(() => {
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
  });
  await owner.reload();
  await lab.confx.targetWiki();
  expect(await owner.evaluate(() => typeof window.showDirectoryPicker)).toBe("function");
  expect(await owner.evaluate(() => typeof window.showSaveFilePicker)).toBe("undefined");
  await expect(lab.confx.destinationControl("New folder")).toBeEnabled();
  await expect(lab.confx.destinationControl("ZIP to disk")).toBeEnabled();

  const parent = "confx-dest-streamed";
  await lab.opfs.resetParent(parent);
  const priorName = "lorem-keep.txt";
  const sentinel = Buffer.from("lorem unrelated existing file must not change");
  await lab.opfs.ensureFile(parent, priorName, sentinel.toString("base64"));
  const filesBefore = await lab.opfs.snapshot(parent);
  await lab.confx.installExportPickers(parent);
  await lab.confx.selectDestination("ZIP to disk");
  await lab.confx.selectSubtreeRoot(SUBTREE_PAGE);
  const extract = await exportStartButton(owner);
  const downloadsBefore = await downloadIds(owner);
  const cursor = await lab.cursor();

  await extract.click();
  await expect
    .poll(
      async () => {
        const job = await readActiveJob(owner);
        return job?.status === "completed" && job?.result?.downloadId === undefined
          ? "completed"
          : "waiting";
      },
      { message: "The streamed export must finish without a download receipt", timeout: 45_000 },
    )
    .toBe("completed");
  const completedCard = owner.getByRole("status").filter({ hasText: "Export ready" });
  await expect(completedCard).toBeVisible();
  await expect(completedCard.getByText(/^File: .+\.zip$/, { exact: true })).toBeVisible();

  const terminal = await readActiveJob(owner);
  expect(terminal.status).toBe("completed");
  const prepared = await lab.confx.lastPrepared();
  expect(prepared).toMatchObject({
    id: terminal.id,
    rootName: `subtree-${SUBTREE_PAGE}`,
    destination: "streamed-zip",
  });
  const actualRoot = reference.root.slice(0, -1);
  expect(actualRoot, "The source package root differs from the preparation hint").not.toBe(
    prepared.rootName,
  );
  const savedName = `${actualRoot}-${terminal.id}.zip`;
  expect(terminal.result.fileName, "The receipt names the new actual-root/UUID ZIP").toBe(
    savedName,
  );
  expect(terminal.result.directoryName).toBeUndefined();
  const children = await lab.opfs.listChildren(parent);
  expect(children).toHaveLength(2);
  expect(children).toEqual(
    expect.arrayContaining([
      { name: priorName, kind: "file" },
      { name: savedName, kind: "file" },
    ]),
  );
  const filesAfter = await lab.opfs.snapshot(parent);
  expect(
    filesAfter.filter((file) => file.path !== savedName),
    "Creating the unique ZIP never changes another existing file",
  ).toEqual(filesBefore);

  const base64 = await lab.opfs.readFileB64(parent, savedName);
  expect(base64, "The streamed OPFS file exists after close").not.toBeNull();
  const bytes = Buffer.from(base64, "base64");
  expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const streamed = unzipSync(new Uint8Array(bytes));
  expectPackagesEqual(
    rootedEntries(Object.keys(streamed), (name) => streamed[name]),
    zipEntries(reference),
    "streamed",
  );
  await expect
    .poll(() => lockReleased(owner), { message: "The export lock must be released" })
    .toBe(true);
  expect(await downloadIds(owner), "The disk ZIP destination never downloads").toEqual(
    downloadsBefore,
  );
  expect((await lab.snapshot()).details).toEqual(before.details);
  expectReadOnlyConversions(await lab.logsAfter(cursor));
  await lab.testInfo.attach("streamed-destination", {
    body: JSON.stringify({ savedName, terminal }, null, 2),
    contentType: "application/json",
  });
});

test("cancelling a folder export between pages stops every write and marks the folder cancelled", async ({
  lab,
}) => {
  const owner = lab.confx.page;
  await lab.wiki.open(SUBTREE_PAGE);
  const before = await lab.snapshot();
  const parent = "confx-dest-cancel-directory";
  await lab.opfs.resetParent(parent);
  await lab.confx.installExportPickers(parent);
  await lab.confx.selectDestination("New folder");
  await lab.confx.selectSubtreeRoot(SUBTREE_PAGE);
  const extract = await exportStartButton(owner);
  const downloadsBefore = await downloadIds(owner);
  const cursor = await lab.cursor();
  const hold = await holdPageSource(owner, HELD_CHILD_PAGE);
  let child = null;
  try {
    await extract.click();
    await expect
      .poll(() => hold.held(), { message: "The root page must be written before the tail" })
      .toBe(true);
    child = await onlyChildEntry(lab, parent, "directory");
    await expect
      .poll(
        async () => (await readMarker(lab, parent, child))?.counts?.entriesWritten >= 1,
        { message: "Confirmed writes exist before cancellation" },
      )
      .toBe(true);
    await owner.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(owner.getByText("Export cancelled", { exact: true })).toBeVisible({
      timeout: 45_000,
    });
    await expect
      .poll(
        async () => (await readMarker(lab, parent, child))?.status,
        { message: "The marker must reach its terminal cancelled state" },
      )
      .toBe("cancelled");
    await expect.poll(hold.aborted, { message: "Cancellation must abort the held real source read" }).toBe(true);
    hold.release();
  } finally {
    await hold.stop();
  }

  const filesAtCancel = await lab.opfs.snapshot(parent);
  await owner.waitForTimeout(750);
  const filesLater = await lab.opfs.snapshot(parent);
  expect(filesLater, "No file may be written after cancellation").toEqual(filesAtCancel);
  const cancelledMarker = await readMarker(lab, parent, child);
  const stats = treeStats(filesAtCancel, child);
  expect(cancelledMarker).toMatchObject({ schema: 1, status: "cancelled" });
  expect(cancelledMarker.counts.entriesWritten).toBe(stats.entries);
  expect(cancelledMarker.counts.bytesWritten).toBe(stats.bytes);
  expect(cancelledMarker.unexportedPageId).toBeUndefined();
  const terminal = await readActiveJob(owner);
  expect(terminal.status).toBe("cancelled");
  expect(terminal.result).toBeUndefined();
  await expect
    .poll(() => lockReleased(owner), { message: "The export lock must be released" })
    .toBe(true);
  await exportStartButton(owner);
  expect(await downloadIds(owner), "A cancelled folder export never downloads").toEqual(
    downloadsBefore,
  );
  expect((await lab.snapshot()).details).toEqual(before.details);
  expectReadOnlyConversions(await lab.logsAfter(cursor));
  await lab.testInfo.attach("directory-cancel", {
    body: JSON.stringify({ child, cancelledMarker, terminal }, null, 2),
    contentType: "application/json",
  });
});

test("cancelling a streamed export between pages aborts its new ZIP without touching other files or writing late bytes", async ({
  lab,
}) => {
  const owner = lab.confx.page;
  await lab.wiki.open(SUBTREE_PAGE);
  await lab.confx.selectSubtreeRoot(SUBTREE_PAGE);
  const before = await lab.snapshot();
  const reference = await lab.confx.exportSubtree();
  expect(reference.manifest.counts.pages).toBe(2);
  const parent = "confx-dest-cancel-streamed";
  const priorName = "lorem-existing-archive.zip";
  const sentinel = Buffer.concat([
    Buffer.from("confx-e2e prior file content lorem "),
    Buffer.alloc(2048, 0x6c),
  ]);
  await lab.opfs.resetParent(parent);
  await lab.opfs.ensureFile(parent, priorName, sentinel.toString("base64"));
  const filesBefore = await lab.opfs.snapshot(parent);
  await lab.confx.installExportPickers(parent);
  await lab.confx.selectDestination("ZIP to disk");
  await lab.confx.selectSubtreeRoot(SUBTREE_PAGE);
  const extract = await exportStartButton(owner);
  const downloadsBefore = await downloadIds(owner);
  const cursor = await lab.cursor();
  const hold = await holdPageSource(owner, HELD_CHILD_PAGE);
  let createdName = null;
  let filesAtCancel = null;
  try {
    await extract.click();
    await expect
      .poll(() => hold.held(), { message: "The root page must be written before the tail" })
      .toBe(true);
    await expect
      .poll(
        async () => {
          const job = await readActiveJob(owner);
          return job?.status === "running" && job?.counts?.entriesWritten >= 1;
        },
        { message: "The stream must carry real entries before cancellation" },
      )
      .toBe(true);
    const running = await readActiveJob(owner);
    const prepared = await lab.confx.lastPrepared();
    expect(prepared).toMatchObject({ id: running.id, destination: "streamed-zip" });
    expect(running.counts.bytesWritten).toBeGreaterThan(0);
    createdName = `${reference.root.slice(0, -1)}-${prepared.id}.zip`;
    const children = await lab.opfs.listChildren(parent);
    expect(children).toEqual(
      expect.arrayContaining([
        { name: priorName, kind: "file" },
        { name: createdName, kind: "file" },
      ]),
    );
    await expect(owner.getByText("Export ready", { exact: true })).toHaveCount(0);
    await owner.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(owner.getByText("Export cancelled", { exact: true })).toBeVisible({
      timeout: 45_000,
    });
    await expect
      .poll(hold.aborted, { message: "Cancellation must abort the held real source read" })
      .toBe(true);
    await expect
      .poll(() => lockReleased(owner), { message: "Writable abort must finish before lock release" })
      .toBe(true);
    filesAtCancel = await lab.opfs.snapshot(parent);
    const incomplete = filesAtCancel.find((file) => file.path === createdName);
    expect(incomplete, "The newly created ZIP is left in place, not removed").toEqual({
      path: createdName,
      size: 0,
      b64: "",
    });
    expect(
      filesAtCancel.filter((file) => file.path !== createdName),
      "Aborting the new writable cannot change another existing file",
    ).toEqual(filesBefore);
    hold.release();
  } finally {
    await hold.stop();
  }

  const terminal = await readActiveJob(owner);
  expect(terminal.status).toBe("cancelled");
  expect(terminal.result).toBeUndefined();
  await expect(owner.getByText("Export ready", { exact: true })).toHaveCount(0);
  await expect(owner.getByText("Export is incomplete", { exact: true })).toHaveCount(0);
  expect(
    await lab.opfs.snapshot(parent),
    "Releasing and settling the aborted tail cannot create files or append late bytes",
  ).toEqual(filesAtCancel);
  await exportStartButton(owner);
  expect(await downloadIds(owner), "A cancelled stream never downloads").toEqual(downloadsBefore);
  expect((await lab.snapshot()).details).toEqual(before.details);
  expectReadOnlyConversions(await lab.logsAfter(cursor));
  await lab.testInfo.attach("streamed-cancel", {
    body: JSON.stringify(
      { createdName, priorName, terminal, sentinelLength: sentinel.length },
      null,
      2,
    ),
    contentType: "application/json",
  });
});

test("a destination collision surfaces an honest error without touching the existing folder", async ({
  lab,
}) => {
  const owner = lab.confx.page;
  await lab.wiki.open(SUBTREE_PAGE);
  await lab.confx.selectSubtreeRoot(SUBTREE_PAGE);
  const before = await lab.snapshot();
  const reference = await lab.confx.exportSubtree();
  expect(reference.manifest.counts.pages).toBe(2);
  const parent = "confx-dest-collision";
  await lab.opfs.resetParent(parent);
  await lab.confx.installExportPickers(parent, { deferDirectory: true });
  await lab.confx.selectDestination("New folder");
  await lab.confx.selectSubtreeRoot(SUBTREE_PAGE);
  const extract = await exportStartButton(owner);
  const downloadsBefore = await downloadIds(owner);
  const cursor = await lab.cursor();
  const sentinel = Buffer.from("lorem pre-existing folder content");

  await extract.click();
  await expect
    .poll(() => lab.confx.lastPrepared(), { message: "The seam reports the prepared export" })
    .not.toBeNull();
  const prepared = await lab.confx.lastPrepared();
  expect(prepared).toMatchObject({
    rootName: `subtree-${SUBTREE_PAGE}`,
    destination: "directory",
  });
  const existingChild = `${reference.root.slice(0, -1)}-${prepared.id}`;
  await lab.opfs.makeChildDir(parent, existingChild);
  await lab.opfs.writeFile(parent, `${existingChild}/lorem-keep.txt`, sentinel.toString("base64"));
  const filesBefore = await lab.opfs.snapshot(parent);
  await lab.confx.resolveDeferredDirectoryPicker();

  await expect(
    owner.getByRole("alert").filter({ hasText: "Export did not finish" }),
  ).toBeVisible({ timeout: 45_000 });
  await expect
    .poll(async () => (await readActiveJob(owner))?.status, {
      message: "The collision must reach a terminal job state",
    })
    .toBe("failed");
  const terminal = await readActiveJob(owner);
  expect(terminal.terminalReason).toBe("destination-collision");
  expect(terminal.result).toBeUndefined();
  expect(terminal.counts.entriesWritten).toBe(0);
  expect(terminal.counts.bytesWritten).toBe(0);
  await expect(owner.getByText("Export ready", { exact: true })).toHaveCount(0);
  await expect
    .poll(() => lockReleased(owner), { message: "The export lock must be released" })
    .toBe(true);

  const children = await lab.opfs.listChildren(parent);
  expect(children).toEqual([{ name: existingChild, kind: "directory" }]);
  expect(
    await lab.opfs.readFileB64(parent, `${existingChild}/${MARKER_FILE}`),
    "The pre-existing folder never receives a marker",
  ).toBeNull();
  const preserved = await lab.opfs.readFileB64(parent, `${existingChild}/lorem-keep.txt`);
  expect(Buffer.from(preserved, "base64").equals(sentinel)).toBe(true);
  expect(await lab.opfs.snapshot(parent), "A collision creates or overwrites no files").toEqual(
    filesBefore,
  );
  await exportStartButton(owner);
  expect(await downloadIds(owner)).toEqual(downloadsBefore);
  expect((await lab.snapshot()).details).toEqual(before.details);
  const logs = await lab.logsAfter(cursor);
  expect(logs.filter((entry) => /^(PUT|PATCH|DELETE)$/.test(entry.method))).toEqual([]);
  await lab.testInfo.attach("destination-collision", {
    body: JSON.stringify({ existingChild, prepared }, null, 2),
    contentType: "application/json",
  });
});

test("an existing actual-root UUID ZIP fails with a collision without overwriting any file", async ({
  lab,
}) => {
  const owner = lab.confx.page;
  await lab.wiki.open(SUBTREE_PAGE);
  await lab.confx.selectSubtreeRoot(SUBTREE_PAGE);
  const before = await lab.snapshot();
  const reference = await lab.confx.exportSubtree();
  expect(reference.manifest.counts.pages).toBe(2);
  const parent = "confx-dest-streamed-collision";
  await lab.opfs.resetParent(parent);
  await lab.confx.installExportPickers(parent, { deferDirectory: true });
  await lab.confx.selectDestination("ZIP to disk");
  await lab.confx.selectSubtreeRoot(SUBTREE_PAGE);
  const extract = await exportStartButton(owner);
  const downloadsBefore = await downloadIds(owner);
  const cursor = await lab.cursor();
  const sentinel = Buffer.from("lorem existing UUID ZIP content must remain byte-exact");

  await extract.click();
  await expect
    .poll(() => lab.confx.lastPrepared(), { message: "Observe the UUID before resolving the parent" })
    .not.toBeNull();
  const prepared = await lab.confx.lastPrepared();
  expect(prepared).toMatchObject({
    rootName: `subtree-${SUBTREE_PAGE}`,
    destination: "streamed-zip",
  });
  const actualRoot = reference.root.slice(0, -1);
  expect(actualRoot).not.toBe(prepared.rootName);
  const existingName = `${actualRoot}-${prepared.id}.zip`;
  await lab.opfs.ensureFile(parent, existingName, sentinel.toString("base64"));
  const filesBefore = await lab.opfs.snapshot(parent);
  await lab.confx.resolveDeferredDirectoryPicker();

  await expect(
    owner.getByRole("alert").filter({ hasText: "Export did not finish" }),
  ).toBeVisible({ timeout: 45_000 });
  await expect
    .poll(async () => (await readActiveJob(owner))?.status, {
      message: "The streamed filename collision must fail the real export job",
    })
    .toBe("failed");
  const terminal = await readActiveJob(owner);
  expect(terminal).toMatchObject({
    id: prepared.id,
    terminalReason: "destination-collision",
    counts: { entriesWritten: 0, bytesWritten: 0 },
  });
  expect(terminal.result).toBeUndefined();
  await expect(owner.getByText("Export ready", { exact: true })).toHaveCount(0);
  await expect
    .poll(() => lockReleased(owner), { message: "The failed export must release its lock" })
    .toBe(true);
  expect(await onlyChildEntry(lab, parent, "file")).toBe(existingName);
  expect(
    await lab.opfs.snapshot(parent),
    "A streamed filename collision never opens or changes the existing file",
  ).toEqual(filesBefore);
  const preserved = await lab.opfs.readFileB64(parent, existingName);
  expect(Buffer.from(preserved, "base64").equals(sentinel)).toBe(true);
  await exportStartButton(owner);
  expect(await downloadIds(owner), "A failed disk ZIP must not fall back to downloading").toEqual(
    downloadsBefore,
  );
  expect((await lab.snapshot()).details).toEqual(before.details);
  expectReadOnlyConversions(await lab.logsAfter(cursor));
  await lab.testInfo.attach("streamed-destination-collision", {
    body: JSON.stringify({ existingName, prepared, terminal }, null, 2),
    contentType: "application/json",
  });
});

test("a popup continues multipage and disk drafts in fresh normal source-pinned workspaces without starting or handing off a job", async ({
  lab,
}) => {
  const owner = lab.confx.page;
  await lab.wiki.open(SUBTREE_PAGE);
  await lab.confx.selectSubtreeRoot(SUBTREE_PAGE);
  const sourceUrl = lab.wiki.page.url();
  const savedDefaults = await owner.evaluate(async () => chrome.storage.sync.get("cx.settings.v1"));

  // A genuine popup window selects the draft; only a new normal tab may run it.
  const openedPopup = lab.context.waitForEvent("page");
  await owner.evaluate(
    (url) => chrome.windows.create({ url, type: "popup", width: 480, height: 640 }),
    owner.url(),
  );
  const popup = await openedPopup;
  const popupUi = lab.confx.forPage(popup);
  await popupUi.targetWiki();
  await popupUi.selectSubtreeRoot(SUBTREE_PAGE);
  await popupUi.selectTemplate("Markdown only");
  const workspaces = [];
  for (const destination of ["Download ZIP", "New folder", "ZIP to disk"]) {
    await expect(popupUi.destinationControl("Download ZIP")).toBeEnabled();
    await expect(popupUi.destinationControl("New folder")).toBeEnabled();
    await expect(popupUi.destinationControl("ZIP to disk")).toBeEnabled();
    await popupUi.selectDestination(destination);
    await expect(popupUi.startButton).toHaveText("Continue in workspace tab");
    await expect(popupUi.startButton).toBeEnabled();

    const openedWorkspace = lab.context.waitForEvent("page");
    await popupUi.startButton.click();
    const workspace = await openedWorkspace;
    const workspaceUi = lab.confx.forPage(workspace);
    await expect(workspaceUi.sectionTab("Export")).toHaveAttribute("aria-selected", "true");
    const url = new URL(workspace.url());
    // The tool query is consumed once by the mounted workspace.
    const tool = url.searchParams.get("tool");
    expect(tool === null || tool === "export").toBe(true);
    url.searchParams.delete("tool");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      surface: "workspace",
      sourceTabId: String(lab.sourceTabId),
    });
    expect(await workspace.evaluate(async () => {
      const tab = await chrome.tabs.getCurrent();
      const window = await chrome.windows.get(tab.windowId);
      return window.type;
    })).toBe("normal");
    await expect(workspaceUi.sectionTab("Export")).toHaveAttribute("aria-selected", "true");
    await expect(workspaceUi.scopeTab("Subtree")).toHaveAttribute("aria-selected", "true");
    await expect(workspace.locator(`[data-export-root="${SUBTREE_PAGE}"]`)).toBeVisible();
    await expect(workspaceUi.template).toContainText("Markdown only");
    await expect(workspaceUi.destinationControl(destination)).toBeChecked();
    await expect(workspaceUi.startButton).toHaveText("Start export");
    await expect(workspaceUi.startButton).toBeEnabled();
    await workspaceUi.targetWiki();
    expect(await readActiveJob(workspace), "Continuing only restores a draft, never a live job").toBeNull();
    expect(await lockReleased(workspace), "No export lock is acquired by opening a workspace").toBe(true);
    expect(await downloadIds(workspace)).toEqual([]);
    workspaces.push(workspace.url());
    await workspace.close();
  }
  expect(await popup.evaluate(() => globalThis.__confxExportPickers ?? null)).toBeNull();
  expect(await readActiveJob(popup)).toBeNull();
  expect(lab.wiki.page.url(), "The explicit source stays on the selected page").toBe(sourceUrl);
  expect(await owner.evaluate(async () => chrome.storage.sync.get("cx.settings.v1"))).toEqual(savedDefaults);
  await lab.testInfo.attach("surface-gating", {
    body: JSON.stringify({ popup: popup.url(), workspaces }),
    contentType: "application/json",
  });
});

test("a normal workspace disables both disk destinations without a directory picker and never silently changes the selection", async ({
  lab,
}) => {
  await lab.confx.selectDestination("New folder");
  const unsupported = await lab.context.newPage();
  await unsupported.addInitScript(() => {
    Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: undefined });
  });
  await unsupported.goto(lab.confx.page.url());
  const ui = lab.confx.forPage(unsupported);
  await ui.selectSection("Export");
  for (const destination of ["New folder", "ZIP to disk"]) {
    const control = ui.destinationControl(destination);
    await expect(control).toBeDisabled();
    await expect(control).toHaveAccessibleDescription(API_UNAVAILABLE_REASON);
  }
  await expect(ui.destinationControl("New folder")).toBeChecked();
  await expect(ui.destinationControl("Download ZIP")).not.toBeChecked();
  await expect(ui.startButton).toBeDisabled();
  await expect(
    unsupported
      .getByRole("complementary", { name: "Export summary", exact: true })
      .getByRole("note")
      .filter({ hasText: API_UNAVAILABLE_REASON }),
  ).toBeVisible();
  expect(await readActiveJob(unsupported)).toBeNull();
  expect(await downloadIds(unsupported)).toEqual([]);
  await ui.selectDestination("Download ZIP");
  await expect(ui.startButton).toBeEnabled();
  expect(await readActiveJob(unsupported)).toBeNull();
});
