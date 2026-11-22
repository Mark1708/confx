import { test, expect } from "./fixtures.mjs";
import { LOCAL_ORIGIN } from "./origin.mjs";
import {
  EDITED_MACRO_TEXT,
  EDITED_TYPOGRAPHY_TEXT,
  MACRO_TEXT,
  TYPOGRAPHY_TEXT,
} from "./expectations.mjs";
import { conversions, editVisibleMarkdown, expectReadOnlyConversions } from "./artifacts.mjs";

async function prepareStorageEdit(lab) {
  await lab.wiki.open("1500", true);
  const initial = await lab.detail("1500");
  const archive = await lab.confx.exportPage();
  const exported = archive.text(archive.manifest.pages[0].editable.path);
  await lab.confx.loadReady(editVisibleMarkdown(exported, MACRO_TEXT, EDITED_MACRO_TEXT));
  return initial;
}

for (const scenario of ["published-newer", "published-source-changed", "draft-changed"]) {
  test(`Storage apply rejects ${scenario} without overwriting any source`, async ({ lab }) => {
    const initial = await prepareStorageEdit(lab);
    const originalNative = await lab.wiki.nativeHtml();
    await lab.wiki.scenario(scenario);
    const changed = await lab.detail("1500");
    if (scenario === "published-newer") {
      expect(changed.page.version).toBe(initial.page.version + 1);
      expect(changed.published.storage).not.toBe(initial.published.storage);
      await expect(lab.wiki.page.getByTestId("published-version")).toContainText(
        String(changed.page.version),
      );
      await expect(lab.wiki.content).toContainText("Lorem newer published revision.");
      expect(await lab.wiki.nativeHtml()).toBe(originalNative);
    } else if (scenario === "published-source-changed") {
      expect(changed.page.version).toBe(initial.page.version);
      expect(changed.published.storage).not.toBe(initial.published.storage);
      await expect(lab.wiki.content).toContainText(
        "Lorem published source changed at the same revision.",
      );
      expect(await lab.wiki.nativeHtml()).toBe(originalNative);
    } else {
      expect(changed.published).toEqual(initial.published);
      expect(changed.draft).not.toBeNull();
      expect(changed.draft.storage).not.toBe(initial.published.storage);
      await lab.wiki.open("1500", true);
      expect(await lab.wiki.nativeHtml()).not.toBe(originalNative);
      await expect(lab.wiki.body).toContainText("Lorem independently changed draft.");
    }
    const nativeBeforeApply = await lab.wiki.nativeHtml();
    const cursor = await lab.cursor();
    const receivedConversions = lab.captureConversions();
    await lab.confx.confirmApply();
    await expect(lab.confx.alert).toBeVisible();
    await expect(lab.confx.applyButton).toBeDisabled();
    expect(await lab.wiki.nativeHtml()).toBe(nativeBeforeApply);
    await expect(lab.wiki.body).not.toContainText(EDITED_MACRO_TEXT);
    expect(await lab.detail("1500")).toEqual(changed);
    const log = await lab.logsAfter(cursor);
    expectReadOnlyConversions(log);
    expect(conversions(log)).toHaveLength(scenario === "draft-changed" ? 1 : 0);
    expect(
      log.filter((entry) => entry.method === "GET" && entry.path === "/rest/api/content/1500"),
    ).toEqual([expect.objectContaining({ status: 200 })]);
    const delivered = await receivedConversions();
    expect(delivered).toHaveLength(scenario === "draft-changed" ? 1 : 0);
    if (scenario === "draft-changed") {
      expect(delivered[0].response.value).toBe(changed.draft.storage);
    }
  });
}

