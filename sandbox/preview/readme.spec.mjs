import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { ConfxUi, SandboxLab, SandboxUi } from "../e2e/fixtures.mjs";
import {
  expectLocalMarkdownTargets,
  expectReadOnlyConversions,
  readDownloadedArchive,
  readEditableArtifact,
} from "../e2e/artifacts.mjs";
import { LOCAL_ORIGIN } from "../e2e/origin.mjs";

const viewport = { width: 1120, height: 900 };
const labels = {
  en: {
    sections: "Primary section",
    export: "Export",
    scope: "Export scope",
    subtree: "Subtree",
    editable: "Editable Markdown sidecar",
    destination: "Download ZIP",
    summary: "Export summary",
    ready: "Export ready",
  },
  ru: {
    sections: "Основной раздел",
    export: "Экспорт",
    scope: "Область экспорта",
    subtree: "Поддерево",
    editable: "Editable Markdown для одной страницы",
    destination: "Скачать ZIP",
    summary: "Итоговая сводка",
    ready: "Экспорт готов",
  },
};

test("capture an actual read-only subtree export in the normal workspace", async ({
  baseURL,
}, testInfo) => {
  expect(baseURL).toBe(LOCAL_ORIGIN);
  const locale = testInfo.project.name;
  const text = labels[locale];
  expect(text).toBeDefined();
  const extensionPath = resolve("dist");
  const manifest = JSON.parse(await readFile(resolve(extensionPath, "manifest.json"), "utf8"));
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.side_panel?.default_path).toBeTruthy();
  expect(manifest.background?.service_worker).toBeTruthy();
  const staged = resolve("tests/reports/readme-preview/staged", locale);
  await mkdir(staged, { recursive: true });
  // A failed fresh recording must never leave a usable receipt from a previous run.
  await rm(resolve(staged, "capture.json"), { force: true });
  const downloadsPath = testInfo.outputPath("downloads");
  const videoPath = testInfo.outputPath("videos");
  await mkdir(downloadsPath, { recursive: true });
  const context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-domain-reliability",
      "--disable-sync",
      "--no-default-browser-check",
      "--no-first-run",
    ],
    acceptDownloads: true,
    viewport,
    recordVideo: { dir: videoPath, size: viewport },
    locale: locale === "ru" ? "ru-RU" : "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
  });
  context.setDefaultTimeout(10_000);
  context.setDefaultNavigationTimeout(20_000);
  const externalRequests = [];
  const pageErrors = [];
  const attach = (page) => page.on("pageerror", (error) => pageErrors.push(error.message));
  context.pages().forEach(attach);
  context.on("page", attach);
  await context.route(/^https?:\/\//, async (route) => {
    if (new URL(route.request().url()).origin === LOCAL_ORIGIN) return route.continue();
    externalRequests.push(route.request().method());
    return route.abort("blockedbyclient");
  });
  let video;
  let recordedVideoPath;
  let receipt;
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    expect(new URL(worker.url()).pathname.slice(1)).toBe(manifest.background.service_worker);
    const extensionId = new URL(worker.url()).hostname;
    const lab = new SandboxLab(context, testInfo, downloadsPath);
    await lab.resetData();
    const source = context.pages()[0] ?? (await context.newPage());
    lab.wiki = new SandboxUi(source, lab);
    await lab.wiki.open("1700");
    const sourceUrl = source.url();
    lab.sourceTabId = await worker.evaluate(
      async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id,
      sourceUrl,
    );
    expect(lab.sourceTabId).toBeGreaterThan(0);
    await worker.evaluate(
      async (locale) =>
        chrome.storage.sync.set({
          "cx.settings.v1": { version: 6, locale, theme: "dark", palette: "blue" },
        }),
      locale,
    );
    const cdp = await context.newCDPSession(source);
    await cdp.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadsPath,
      eventsEnabled: true,
    });
    const before = await Promise.all([lab.detail("1700"), lab.detail("1710")]);
    const origin = Date.now();
    const page = await context.newPage();
    video = page.video();
    await page.goto(
      `chrome-extension://${extensionId}/${manifest.side_panel.default_path}?surface=workspace&sourceTabId=${lab.sourceTabId}`,
    );
    lab.confx = new ConfxUi(page, lab);
    const ui = lab.confx;
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute("data-palette", "blue");
    await expect(ui.sourceCard.getByText("Lorem links and assets", { exact: true })).toBeVisible();
    await expect(ui.startButton).toBeEnabled();
    await expect(
      page
        .getByRole("tablist", { name: text.sections, exact: true })
        .getByRole("tab", { name: text.export, exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    const clipStartSeconds = (Date.now() - origin) / 1000 + 0.25;
    const stages = [];
    const stage = async (name) => {
      const screenshot = `${String(stages.length).padStart(2, "0")}-${name}.png`;
      const seconds = (Date.now() - origin) / 1000;
      await page.screenshot({ path: resolve(staged, screenshot) });
      stages.push({ name, seconds, screenshot });
    };
    // Holds are for reading only. Every transition waits on real UI state first.
    await stage("page-before");
    await page.waitForTimeout(2_000);
    await stage("page-after");
    await page
      .getByRole("tablist", { name: text.scope, exact: true })
      .getByRole("tab", { name: text.subtree, exact: true })
      .click();
    const root = page.getByRole("button", { name: "Lorem links and assets", exact: true });
    await root.click();
    await expect(root).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('[data-export-root="1700"]')).toContainText("Lorem links and assets");
    expect(source.url()).toBe(sourceUrl);
    await stage("subtree-before");
    await page.waitForTimeout(2_500);
    await stage("subtree-after");
    const editable = page.getByRole("switch", { name: text.editable, exact: true });
    await expect(editable).toHaveAttribute("aria-checked", "true");
    await editable.click();
    await expect(editable).toHaveAttribute("aria-checked", "false");
    await stage("editable-off-before");
    await page.waitForTimeout(1_000);
    await stage("editable-off-after");
    await editable.click();
    await expect(editable).toHaveAttribute("aria-checked", "true");
    await stage("editable-on-before");
    await page.waitForTimeout(1_500);
    await stage("editable-on-after");
    const destination = page.getByRole("radio", { name: text.destination, exact: true });
    await destination.check();
    await expect(destination).toBeChecked();
    await expect(
      page.getByRole("complementary", { name: text.summary, exact: true }),
    ).toBeVisible();
    await ui.startButton.scrollIntoViewIfNeeded();
    await stage("summary-before");
    await page.waitForTimeout(2_500);
    await stage("summary-after");
    const cursor = await lab.cursor();
    const download = await ui.download(() => ui.startButton.click(), ".zip");
    await expect(page.getByRole("status")).toContainText(text.ready);
    await stage("ready-before");
    await page.waitForTimeout(4_000);
    await stage("ready-after");
    const clipEndSeconds = (Date.now() - origin) / 1000;
    // Leave a raw tail so trim never reaches shutdown frames.
    await page.waitForTimeout(500);
    const archive = await readDownloadedArchive(download);
    expect(archive.manifest).toMatchObject({
      manifest_version: 2,
      type: "subtree",
      counts: { pages: 2 },
      failures: [],
    });
    expect(archive.manifest.pages.map((page) => page.id).sort()).toEqual(["1700", "1710"]);
    for (const entry of archive.manifest.pages) {
      expect(entry.editable.status).toBe("available");
      const editable = readEditableArtifact(archive.text(entry.editable.path), "storage");
      const published = before.find((detail) => detail.page.id === entry.id);
      expect(editable.metadata).toMatchObject({
        pageId: entry.id,
        host: LOCAL_ORIGIN,
        version: published.page.version,
      });
      expect(editable.source).toBe(published.published.storage);
    }
    expectLocalMarkdownTargets(
      archive,
      archive.manifest.pages.map((page) => page.archive_path),
    );
    const entries = await lab.logsAfter(cursor);
    expectReadOnlyConversions(entries);
    expect(
      entries.filter(
        (entry) =>
          !["GET", "HEAD"].includes(entry.method) &&
          !/^\/rest\/api\/contentbody\/convert\/(editor|storage)$/.test(entry.path),
      ),
    ).toEqual([]);
    for (const old of before) expect(await lab.detail(old.page.id)).toEqual(old);
    expect(externalRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
    receipt = {
      schema: 1,
      locale,
      extensionVersion: manifest.version,
      viewport,
      clipStartSeconds,
      clipDurationSeconds: clipEndSeconds - clipStartSeconds,
      stages,
      completedDownload: true,
      pages: ["1700", "1710"],
      editableSidecars: 2,
      localMarkdownTargets: true,
      noExternalRequests: true,
      readOnlyConversions: true,
      noPublicationDraftAttachmentWrites: true,
      publishedUnchanged: true,
    };
    recordedVideoPath = await video.path();
  } catch (error) {
    await testInfo.attach("capture-failure", {
      body: JSON.stringify({ locale, completed: false, externalRequests, pageErrors }),
      contentType: "application/json",
    });
    for (const [index, page] of context.pages().entries()) {
      if (!page.isClosed()) {
        await testInfo.attach(`failed-page-${index}`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      }
    }
    throw error;
  } finally {
    await context.close();
  }
  // The persistent browser closes Playwright's artifact channel on context.close().
  // Copy the exact handle-owned local recording only after its encoder has finalized.
  expect(receipt?.completedDownload, "Only fully verified captures can be staged").toBe(true);
  expect(recordedVideoPath, "The extension page must have a real recorded video").toBeTruthy();
  await copyFile(recordedVideoPath, resolve(staged, "capture.webm"));
  await writeFile(resolve(staged, "capture.json"), JSON.stringify(receipt, null, 2) + "\n");
  await rm(videoPath, { recursive: true, force: true });
});
