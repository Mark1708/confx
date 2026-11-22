import { test, expect } from "./fixtures.mjs";
import { LOCAL_ORIGIN } from "./origin.mjs";
import {
  CATALOG,
  EDITED_MACRO_TEXT,
  EDITED_TYPOGRAPHY_TEXT,
  MACRO_TEXT,
  OPAQUE_CDATA,
  OPAQUE_MACRO_ID,
  TYPOGRAPHY_TEXT,
} from "./expectations.mjs";
import {
  alterProtectedBlock,
  conversions,
  draftWrites,
  editVisibleMarkdown,
  expectReadOnlyConversions,
  publishWrites,
  readEditableArtifact,
  successfulWrites,
} from "./artifacts.mjs";

async function exportedStorage(lab) {
  const archive = await lab.confx.exportPage();
  const entry = archive.manifest.pages.find((page) => page.id === lab.wiki.id);
  expect(entry.editable.status).toBe("available");
  return archive.text(entry.editable.path);
}

test("every actual native editor preserves the exact seed Storage on explicit draft save and discard without publishing", async ({
  lab,
}) => {
  const seed = await lab.snapshot();
  for (const specimen of CATALOG) {
    await test.step(`${specimen.id}: real TinyMCE normalization and explicit-only draft writes`, async () => {
      // Inspect each step before later inspector refreshes rotate the bounded 200-entry log.
      const cursor = await lab.cursor();
      const original = seed.details.find((detail) => detail.page.id === specimen.id);
      await lab.wiki.open(specimen.id, true);
      await expect(lab.wiki.body).toContainText(specimen.title);
      await lab.wiki.saveDraft();
      const saved = await lab.detail(specimen.id);
      expect(saved.draft.storage).toBe(original.published.storage);
      expect(saved.draft.baseVersion).toBe(original.page.version);
      expect(saved.published).toEqual(original.published);
      expect(saved.page.version).toBe(original.page.version);
      expect(await lab.wiki.source("draft-storage", original.published.storage)).toBe(
        original.published.storage,
      );
      await lab.wiki.discardDraft();
      expect(await lab.detail(specimen.id)).toEqual(original);
      const log = await lab.logsAfter(cursor);
      expect(publishWrites(log)).toEqual([]);
      expect(draftWrites(log).map(({ method, path }) => ({ method, path }))).toEqual([
        { method: "POST", path: `/sandbox/api/pages/${specimen.id}/draft` },
        { method: "DELETE", path: `/sandbox/api/pages/${specimen.id}/draft` },
      ]);
      expect(successfulWrites(log).every((entry) => draftWrites([entry]).length === 1)).toBe(true);
    });
  }
});

test("native TinyMCE export downloads a real file, imports edits only after confirmation, and Undo restores one complete transaction", async ({
  lab,
}) => {
  await lab.wiki.open("1100", true);
  await expect(lab.wiki.body).toContainText(TYPOGRAPHY_TEXT);
  const initial = await lab.detail("1100");
  const nativeBefore = await lab.wiki.nativeHtml();
  const cursor = await lab.cursor();
  const downloaded = await lab.confx.exportNative();
  const artifact = readEditableArtifact(downloaded.text, "editor");
  expect(artifact.metadata).toMatchObject({ host: LOCAL_ORIGIN, pageId: "1100" });
  expect(artifact.source).toBe(nativeBefore);
  expect(artifact.markdown).toContain(TYPOGRAPHY_TEXT);

  await lab.confx.loadMarkdown(downloaded.text, "unchanged.editable.md");
  await expect(lab.confx.page.getByText("unchanged.editable.md", { exact: true })).toBeVisible();
  await expect(lab.confx.applyButton).toBeDisabled();
  expect(await lab.wiki.nativeHtml()).toBe(nativeBefore);

  const edited = editVisibleMarkdown(downloaded.text, TYPOGRAPHY_TEXT, EDITED_TYPOGRAPHY_TEXT);
  await lab.confx.loadReady(edited);
  await expect(lab.confx.page.locator("ins")).toContainText(EDITED_TYPOGRAPHY_TEXT);
  expect(await lab.wiki.nativeHtml()).toBe(nativeBefore);
  await lab.confx.applyButton.click();
  const confirmation = lab.confx.page.getByRole("group", {
    name: "Confirm applying changes",
    exact: true,
  });
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await lab.wiki.nativeHtml()).toBe(nativeBefore);
  await lab.confx.confirmApply();
  await expect(lab.confx.applyButton).toBeDisabled();
  await expect(lab.wiki.body).toContainText(EDITED_TYPOGRAPHY_TEXT);
  await expect(lab.wiki.content).toContainText(TYPOGRAPHY_TEXT);
  await expect(lab.wiki.content).not.toContainText(EDITED_TYPOGRAPHY_TEXT);
  const nativeAfter = await lab.wiki.nativeHtml();
  expect(nativeAfter).toBe(nativeBefore.replace(TYPOGRAPHY_TEXT, EDITED_TYPOGRAPHY_TEXT));
  expect(await lab.wiki.source("native-editor", nativeAfter)).toBe(nativeAfter);
  expect(await lab.wiki.source("published-storage", initial.published.storage)).toBe(
    initial.published.storage,
  );
  const staged = await lab.detail("1100");
  expect(staged.published).toEqual(initial.published);
  expect(staged.page.version).toBe(initial.page.version);
  expect(staged.draft).toBeNull();
  expectReadOnlyConversions(await lab.logsAfter(cursor));

  await lab.wiki.undo();
  await expect(lab.wiki.body).toContainText(TYPOGRAPHY_TEXT);
  await expect(lab.wiki.body).not.toContainText(EDITED_TYPOGRAPHY_TEXT);
  expect(await lab.wiki.nativeHtml()).toBe(nativeBefore);
  expect((await lab.detail("1100")).published).toEqual(initial.published);
  expectReadOnlyConversions(await lab.logsAfter(cursor));
});

