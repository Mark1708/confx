import { test, expect } from "./fixtures.mjs";
import { LOCAL_ORIGIN } from "./origin.mjs";

test("section changes and a second UI preserve one cancellable export owner", async ({ lab }) => {
  const owner = lab.confx.page;
  const held = Promise.withResolvers();
  const release = Promise.withResolvers();
  const routed = Promise.withResolvers();
  let aborted = false;
  let intercepted = false;
  const isBodyRead = (request) => {
    const url = new URL(request.url());
    return (
      url.origin === LOCAL_ORIGIN &&
      url.pathname === "/rest/api/content/1000" &&
      (url.searchParams.get("expand") ?? "").includes("body.view")
    );
  };
  const failed = (request) => {
    if (isBodyRead(request) && /ABORTED/i.test(request.failure()?.errorText ?? "")) aborted = true;
  };
  owner.on("requestfailed", failed);
  const routeRead = async (route) => {
    const paused = !intercepted && isBodyRead(route.request());
    try {
      if (paused) {
        intercepted = true;
        held.resolve();
        await release.promise;
      }
      if (!/ABORTED/i.test(route.request().failure()?.errorText ?? "")) {
        if (paused) await route.continue();
        else await route.fallback();
      }
    } finally {
      if (paused) routed.resolve();
    }
  };
  await owner.route("**/rest/api/content/**", routeRead);
  try {
    const downloadsBefore = await owner.evaluate(async () =>
      (await chrome.downloads.search({})).map((item) => item.id),
    );
    const ownerId = await owner.evaluate(async () => (await chrome.tabs.getCurrent()).id);
    const sourceId = await owner.evaluate(
      async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id,
      lab.wiki.page.url(),
    );
    await lab.confx.startButton.click();
    await held.promise;
    await expect(owner.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
    await lab.confx.selectSection("Watch");
    await expect(owner.getByRole("button", { name: "Cancel", exact: true })).toBeVisible({
      timeout: 2000,
    });

    const ownerUrl = owner.url();
    const ownerDocument = await owner.evaluate(() => performance.timeOrigin);
    const opened = lab.context.waitForEvent("page");
    await owner.getByRole("button", { name: "Open workspace tab", exact: true }).click();
    const foreign = await opened;
    const foreignUi = lab.confx.forPage(foreign);
    await foreignUi.selectScope("Page");
    await expect(foreign.getByRole("button", { name: "Go to job", exact: true })).toBeVisible();
    await expect(foreign.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
    await expect(foreignUi.startButton).toBeDisabled();
    expect(new URL(foreign.url()).searchParams.get("sourceTabId")).toBe(String(sourceId));
    expect(await foreign.evaluate(async () => (await chrome.tabs.getCurrent()).id)).not.toBe(ownerId);
    expect(owner.url()).toBe(ownerUrl);
    expect(await owner.evaluate(() => performance.timeOrigin)).toBe(ownerDocument);
    await foreign.getByRole("button", { name: "Go to job", exact: true }).click();
    await expect
      .poll(() =>
        foreign.evaluate(
          async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id,
        ),
      )
      .toBe(ownerId);

    await owner.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect
      .poll(() => aborted, { message: "Owner cancellation must abort the held real fetch" })
      .toBe(true);
    await expect(owner.getByText("Export cancelled", { exact: true })).toBeVisible();
    expect(
      await owner.evaluate(async () => (await chrome.downloads.search({})).map((item) => item.id)),
    ).toEqual(downloadsBefore);
  } finally {
    release.resolve();
    if (intercepted) await routed.promise;
    owner.off("requestfailed", failed);
    await owner.unroute("**/rest/api/content/**", routeRead);
  }
});

test("closing the real owner releases its lock and reports interruption instead of resuming or offering foreign cancel", async ({
  lab,
}) => {
  const owner = lab.confx.page;
  const held = Promise.withResolvers();
  const release = Promise.withResolvers();
  const routed = Promise.withResolvers();
  let intercepted = false;
  const routeRead = async (route) => {
    const url = new URL(route.request().url());
    const pause =
      !intercepted &&
      url.origin === LOCAL_ORIGIN &&
      url.pathname === "/rest/api/content/1000" &&
      (url.searchParams.get("expand") ?? "").includes("body.view");
    if (!pause) {
      await route.fallback();
      return;
    }
    intercepted = true;
    held.resolve();
    try {
      await release.promise;
      if (!owner.isClosed() && !/ABORTED/i.test(route.request().failure()?.errorText ?? "")) {
        await route.continue();
      }
    } finally {
      routed.resolve();
    }
  };
  await owner.route("**/rest/api/content/**", routeRead);
  try {
    await lab.confx.startButton.click();
    await held.promise;
    const foreign = await lab.context.newPage();
    await foreign.goto(owner.url());
    const foreignUi = lab.confx.forPage(foreign);
    await foreignUi.selectSection("Export");
    await expect(foreign.getByRole("button", { name: "Go to job", exact: true })).toBeVisible();
    await owner.close();
    await expect(foreign.getByText("Export interrupted", { exact: true })).toBeVisible();
    await expect(foreign.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
    await expect(foreign.getByRole("button", { name: "Go to job", exact: true })).toHaveCount(0);
    await expect(foreignUi.startButton).toBeEnabled();
    expect(await foreign.evaluate(async () => chrome.downloads.search({}))).toEqual([]);
    const archive = await foreignUi.exportPage();
    expect(archive.manifest.pages.map((page) => page.id)).toEqual(["1000"]);
  } finally {
    release.resolve();
    if (intercepted) await routed.promise;
    if (!owner.isClosed()) await owner.unroute("**/rest/api/content/**", routeRead);
  }
});
