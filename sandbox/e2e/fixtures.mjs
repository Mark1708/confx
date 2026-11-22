import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test as base } from "@playwright/test";
import { readDownloadedArchive } from "./artifacts.mjs";
import { LOCAL_ORIGIN } from "./origin.mjs";

const extensionPath = fileURLToPath(new URL("../../dist/", import.meta.url));

export const test = base.extend({
  lab: async ({ baseURL }, use, testInfo) => {
    expect(baseURL, "Sandbox E2E must not target a real wiki").toBe(LOCAL_ORIGIN);
    const manifestPath = resolve(extensionPath, "manifest.json");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (cause) {
      throw new Error("Build the actual Chrome dist before E2E: npm run build:chrome", { cause });
    }
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.side_panel?.default_path).toBeTruthy();
    expect(manifest.background?.service_worker).toBeTruthy();

    const downloadsPath = testInfo.outputPath("downloads");
    const videoPath = testInfo.outputPath("videos");
    await mkdir(downloadsPath, { recursive: true });
    const context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), {
      channel: "chromium",
      headless: process.env.SANDBOX_HEADED !== "1",
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
      viewport: { width: 1280, height: 960 },
      recordVideo: { dir: videoPath, size: { width: 1280, height: 960 } },
      locale: "en-US",
      timezoneId: "UTC",
    });
    context.setDefaultTimeout(10_000);
    context.setDefaultNavigationTimeout(20_000);
    const externalRequests = [];
    const consoleErrors = [];
    const attachPage = (page) => {
      page.on("pageerror", (error) => consoleErrors.push(`${page.url()}: ${error.message}`));
    };
    context.pages().forEach(attachPage);
    context.on("page", attachPage);
    await context.route(/^https?:\/\//, async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === LOCAL_ORIGIN) return route.continue();
      externalRequests.push(`${route.request().method()} ${url.href}`);
      return route.abort("blockedbyclient");
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    let lab;
    try {
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
      expect(worker.url()).toMatch(/^chrome-extension:\/\/[^/]+\//);
      const extensionId = new URL(worker.url()).hostname;
      await worker.evaluate(async () => {
        await chrome.storage.sync.set({
          "cx.settings.v1": {
            version: 4,
            locale: "en",
            activePresetId: "md-attachments",
            includeComments: true,
            includeHistory: true,
          },
        });
      });

      lab = new SandboxLab(context, testInfo, downloadsPath);
      await lab.resetData();
      const wikiPage = context.pages()[0] ?? (await context.newPage());
      const cdp = await context.newCDPSession(wikiPage);
      await cdp.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: downloadsPath,
        eventsEnabled: true,
      });
      lab.wiki = new SandboxUi(wikiPage, lab);
      await lab.wiki.open("1000");
      lab.sourceTabId = await worker.evaluate(
        async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id,
        wikiPage.url(),
      );
      expect(lab.sourceTabId).toBeGreaterThan(0);
      const extensionPage = await context.newPage();
      await extensionPage.goto(
        `chrome-extension://${extensionId}/${manifest.side_panel.default_path}?sourceTabId=${lab.sourceTabId}`,
      );
      lab.confx = new ConfxUi(extensionPage, lab);
      lab.opfs = new Opfs(extensionPage);
      await lab.confx.targetWiki();
      await expect(lab.confx.startButton).toBeEnabled();
      await expect(lab.confx.startButton).toHaveText("Start export");
      const capabilities = await extensionPage.evaluate(async () => ({
        id: chrome.runtime.id,
        manifestVersion: chrome.runtime.getManifest().manifest_version,
        scripting: typeof chrome.scripting.executeScript,
        downloads: typeof chrome.downloads.download,
        tabs: typeof chrome.tabs.query,
        localHostAllowed: await chrome.permissions.contains({ origins: ["http://127.0.0.1/*"] }),
      }));
      expect(capabilities).toMatchObject({
        id: extensionId,
        manifestVersion: 3,
        scripting: "function",
        downloads: "function",
        tabs: "function",
        localHostAllowed: true,
      });
      await testInfo.attach("real-chrome-capabilities", {
        body: JSON.stringify(capabilities, null, 2),
        contentType: "application/json",
      });
      await use(lab);
      expect(externalRequests, "Only the local Lorem server may receive browser requests").toEqual(
        [],
      );
      expect(consoleErrors, "Neither real UI may throw uncaught browser errors").toEqual([]);
    } finally {
      const failed = testInfo.status !== testInfo.expectedStatus;
      if (lab) {
        await testInfo.attach("sandbox-request-log", {
          body: JSON.stringify(await lab.logs(), null, 2),
          contentType: "application/json",
        });
      }
      const pages = context.pages();
      const videos = pages.map((page) => page.video()).filter(Boolean);
      if (failed) {
        for (const [index, page] of pages.entries()) {
          if (page.isClosed()) continue;
          await testInfo.attach(`browser-${index}`, {
            body: await page.screenshot({ fullPage: true }),
            contentType: "image/png",
          });
        }
      }
      if (failed) {
        const path = testInfo.outputPath("trace.zip");
        await context.tracing.stop({ path });
        await testInfo.attach("trace", { path, contentType: "application/zip" });
      } else {
        await context.tracing.stop();
      }
      await context.close();
      if (failed) {
        for (const [index, video] of videos.entries()) {
          await testInfo.attach(`browser-video-${index}`, {
            path: await video.path(),
            contentType: "video/webm",
          });
        }
      } else {
        await rm(videoPath, { recursive: true, force: true });
      }
    }
  },
});