test("published Storage import preserves the complete protected source; only explicit draft save and Publish write local state", async ({
  lab,
}) => {
  await lab.wiki.open("1500", true);
  const initial = await lab.detail("1500");
  const nativeBefore = await lab.wiki.nativeHtml();
  const exported = await exportedStorage(lab);
  const artifact = readEditableArtifact(exported, "storage");
  expect(artifact.source).toBe(initial.published.storage);
  expect(artifact.source).toContain(`ac:macro-id="${OPAQUE_MACRO_ID}"`);
  expect(artifact.source).toContain(OPAQUE_CDATA);
  const expectedStorage = initial.published.storage.replace(MACRO_TEXT, EDITED_MACRO_TEXT);
  expect(expectedStorage).not.toBe(initial.published.storage);
  const edited = editVisibleMarkdown(exported, MACRO_TEXT, EDITED_MACRO_TEXT);
  const cursor = await lab.cursor();
  await lab.confx.loadReady(edited);
  await expect(lab.confx.page.locator("ins")).toContainText(EDITED_MACRO_TEXT);
  expect(await lab.wiki.nativeHtml()).toBe(nativeBefore);
  expect(successfulWrites(await lab.logsAfter(cursor))).toEqual([]);
  await lab.confx.confirmApply();
  await expect(lab.confx.applyButton).toBeDisabled();
  await expect(lab.wiki.body).toContainText(EDITED_MACRO_TEXT);
  await expect(lab.wiki.body).toContainText("lorem-plugin");
  await expect(lab.wiki.content).toContainText(MACRO_TEXT);
  await expect(lab.wiki.content).not.toContainText(EDITED_MACRO_TEXT);
  expect((await lab.detail("1500")).published).toEqual(initial.published);
  expect((await lab.detail("1500")).draft).toBeNull();
  const conversionLog = await lab.logsAfter(cursor);
  expectReadOnlyConversions(conversionLog);
  expect(conversions(conversionLog).map((entry) => entry.path)).toEqual([
    "/rest/api/contentbody/convert/storage",
    "/rest/api/contentbody/convert/editor",
    "/rest/api/contentbody/convert/storage",
  ]);

  await lab.wiki.saveDraft();
  const draft = await lab.detail("1500");
  expect(draft.draft.storage).toBe(expectedStorage);
  expect(draft.draft.baseVersion).toBe(initial.page.version);
  expect(draft.page.version).toBe(initial.page.version);
  expect(draft.published).toEqual(initial.published);
  const draftLog = await lab.logsAfter(cursor);
  expect(draftWrites(draftLog)).toHaveLength(1);
  expect(draftWrites(draftLog)[0]).toMatchObject({
    method: "POST",
    status: 200,
    kind: "draft",
    pageId: "1500",
  });
  expect(publishWrites(draftLog)).toEqual([]);

  await lab.wiki.open("1500", true);
  await expect(lab.wiki.body).toContainText(EDITED_MACRO_TEXT);
  await expect(lab.wiki.content).toContainText(MACRO_TEXT);
  await lab.wiki.publish();
  const published = await lab.detail("1500");
  expect(published.page.version).toBe(initial.page.version + 1);
  expect(published.published.storage).toBe(expectedStorage);
  expect(published.published.storage).toContain(OPAQUE_CDATA);
  expect(published.draft).toBeNull();
  const writes = publishWrites(await lab.logsAfter(cursor));
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ method: "PUT", status: 200, kind: "publish", pageId: "1500" });
  await lab.wiki.open("1500");
  await expect(lab.wiki.content).toContainText(EDITED_MACRO_TEXT);
  await expect(lab.wiki.content).toContainText("lorem-plugin");
  await expect(lab.wiki.page.getByTestId("published-version")).toContainText(
    String(initial.page.version + 1),
  );
  expect(await lab.wiki.source("published-storage", expectedStorage)).toBe(expectedStorage);
  expect(publishWrites(await lab.logsAfter(cursor))).toHaveLength(1);
});

test("editing a protected macro projection is rejected locally without touching native, published or draft source", async ({
  lab,
}) => {
  await lab.wiki.open("1500", true);
  const initial = await lab.detail("1500");
  const nativeBefore = await lab.wiki.nativeHtml();
  const exported = await exportedStorage(lab);
  const cursor = await lab.cursor();
  await lab.confx.loadMarkdown(alterProtectedBlock(exported), "unsupported-protected-edit.md");
  await expect(lab.confx.alert).toBeVisible();
  await expect(lab.confx.applyButton).toBeDisabled();
  expect(await lab.wiki.nativeHtml()).toBe(nativeBefore);
  expect(await lab.detail("1500")).toEqual(initial);
  expect(successfulWrites(await lab.logsAfter(cursor))).toEqual([]);
  expect(conversions(await lab.logsAfter(cursor))).toEqual([]);
});
