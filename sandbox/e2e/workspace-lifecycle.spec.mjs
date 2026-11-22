import { test, expect } from "./fixtures.mjs";
import { editVisibleMarkdown, expectReadOnlyConversions } from "./artifacts.mjs";
import { TYPOGRAPHY_TEXT } from "./expectations.mjs";
import { LOCAL_ORIGIN } from "./origin.mjs";

// These journeys use the built extension, real session storage, and actual HTTP/DOM.
test("a selected subtree root and manual expansion survive sections, source navigation and UI reload", async ({
  lab,
}) => {
  const page = lab.confx.page;
  const rootTitle = (await lab.detail("1000")).page.title;
  const selectedTitle = (await lab.detail("1700")).page.title;
  const nextTitle = (await lab.detail("1100")).page.title;
  const sourceUrl = lab.wiki.page.url();
  await lab.confx.selectSubtreeRoot("1700");
  const selected = page.getByRole("button", { name: selectedTitle, exact: true });
  expect(lab.wiki.page.url()).toBe(sourceUrl);
  await page.getByRole("button", { name: `Collapse “${rootTitle}”`, exact: true }).click();
  const filter = page.getByRole("textbox", { name: "Filter by title…", exact: true });
  await filter.fill(selectedTitle);
  await expect(selected).toBeVisible();
  await lab.confx.selectSection("Watch");
  await lab.confx.selectSection("Export");
  await expect(lab.confx.scopeTab("Subtree")).toHaveAttribute("aria-selected", "true");
  await expect(filter).toHaveValue(selectedTitle);
  await expect(selected).toHaveAttribute("aria-pressed", "true");

  await lab.wiki.open("1100");
  await expect(lab.confx.sourceCard.getByText(nextTitle, { exact: true })).toBeVisible();
  await expect(filter).toHaveValue(selectedTitle);
  await expect(selected).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(lab.confx.scopeTab("Subtree")).toHaveAttribute("aria-selected", "true");
  await expect(filter).toHaveValue(selectedTitle);
  await expect(selected).toHaveAttribute("aria-pressed", "true");
  await filter.fill("");
  await expect(
    page.getByRole("button", { name: `Expand “${rootTitle}”`, exact: true }),
  ).toBeVisible();
  await expect(selected).toHaveCount(0);
  await page.getByRole("button", { name: `Expand “${rootTitle}”`, exact: true }).click();
  await expect(selected).toHaveAttribute("aria-pressed", "true");
  await page
    .getByRole("button", { name: `Open “${selectedTitle}” in the source tab`, exact: true })
    .click();
  await expect(lab.wiki.page).toHaveURL(/pageId=1700(?:&|$)/);
  await expect(lab.confx.sourceCard.getByText(selectedTitle, { exact: true })).toBeVisible();
});

test("a loaded editable file and its diff stay in memory across Export and Watch, without autosaving its body", async ({
  lab,
}) => {
  await lab.wiki.open("1100", true);
  const original = await lab.detail("1100");
  const nativeBefore = await lab.wiki.nativeHtml();
  const downloaded = await lab.confx.exportNative();
  const marker = "LOREM_TRANSIENT_EDITOR_MARKER";
  await lab.confx.loadReady(editVisibleMarkdown(downloaded.text, TYPOGRAPHY_TEXT, marker));
  const page = lab.confx.page;
  await lab.confx.selectSection("Export");
  await lab.confx.selectSection("Watch");
  await lab.confx.selectSection("Update page");
  await expect(page.getByText("edited.md", { exact: true })).toBeVisible();
  await expect(page.locator("ins")).toContainText(marker);
  await expect(lab.confx.applyButton).toBeEnabled();
  expect(await lab.wiki.nativeHtml()).toBe(nativeBefore);
  expect(await lab.detail("1100")).toEqual(original);
  const saved = await page.evaluate(async () =>
    JSON.stringify(await chrome.storage.session.get(null)),
  );
  expect(saved).not.toContain(marker);
  expect(saved).not.toContain("edited.md");
});