export { expect };

export class SandboxLab {
  constructor(context, testInfo, downloadsPath) {
    this.context = context;
    this.testInfo = testInfo;
    this.downloadsPath = downloadsPath;
  }

  captureConversions() {
    const pending = [];
    const listener = (response) => {
      const request = response.request();
      const url = new URL(response.url());
      if (
        url.origin !== LOCAL_ORIGIN ||
        request.method() !== "POST" ||
        !/^\/rest\/api\/contentbody\/convert\/(editor|storage)$/.test(url.pathname)
      )
        return;
      // Capture actual browser deliveries, not the deliberately clipped developer log.
      pending.push(
        response.json().then(
          (body) => ({
            path: url.pathname,
            status: response.status(),
            request: request.postDataJSON(),
            response: body,
          }),
          (error) => ({
            path: url.pathname,
            status: response.status(),
            responseError: error.message,
          }),
        ),
      );
    };
    this.context.on("response", listener);
    return async () => {
      this.context.off("response", listener);
      return Promise.all(pending);
    };
  }

  async json(path, options = {}) {
    const response = await this.context.request.fetch(LOCAL_ORIGIN + path, options);
    expect(response.ok(), `${options.method ?? "GET"} ${path}: ${await response.text()}`).toBe(
      true,
    );
    return response.json();
  }

  async resetData() {
    return this.json("/sandbox/api/reset", { method: "POST", data: { confirm: "reset-lorem" } });
  }

  async state() {
    return this.json("/sandbox/api/state");
  }

  async detail(id) {
    return this.json(`/sandbox/api/pages/${id}`);
  }

  async logs() {
    return (await this.json("/sandbox/api/logs")).entries;
  }

  async cursor() {
    return Math.max(0, ...(await this.logs()).map((entry) => entry.seq));
  }

  async logsAfter(cursor) {
    return (await this.logs()).filter((entry) => entry.seq > cursor);
  }

  async snapshot() {
    const state = await this.state();
    const details = await Promise.all(state.pages.map((page) => this.detail(page.id)));
    return { state, details };
  }
}

export class SandboxUi {
  constructor(page, lab) {
    this.page = page;
    this.lab = lab;
    this.content = page.locator("#main-content");
    this.body = page.frameLocator("#wysiwygTextarea_ifr").locator("body");
  }

