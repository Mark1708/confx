import { expect, test } from "./fixtures.mjs";

async function observers(worker) {
  return worker.evaluate(async () =>
    chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL("offscreen/icon-theme.html")],
    }),
  );
}

async function expectAcceptedIcon(worker, theme, palette) {
  await expect
    .poll(() => worker.evaluate(() => globalThis.__acceptedToolbarIcon))
    .toMatchObject({
      path: {
        20: `chrome-extension://${new URL(worker.url()).hostname}/assets/icons/${theme}-${palette}-20.png`,
      },
    });
}

test("real toolbar images follow every palette and visible System changes with all Confx UI closed", async ({
  lab,
}) => {
  const worker = lab.context.serviceWorkers()[0];
  // The receiver remains Chrome's real image fetch/decoder, never a fake API success.
  await worker.evaluate(() => {
    globalThis.__acceptedToolbarIcon = null;
    globalThis.__toolbarIconFailures = [];
    const setIcon = chrome.action.setIcon.bind(chrome.action);
    chrome.action.setIcon = async (details) => {
      try {
        await setIcon(details);
        globalThis.__acceptedToolbarIcon = details;
      } catch (error) {
        globalThis.__toolbarIconFailures.push(error.message);
        throw error;
      }
    };
  });
  expect(await observers(worker)).toEqual([]);
  const opened = lab.context.waitForEvent("page");
  await lab.confx.page.getByRole("button", { name: "Settings", exact: true }).click();
  const options = await opened;
  await options.getByRole("link", { name: "Appearance and language", exact: true }).click();
  for (const mode of ["light", "dark"]) {
    await options.locator(`input[name="cx-theme"][value="${mode}"]`).locator("..").click();
    for (const palette of ["violet", "blue", "forest", "graphite", "amber"]) {
      const radio = options.locator(`input[name="cx-palette"][value="${palette}"]`);
      await expect(radio).toBeEnabled();
      await radio.locator("..").click();
      await expectAcceptedIcon(worker, mode, palette);
    }
  }
  const system = options.locator('input[name="cx-theme"][value="system"]');
  await system.locator("..").click();
  await expect(system).toBeChecked();
  await expect(system).toBeEnabled();
  const mode = await options.locator("html").getAttribute("data-theme");
  await expectAcceptedIcon(worker, mode, "amber");
  await options.locator('input[name="cx-palette"][value="forest"]').locator("..").click();
  await expectAcceptedIcon(worker, mode, "forest");
  const settings = await worker.evaluate(
    async () => (await chrome.storage.sync.get("cx.settings.v1"))["cx.settings.v1"],
  );
  expect(settings.theme).toBe("system");
  expect(
    await observers(worker),
    "Initial offscreen sample must not persist as a fake live watcher",
  ).toEqual([]);
  const sourceUrl = lab.wiki.page.url();
  await options.close();
  await lab.confx.page.close();
  await lab.wiki.page.bringToFront();
  await expect.poll(() => lab.wiki.page.evaluate(() => document.visibilityState)).toBe("visible");
  expect(lab.context.pages()).toEqual([lab.wiki.page]);
  for (const scheme of ["light", "dark"]) {
    await lab.wiki.page.emulateMedia({ colorScheme: scheme });
    await expectAcceptedIcon(worker, scheme, "forest");
    expect(await observers(worker)).toEqual([]);
    expect(
      await worker.evaluate(
        async () => (await chrome.storage.sync.get("cx.settings.v1"))["cx.settings.v1"],
      ),
    ).toEqual(settings);
  }
  expect(lab.wiki.page.url()).toBe(sourceUrl);
  await worker.evaluate(async () => {
    const key = "cx.settings.v1";
    const stored = (await chrome.storage.sync.get(key))[key];
    await chrome.storage.sync.set({ [key]: { ...stored, theme: "light" } });
  });
  await expectAcceptedIcon(worker, "light", "forest");
  const session = await worker.evaluate(async () => chrome.storage.session.get(null));
  expect(
    Object.keys(session).filter(
      (key) => key === "cx.export.active.v2" || key.startsWith("cx.exportJob.v2:"),
    ),
  ).toEqual([]);
  expect(await worker.evaluate(() => globalThis.__toolbarIconFailures)).toEqual([]);
});
