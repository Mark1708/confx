import { test, expect } from "./fixtures.mjs";
import {
  editVisibleMarkdown,
  expectLocalMarkdownTargets,
  expectReadOnlyConversions,
} from "./artifacts.mjs";
import { TYPOGRAPHY_TEXT } from "./expectations.mjs";

test("the production composer stays usable at narrow and wide widths with keyboard section navigation", async ({
  lab,
}) => {
  const page = lab.confx.page;
  for (const width of [320, 350, 600, 1120]) {
    await page.setViewportSize({ width, height: 960 });
    await expect(lab.confx.startButton).toBeVisible();
    await expect(lab.confx.startButton).toHaveCount(1);
    await expect(lab.confx.template).toHaveCount(1);
    expect(await page.evaluate(() => ({
      html: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      body: document.body.scrollWidth <= document.body.clientWidth,
    }))).toEqual({ html: true, body: true });
    await expect(page.getByRole("radio", { name: "Download ZIP", exact: true })).toBeChecked();
  }
  const exportTab = lab.confx.sectionTab("Export");
  await exportTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#editor-markdown")).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(lab.confx.sectionTab("Watch")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(exportTab).toHaveAttribute("aria-selected", "true");
  await expect(lab.confx.startButton).toBeVisible();
});

test("a one-off template controls the actual archive without changing saved defaults", async ({
  lab,
}) => {
  await lab.wiki.open("1700");
  await lab.confx.targetWiki();
  const page = lab.confx.page;
  const before = await page.evaluate(async () => chrome.storage.sync.get("cx.settings.v1"));
  await lab.confx.selectTemplate("Markdown only");
  await page.getByText("Conversion and rules", { exact: true }).click();
  const frontMatter = page.getByRole("switch", {
    name: "Front-matter YAML in each .md",
    exact: true,
  });
  await expect(frontMatter).toHaveAttribute("aria-checked", "true");
  await frontMatter.click();
  await expect(frontMatter).toHaveAttribute("aria-checked", "false");

  const archive = await lab.confx.exportPage();
  expect(archive.manifest).toMatchObject({
    type: "single-page",
    preset: "md-only",
    counts: { pages: 1, images: 0, attachments: 0, plantuml_diagrams: 0 },
    failures: [],
  });
  expect(archive.text("index.md")).toMatch(/^# /);
  expect(await page.evaluate(async () => chrome.storage.sync.get("cx.settings.v1"))).toEqual(
    before,
  );
  await page.getByRole("button", { name: "Save as defaults", exact: true }).click();
  await expect
    .poll(async () =>
      page.evaluate(
        async () => (await chrome.storage.sync.get("cx.settings.v1"))["cx.settings.v1"],
      ),
    )
    .toMatchObject({
      version: 6,
      exportDefaults: { presetId: "md-only", conversion: { includeFrontMatter: false } },
    });
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("Settings opens the sole options page and advanced controls stay collapsed until requested", async ({
  lab,
}) => {
  const opened = lab.context.waitForEvent("page");
  await lab.confx.page.getByRole("button", { name: "Settings", exact: true }).click();
  const options = await opened;
  await expect(options).toHaveURL(/\/options\/index\.html(?:[?#]|$)/);
  await expect(options.locator("#defaults")).toBeVisible();
  const advanced = options.locator("#advanced > details");
  await expect(advanced).not.toHaveAttribute("open", "");
  await options.getByRole("link", { name: "Advanced: network and rules", exact: true }).click();
  await expect(advanced).toHaveAttribute("open", "");
  await expect(options.getByRole("button", { name: "Export rules", exact: true })).toBeVisible();
  for (const width of [320, 350, 600, 1120]) {
    await options.setViewportSize({ width, height: 960 });
    expect(await options.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
});

test("CSV tables only disables incompatible package switches and writes a service index for every actual CSV", async ({
  lab,
}) => {
  await lab.wiki.open("1300");
  const before = await lab.detail("1300");
  await lab.confx.selectScope("Page");
  await lab.confx.template.click();
  await expect(lab.confx.page.getByRole("option")).toHaveText([
    "Markdown + attachments",
    "Markdown only",
    "CSV tables only",
  ]);
  await lab.confx.page.getByRole("option", { name: "CSV tables only", exact: true }).click();
  for (const name of [
    "Editable Markdown sidecar",
    "Images",
    "File attachments",
    "PlantUML assets",
    "Page comments",
    "Version history",
  ]) {
    const control = lab.confx.page.getByRole("switch", { name, exact: true });
    await expect(control).toBeVisible();
    await expect(control).toBeDisabled();
    await expect(control).toHaveAttribute("aria-checked", "false");
  }
  const cursor = await lab.cursor();
  const archive = await lab.confx.exportPage();
  expect(archive.manifest).toMatchObject({
    type: "single-page",
    preset: "tables-only",
    counts: { pages: 1, tables_csv: 3, images: 0, attachments: 0, plantuml_diagrams: 0 },
    failures: [],
  });
  const entry = archive.manifest.pages[0];
  expect(entry.editable.status).toBe("unavailable");
  const csvPaths = Object.keys(archive.entries)
    .filter((path) => path.endsWith(".csv"))
    .map((path) => path.slice(archive.root.length));
  expect(csvPaths).toHaveLength(3);
  const links = expectLocalMarkdownTargets(archive, [entry.archive_path]);
  expect(links.map((link) => link.target).sort()).toEqual([...csvPaths].sort());
  expect(csvPaths.map((path) => archive.text(path)).join("\n")).toContain("Lorem key");
  expect(Object.keys(archive.entries).sort()).toEqual(
    [entry.archive_path, "manifest.json", ...csvPaths].map((path) => archive.root + path).sort(),
  );
  expect(await lab.detail("1300")).toEqual(before);
  expectReadOnlyConversions(await lab.logsAfter(cursor));
});

test("Choose file in workspace tab opens a normal pinned editor workflow without an automatic file dialog or transferred file", async ({
  lab,
}) => {
  await lab.wiki.open("1100", true);
  const before = await lab.detail("1100");
  const nativeBefore = await lab.wiki.nativeHtml();
  const exported = await lab.confx.exportNative();
  const editedText = "Lorem file selected only in the normal workspace";
  const edited = editVisibleMarkdown(exported.text, TYPOGRAPHY_TEXT, editedText);
  const choosers = [];
  const observe = (page) => page.on("filechooser", () => choosers.push(page.url()));
  lab.context.on("page", observe);
  const cursor = await lab.cursor();
  try {
    const openedPopup = lab.context.waitForEvent("page");
    await lab.confx.page.evaluate(
      (url) => chrome.windows.create({ url, type: "popup", width: 480, height: 640 }),
      lab.confx.page.url(),
    );
    const popup = await openedPopup;
    const popupUi = lab.confx.forPage(popup);
    await popupUi.selectSection("Update page");
    await popupUi.targetWiki();
    const openedWorkspace = lab.context.waitForEvent("page");
    await popup.getByRole("button", { name: "Choose file in workspace tab", exact: true }).click();
    const workspace = await openedWorkspace;
    const ui = lab.confx.forPage(workspace);
    await expect(ui.sectionTab("Update page")).toHaveAttribute("aria-selected", "true");
    await expect(workspace.locator("#editor-markdown")).toBeVisible();
    expect(new URL(workspace.url()).searchParams.get("sourceTabId")).toBe(String(lab.sourceTabId));
    expect(await workspace.evaluate(async () => {
      const tab = await chrome.tabs.getCurrent();
      return (await chrome.windows.get(tab.windowId)).type;
    })).toBe("normal");
    expect(choosers, "Opening the normal tab does not launch a delayed native picker").toEqual([]);
    await expect(ui.editor.getByText("edited.md", { exact: true })).toHaveCount(0);
    await expect(ui.applyButton).toBeDisabled();
    await expect(
      workspace.getByRole("button", { name: "Choose file in workspace tab", exact: true }),
    ).toHaveCount(0);
    expect(await lab.wiki.nativeHtml()).toBe(nativeBefore);

    // Playwright supplies a file to the real normal-tab input; this is not OS-dialog evidence.
    await ui.loadReady(edited);
    await expect(ui.editor.locator("ins")).toContainText(editedText);
    const saved = await workspace.evaluate(async () =>
      JSON.stringify(await chrome.storage.session.get(null)),
    );
    expect(saved).not.toContain(editedText);
    expect(saved).not.toContain("edited.md");
    await ui.confirmApply();
    await expect(ui.applyButton).toBeDisabled();
    await expect(lab.wiki.body).toContainText(editedText);
    expect(await lab.wiki.nativeHtml()).toBe(nativeBefore.replace(TYPOGRAPHY_TEXT, editedText));
    expect(await lab.detail("1100")).toEqual(before);
    expectReadOnlyConversions(await lab.logsAfter(cursor));
  } finally {
    lab.context.off("page", observe);
  }
});

test("production launcher and editor handoff recover fresh blank API-created surfaces without retargeting existing tabs", async ({
  lab,
}) => {
  await lab.wiki.open("1100", true);
  const sourceUrl = lab.wiki.page.url();
  const existingWorkspaceUrl = lab.confx.page.url();
  const before = await lab.detail("1100");
  const worker = lab.context.serviceWorkers()[0];
  await worker.evaluate(() => {
    const originals = {
      panel: chrome.sidePanel.open,
      window: chrome.windows.create,
      tab: chrome.tabs.create,
    };
    const committedBlank = async (tabId) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete" && !tab.pendingUrl) return tab;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("The genuine blank browser tab did not finish loading");
    };
    chrome.sidePanel.open = () => Promise.reject(new Error("Native panel unavailable"));
    chrome.windows.create = async (options) => {
      const created = await originals.window.call(chrome.windows, {
        ...options,
        url: "about:blank",
      });
      await committedBlank(created.tabs[0].id);
      delete created.tabs;
      return created;
    };
    chrome.tabs.create = async (options) => {
      const created = await originals.tab.call(chrome.tabs, {
        ...options,
        url: "about:blank",
      });
      return committedBlank(created.id);
    };
    globalThis.__confxRestoreNavigationApis = () => {
      chrome.sidePanel.open = originals.panel;
      chrome.windows.create = originals.window;
      chrome.tabs.create = originals.tab;
      delete globalThis.__confxRestoreNavigationApis;
    };
  });
  try {
    const openedPopup = lab.context.waitForEvent("page");
    await lab.wiki.page.locator("#cx-open-md-btn").click();
    const popup = await openedPopup;
    await expect(popup.getByRole("tab", { name: "Update page", exact: true })).toBeVisible({
      timeout: 5000,
    });
    const popupUi = lab.confx.forPage(popup);
    await popupUi.selectSection("Update page");
    await expect(popup.getByRole("button", {
      name: "Choose file in workspace tab",
      exact: true,
    })).toBeVisible();
    expect(new URL(popup.url()).searchParams.get("sourceTabId")).toBe(String(lab.sourceTabId));
    const openedWorkspace = lab.context.waitForEvent("page");
    await popup.getByRole("button", { name: "Choose file in workspace tab", exact: true }).click();
    const workspace = await openedWorkspace;
    await expect(workspace.locator("#editor-markdown")).toBeVisible();
    expect(new URL(workspace.url()).searchParams.get("sourceTabId")).toBe(String(lab.sourceTabId));
    expect(await workspace.evaluate(async () => {
      const tab = await chrome.tabs.getCurrent();
      return (await chrome.windows.get(tab.windowId)).type;
    })).toBe("normal");
    expect(lab.wiki.page.url()).toBe(sourceUrl);
    expect(lab.confx.page.url()).toBe(existingWorkspaceUrl);
    expect(await lab.detail("1100")).toEqual(before);
  } finally {
    await worker.evaluate(() => globalThis.__confxRestoreNavigationApis?.());
  }
});