  async open(id, edit = false) {
    this.id = id;
    await this.page.goto(
      `${LOCAL_ORIGIN}/pages/${edit ? "editpage" : "viewpage"}.action?pageId=${id}`,
    );
    await expect(this.content).toBeVisible();
    await expect(this.page.getByTestId("published-version")).toContainText(/\d+/);
    if (edit) await this.readyEditor();
    if (this.lab.confx) await this.lab.confx.targetWiki();
  }

  async readyEditor() {
    await this.page.waitForFunction(() => {
      const editor = window.tinymce?.get("wysiwygTextarea");
      const body = document.getElementById("wysiwygTextarea_ifr")?.contentDocument?.body;
      return Boolean(editor?.initialized && body && editor.getBody() === body);
    });
    await expect(this.body).toBeVisible();
    expect(await this.page.evaluate(() => String(window.tinymce.majorVersion))).toBe("8");
  }

  async nativeHtml() {
    await this.readyEditor();
    return this.page.evaluate(() =>
      window.tinymce.get("wysiwygTextarea").getContent({ format: "html" }),
    );
  }

  async appendNative(text) {
    await this.readyEditor();
    await this.body.locator("p").last().click();
    await this.body.press("ControlOrMeta+End");
    await this.body.press("Enter");
    await this.page.keyboard.insertText(text);
    await expect(this.body).toContainText(text);
    await expect
      .poll(() => this.page.evaluate(() => window.tinymce.get("wysiwygTextarea").isDirty()))
      .toBe(true);
  }

  async undo() {
    const undo = this.page.getByRole("button", { name: /^Undo(?:\s|$)/ });
    await expect(undo).toBeEnabled();
    await undo.click();
  }

  async source(kind, expected) {
    await this.page.locator("#snapshot-kind").selectOption(kind);
    await this.page.getByRole("button", { name: "Refresh snapshot", exact: true }).click();
    const source = this.page.locator("#snapshot-source");
    await expect.poll(() => source.textContent()).toBe(expected);
    return source.textContent();
  }

  async scenario(value) {
    const response = this.page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/sandbox/api/pages/${this.id}/scenario`),
    );
    await this.page.locator("#scenario").selectOption(value);
    await this.page.getByRole("button", { name: "Apply scenario", exact: true }).click();
    expect((await response).ok()).toBe(true);
    await expect(this.page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
  }

  async saveDraft() {
    const response = this.page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/sandbox/api/pages/${this.id}/draft`),
    );
    await this.page.getByRole("button", { name: "Save draft", exact: true }).click();
    expect((await response).status()).toBe(200);
    await expect(this.page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    expect((await this.lab.detail(this.id)).draft).not.toBeNull();
  }

  async discardDraft() {
    const dialog = this.page.waitForEvent("dialog");
    const response = this.page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url().endsWith(`/sandbox/api/pages/${this.id}/draft`),
    );
    const click = this.page.getByRole("button", { name: "Discard draft", exact: true }).click();
    const confirmation = await dialog;
    expect(confirmation.type()).toBe("confirm");
    await confirmation.accept();
    expect((await response).status()).toBe(200);
    await click;
    await expect(this.page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    expect((await this.lab.detail(this.id)).draft).toBeNull();
    expect(await this.page.evaluate(() => window.tinymce.get("wysiwygTextarea").isDirty())).toBe(
      false,
    );
  }

  async publish() {
    const response = this.page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().endsWith(`/rest/api/content/${this.id}`),
    );
    await this.page.getByRole("button", { name: "Publish", exact: true }).click();
    const published = await response;
    expect(published.status(), await published.text()).toBe(200);
    await expect(this.page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
  }

  async reset(accept) {
    const dialog = this.page.waitForEvent("dialog");
    const click = this.page.getByRole("button", { name: "Reset sandbox", exact: true }).click();
    const confirmation = await dialog;
    expect(confirmation.type()).toBe("confirm");
    if (accept) {
      const response = this.page.waitForResponse(
        (response) =>
          response.request().method() === "POST" && response.url().endsWith("/sandbox/api/reset"),
      );
      await confirmation.accept();
      expect((await response).ok()).toBe(true);
    } else {
      await confirmation.dismiss();
    }
    await click;
    await expect(this.page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
  }
}