test("a normal extension tab without a source pin does not adopt an active wiki or export its last draft", async ({
  lab,
}) => {
  const unbound = await lab.context.newPage();
  const url = new URL(lab.confx.page.url());
  url.search = "";
  await unbound.goto(url.href);
  await lab.wiki.page.bringToFront();
  const unboundUi = lab.confx.forPage(unbound);
  await expect(unboundUi.scopeTab("Page")).toHaveAttribute("aria-selected", "true");
  await expect(unboundUi.startButton).toBeDisabled();
  await expect(unboundUi.sourceCard.getByText("Source access unavailable", { exact: true })).toBeVisible();
  await expect(
    unbound.getByRole("button", { name: "Open workspace tab", exact: true }),
  ).toBeDisabled();
  await expect(
    unbound.getByRole("button", { name: "Export editable MD", exact: true, includeHidden: true }),
  ).toBeDisabled();
  expect(await unbound.evaluate(async () => chrome.downloads.search({}))).toEqual([]);
});

test("Open workspace creates a real source-bound tab and restores the selected export root", async ({
  lab,
}) => {
  const owner = lab.confx.page;
  const selectedTitle = (await lab.detail("1700")).page.title;
  const sourceTitle = (await lab.detail("1000")).page.title;
  await lab.confx.selectSubtreeRoot("1700");
  const opened = lab.context.waitForEvent("page");
  await owner.getByRole("button", { name: "Open workspace tab", exact: true }).click();
  const workspace = await opened;
  const workspaceUi = lab.confx.forPage(workspace);
  await expect(workspaceUi.sectionTab("Export")).toHaveAttribute("aria-selected", "true");
  await expect(workspaceUi.scopeTab("Subtree")).toHaveAttribute("aria-selected", "true");
  await expect(workspaceUi.sourceCard.getByText(sourceTitle, { exact: true })).toBeVisible();
  await expect(workspace.getByRole("button", { name: selectedTitle, exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(workspaceUi.startButton).toBeEnabled();
  await expect(workspace.locator('[data-export-root="1700"]')).toContainText(selectedTitle);
  expect(await workspace.evaluate(async () => chrome.downloads.search({}))).toEqual([]);
});

test("an export stays pinned to its source when a different wiki tab and the extension itself become active", async ({
  lab,
}) => {
  await lab.wiki.open("1100");
  const before = await lab.detail("1100");
  const other = await lab.context.newPage();
  await other.goto(`${LOCAL_ORIGIN}/pages/viewpage.action?pageId=1700`);
  await expect(other.locator("#main-content")).toContainText("Lorem asset specimen");
  await other.bringToFront();
  await expect(lab.confx.sourceCard.getByText(before.page.title, { exact: true })).toBeVisible();
  const cursor = await lab.cursor();
  const archive = await lab.confx.exportPage();
  expect(archive.manifest.pages.map((page) => page.id)).toEqual(["1100"]);
  expect(archive.text("index.md")).toContain(TYPOGRAPHY_TEXT);
  expect(archive.text("index.md")).not.toContain("Lorem asset specimen");
  expect(await lab.detail("1100")).toEqual(before);
  expectReadOnlyConversions(await lab.logsAfter(cursor));
});

test("changing the pinned page clears its loaded file and confirmation, and rejects a file from the old page", async ({
  lab,
}) => {
  await lab.wiki.open("1100", true);
  const original = await lab.detail("1100");
  const exported = await lab.confx.exportNative();
  const edited = editVisibleMarkdown(exported.text, TYPOGRAPHY_TEXT, "Lorem old-page edit");
  await lab.confx.loadReady(edited);
  await lab.confx.applyButton.click();
  const confirmation = lab.confx.page.getByRole("group", {
    name: "Confirm applying changes",
    exact: true,
  });
  await expect(confirmation).toBeVisible();
  await lab.wiki.open("1700", true);
  const next = await lab.detail("1700");
  const nativeBefore = await lab.wiki.nativeHtml();
  await lab.confx.selectSection("Update page");
  await expect(confirmation).toHaveCount(0);
  await expect(lab.confx.editor.getByText("edited.md", { exact: true })).toHaveCount(0);
  await expect(lab.confx.editor.locator("ins")).toHaveCount(0);
  await expect(lab.confx.applyButton).toBeDisabled();
  const cursor = await lab.cursor();
  await lab.confx.loadMarkdown(edited, "wrong-page.md");
  await expect(lab.confx.alert).toContainText("This file belongs to another page or site.");
  await expect(lab.confx.applyButton).toBeDisabled();
  expect(await lab.wiki.nativeHtml()).toBe(nativeBefore);
  expect(await lab.detail("1700")).toEqual(next);
  expect(await lab.detail("1100")).toEqual(original);
  expectReadOnlyConversions(await lab.logsAfter(cursor));
});