test("conversion loss is reported explicitly and leaves complete native and protected published sources untouched", async ({
  lab,
}) => {
  await prepareStorageEdit(lab);
  const nativeBefore = await lab.wiki.nativeHtml();
  await lab.wiki.scenario("conversion-loss");
  const beforeApply = await lab.detail("1500");
  const cursor = await lab.cursor();
  const receivedConversions = lab.captureConversions();
  await lab.confx.confirmApply();
  await expect(lab.confx.alert).toBeVisible();
  await expect(lab.confx.applyButton).toBeDisabled();
  expect(await lab.wiki.nativeHtml()).toBe(nativeBefore);
  await expect(lab.wiki.body).toContainText("lorem-plugin");
  await expect(lab.wiki.body).not.toContainText(EDITED_MACRO_TEXT);
  expect(await lab.detail("1500")).toEqual(beforeApply);
  const log = await lab.logsAfter(cursor);
  expectReadOnlyConversions(log);
  expect(conversions(log).map((entry) => entry.path)).toEqual([
    "/rest/api/contentbody/convert/storage",
    "/rest/api/contentbody/convert/editor",
    "/rest/api/contentbody/convert/storage",
  ]);
  const [live, candidate, roundtrip] = await receivedConversions();
  expect(live.response.value).toBe(beforeApply.published.storage);
  expect(candidate.request.value).toBe(
    beforeApply.published.storage.replace(MACRO_TEXT, EDITED_MACRO_TEXT),
  );
  expect(roundtrip.request.value).toBe(candidate.response.value);
  expect(roundtrip.response.value).not.toBe(candidate.request.value);
});

test("native Markdown apply refuses independent keyboard edits made since the exported capture", async ({
  lab,
}) => {
  await lab.wiki.open("1100", true);
  const initial = await lab.detail("1100");
  const downloaded = await lab.confx.exportNative();
  await lab.confx.loadReady(
    editVisibleMarkdown(downloaded.text, TYPOGRAPHY_TEXT, EDITED_TYPOGRAPHY_TEXT),
  );
  const concurrentText = "Lorem concurrent native keyboard edit";
  await lab.wiki.appendNative(concurrentText);
  const concurrentNative = await lab.wiki.nativeHtml();
  const cursor = await lab.cursor();
  await lab.confx.confirmApply();
  await expect(lab.confx.alert).toBeVisible();
  await expect(lab.confx.applyButton).toBeDisabled();
  await expect(lab.wiki.body).toContainText(concurrentText);
  await expect(lab.wiki.body).toContainText(TYPOGRAPHY_TEXT);
  await expect(lab.wiki.body).not.toContainText(EDITED_TYPOGRAPHY_TEXT);
  expect(await lab.wiki.nativeHtml()).toBe(concurrentNative);
  expect(await lab.detail("1100")).toEqual(initial);
  const log = await lab.logsAfter(cursor);
  expectReadOnlyConversions(log);
  expect(conversions(log)).toEqual([]);
});

test("Storage apply rechecks native content after a real server conversion is in flight", async ({
  lab,
}) => {
  const initial = await prepareStorageEdit(lab);
  const release = Promise.withResolvers();
  let conversionHeld = false;
  const endpoint = `${LOCAL_ORIGIN}/rest/api/contentbody/convert/editor`;
  const holdRealResponse = async (route) => {
    // Delay only delivery: the actual local server handles and logs the unchanged request.
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    conversionHeld = true;
    await release.promise;
    await route.fulfill({ response });
  };
  await lab.context.route(endpoint, holdRealResponse);
  const cursor = await lab.cursor();
  const receivedConversions = lab.captureConversions();
  try {
    await lab.confx.confirmApply();
    await expect
      .poll(() => conversionHeld, {
        message: "The real storage-to-editor response is held before native apply",
      })
      .toBe(true);
    const concurrentText = "Lorem keyboard edit during actual conversion";
    await lab.wiki.appendNative(concurrentText);
    const concurrentNative = await lab.wiki.nativeHtml();
    release.resolve();
    await expect(lab.confx.alert).toBeVisible();
    await expect(lab.confx.applyButton).toBeDisabled();
    await expect(lab.wiki.body).toContainText(concurrentText);
    await expect(lab.wiki.body).not.toContainText(EDITED_MACRO_TEXT);
    expect(await lab.wiki.nativeHtml()).toBe(concurrentNative);
    expect(await lab.detail("1500")).toEqual(initial);
    const log = await lab.logsAfter(cursor);
    expectReadOnlyConversions(log);
    expect(conversions(log)).toHaveLength(3);
    const delivered = await receivedConversions();
    expect(delivered[1].request.value).toBe(
      initial.published.storage.replace(MACRO_TEXT, EDITED_MACRO_TEXT),
    );
    expect(delivered[2].response.value).toBe(delivered[1].request.value);
    expect(
      log.filter((entry) => entry.method === "GET" && entry.path === "/rest/api/content/1500"),
    ).toEqual([expect.objectContaining({ status: 200 }), expect.objectContaining({ status: 200 })]);
  } finally {
    release.resolve();
    await lab.context.unroute(endpoint, holdRealResponse);
  }
});