// Real Origin Private File System access from the actual extension page.
// Every journey keeps production code on genuine FileSystemDirectoryHandle /
// FileSystemFileHandle / FileSystemWritableFileStream objects; only the native
// picker boundary is ever substituted by tests.
class Opfs {
  constructor(page) {
    this.page = page;
  }

  async resetParent(name) {
    return this.page.evaluate(async (parentName) => {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(parentName, { recursive: true }).catch(() => undefined);
      const parent = await root.getDirectoryHandle(parentName, { create: true });
      return parent.name;
    }, name);
  }

  async makeChildDir(parentName, childName) {
    return this.page.evaluate(
      async ([parentName, childDir]) => {
        const root = await navigator.storage.getDirectory();
        const parent = await root.getDirectoryHandle(parentName);
        const child = await parent.getDirectoryHandle(childDir, { create: true });
        return child.name;
      },
      [parentName, childName],
    );
  }

  async writeFile(parentName, path, bytesB64) {
    return this.page.evaluate(
      async ([parentName, entryPath, base64]) => {
        const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
        const root = await navigator.storage.getDirectory();
        let dir = await root.getDirectoryHandle(parentName);
        const segments = entryPath.split("/");
        const fileName = segments.pop();
        for (const segment of segments) {
          dir = await dir.getDirectoryHandle(segment, { create: true });
        }
        const file = await dir.getFileHandle(fileName, { create: true });
        const writable = await file.createWritable();
        await writable.write(bytes);
        await writable.close();
        return bytes.length;
      },
      [parentName, path, bytesB64],
    );
  }

  async ensureFile(parentName, fileName, bytesB64) {
    return this.writeFile(parentName, fileName, bytesB64);
  }

  async readFileB64(parentName, path) {
    return this.page.evaluate(
      async ([parentName, entryPath]) => {
        const root = await navigator.storage.getDirectory();
        let dir = await root.getDirectoryHandle(parentName);
        const segments = entryPath.split("/");
        const fileName = segments.pop();
        for (const segment of segments) {
          dir = await dir.getDirectoryHandle(segment);
        }
        const file = await dir.getFileHandle(fileName).catch(() => null);
        if (!file) return null;
        const bytes = new Uint8Array(await (await file.getFile()).arrayBuffer());
        let binary = "";
        const chunk = 0x8000;
        for (let index = 0; index < bytes.length; index += chunk) {
          binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
        }
        return btoa(binary);
      },
      [parentName, path],
    );
  }

  async listChildren(parentName) {
    return this.page.evaluate(async (parentName) => {
      const root = await navigator.storage.getDirectory();
      const parent = await root.getDirectoryHandle(parentName);
      const children = [];
      for await (const [name, handle] of parent.entries()) {
        children.push({ name, kind: handle.kind });
      }
      children.sort((left, right) => left.name.localeCompare(right.name));
      return children;
    }, parentName);
  }

  async snapshot(parentName) {
    return this.page.evaluate(async (parentName) => {
      const root = await navigator.storage.getDirectory();
      const parent = await root.getDirectoryHandle(parentName);
      const toBase64 = (bytes) => {
        let binary = "";
        const chunk = 0x8000;
        for (let index = 0; index < bytes.length; index += chunk) {
          binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
        }
        return btoa(binary);
      };
      const files = [];
      const walk = async (dir, prefix) => {
        for await (const [name, handle] of dir.entries()) {
          if (handle.kind === "directory") {
            await walk(handle, `${prefix}${name}/`);
            continue;
          }
          const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
          files.push({ path: `${prefix}${name}`, size: bytes.length, b64: toBase64(bytes) });
        }
      };
      await walk(parent, "");
      files.sort((left, right) => left.path.localeCompare(right.path));
      return files;
    }, parentName);
  }
}

export class ConfxUi {
  constructor(page, lab) {
    this.page = page;
    this.lab = lab;
    this.sections = page.getByRole("tablist", { name: "Primary section", exact: true });
    this.scopes = page.getByRole("tablist", { name: "Export scope", exact: true });
    this.startButton = page.locator("[data-export-start]");
    this.template = page.getByRole("combobox", { name: "Template", exact: true });
    this.sourceCard = page.locator(".cx-workspace-source");
    this.editor = page.locator('section[aria-label="Update page"]');
    this.applyButton = this.editor.getByRole("button", { name: "Apply to editor", exact: true });
    this.alert = this.editor.getByRole("alert");
  }

  forPage(page) {
    return new ConfxUi(page, this.lab);
  }

  sectionTab(label) {
    return this.sections.getByRole("tab", { name: label, exact: true });
  }

  scopeTab(label) {
    return this.scopes.getByRole("tab", { name: label, exact: true });
  }

  async selectSection(label) {
    const section = this.sectionTab(label);
    await section.click();
    await expect(section).toHaveAttribute("aria-selected", "true");
  }

  async selectScope(label) {
    await this.selectSection("Export");
    const scope = this.scopeTab(label);
    await scope.click();
    await expect(scope).toHaveAttribute("aria-selected", "true");
  }

  async targetWiki() {
    const identity = await this.lab.wiki.page.evaluate(
      () =>
        document.querySelector('meta[name="ajs-issue-key"]')?.getAttribute("content") ??
        document.querySelector('meta[name="ajs-page-title"]')?.getAttribute("content") ??
        document.title,
    );
    await expect(this.sourceCard.getByText(identity, { exact: true })).toBeVisible();
    await expect(
      this.sourceCard.getByText("Read access available", { exact: true }),
    ).toBeVisible();
  }

  async download(action, suffix) {
    const before = await this.page.evaluate(async () =>
      (await chrome.downloads.search({})).map((item) => item.id),
    );
    await action();
    let completed;
    await expect
      .poll(
        async () => {
          const items = await this.page.evaluate(async () =>
            chrome.downloads.search({ orderBy: ["-startTime"] }),
          );
          const item = items.find((item) => !before.includes(item.id));
          if (item?.state === "interrupted")
            throw new Error(`Real chrome.downloads failed: ${item.error}`);
          if (item?.state === "complete") completed = item;
          return item?.state;
        },
        { message: "The actual extension download must complete", timeout: 45_000 },
      )
      .toBe("complete");
    expect(completed.filename).toMatch(new RegExp(`${suffix.replaceAll(".", "\\.")}$`));
    const path = completed.filename;
    expect(isAbsolute(path)).toBe(true);
    const withinDownloads = relative(this.lab.downloadsPath, path);
    expect(
      withinDownloads.startsWith("..") || isAbsolute(withinDownloads),
      "Chrome must honor the isolated download directory",
    ).toBe(false);
    await this.lab.testInfo.attach(basename(path), {
      path,
      contentType: suffix === ".zip" ? "application/zip" : "text/markdown",
    });
    return { path, text: suffix === ".zip" ? undefined : await readFile(path, "utf8") };
  }

  async exportNative() {
    await this.targetWiki();
    await this.selectSection("Update page");
    return this.download(
      () => this.page.getByRole("button", { name: "Export editable MD", exact: true }).click(),
      ".md",
    );
  }

  async exportPage() {
    await this.targetWiki();
    await this.selectScope("Page");
    await this.selectDestination("Download ZIP");
    await expect(this.startButton).toBeEnabled();
    return readDownloadedArchive(
      await this.download(() => this.startButton.click(), ".zip"),
    );
  }

  async exportSubtree() {
    await this.targetWiki();
    await this.selectScope("Subtree");
    await this.selectDestination("Download ZIP");
    await expect(this.startButton).toBeEnabled();
    return readDownloadedArchive(
      await this.download(() => this.startButton.click(), ".zip"),
    );
  }

  async selectSubtreeRoot(pageId) {
    const sourceUrl = this.lab.wiki.page.url();
    const title = (await this.lab.detail(pageId)).page.title;
    await this.selectScope("Subtree");
    const root = this.page.getByRole("button", { name: title, exact: true });
    await root.click();
    await expect(root).toHaveAttribute("aria-pressed", "true");
    await expect(this.page.locator(`[data-export-root="${pageId}"]`)).toContainText(title);
    expect(this.lab.wiki.page.url(), "Choosing an export root never navigates the source").toBe(
      sourceUrl,
    );
  }

  destinationControl(label) {
    return this.page.getByRole("radio", { name: label, exact: true });
  }

  async selectDestination(label) {
    const radio = this.destinationControl(label);
    await expect(radio).toBeEnabled();
    await radio.check();
    await expect(radio).toBeChecked();
    return radio;
  }

  async selectTemplate(label) {
    await expect(this.template).toHaveCount(1);
    await this.template.click();
    await this.page.getByRole("option", { name: label, exact: true }).click();
    await expect(this.template).toContainText(label);
  }

  async pickFragment(block) {
    await this.selectScope("Fragment");
    await this.page.getByRole("button", { name: "Start picker on page", exact: true }).click();
    await expect(this.lab.wiki.page.locator("html")).toHaveClass(/cx-picker-active/);
    await block.hover();
    await block.click();
    await expect(this.lab.wiki.page.locator("html")).not.toHaveClass(/cx-picker-active/);
    await expect(this.startButton).toBeEnabled();
  }

  /**
   * Replace only directory selection for both disk destinations with a genuine
   * OPFS parent. Production creates every child directory, ZIP and writable.
   * onPrepared observes the job UUID and root hint; it never supplies filenames.
   */
  async installExportPickers(parentName, options = {}) {
    return this.page.evaluate(
      ([parent, immediateDirectory]) => {
        window.__confxLastPrepared = null;
        window.__confxPickerParent = parent;
        const obtainParent = async () => {
          const root = await navigator.storage.getDirectory();
          return root.getDirectoryHandle(parent, { create: true });
        };
        const pickers = {
          onPrepared: (info) => {
            window.__confxLastPrepared = { ...info };
          },
        };
        if (immediateDirectory) {
          pickers.directory = obtainParent;
        } else {
          pickers.directory = () =>
            new Promise((resolve) => {
              window.__confxPickerResolve = resolve;
            });
        }
        window.__confxExportPickers = pickers;
      },
      [parentName, options.deferDirectory !== true],
    );
  }

  async lastPrepared() {
    return this.page.evaluate(() => globalThis.__confxLastPrepared ?? null);
  }

  async resolveDeferredDirectoryPicker() {
    return this.page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getDirectoryHandle(globalThis.__confxPickerParent, {
        create: true,
      });
      globalThis.__confxPickerResolve(handle);
    });
  }

  async loadMarkdown(text, name = "edited.md") {
    await this.targetWiki();
    await this.selectSection("Update page");
    const path = this.lab.testInfo.outputPath(name);
    await writeFile(path, text, "utf8");
    await this.lab.testInfo.attach(name, { path, contentType: "text/markdown" });
    await this.page.locator("#editor-markdown").setInputFiles(path);
  }

  async loadReady(text) {
    await this.loadMarkdown(text);
    await expect(this.applyButton).toBeEnabled();
    await expect(this.alert).toHaveCount(0);
    const changes = this.page
      .locator("details")
      .filter({ has: this.page.locator("ins") })
      .locator("summary");
    await changes.click();
  }

  async confirmApply() {
    await this.applyButton.click();
    const group = this.page.getByRole("group", { name: "Confirm applying changes", exact: true });
    await expect(group).toBeVisible();
    await group.getByRole("button", { name: "Confirm changes", exact: true }).click();
  }
}
