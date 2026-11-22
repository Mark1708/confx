import { expect, test } from "./fixtures.mjs";
import { LOCAL_ORIGIN } from "./origin.mjs";

async function openLauncherOptions(lab) {
  const opened = lab.context.waitForEvent("page");
  await lab.confx.page.getByRole("button", { name: "Settings", exact: true }).click();
  const page = await opened;
  await expect(page).toHaveURL(/\/options\/index\.html(?:[?#]|$)/);
  await page.getByRole("link", { name: "Page launcher", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Show button on Confluence pages", exact: true })).toBeVisible();
  return page;
}

async function navigateSpa(page, pageId) {
  await page.evaluate((id) => {
    history.pushState({}, "", `/pages/viewpage.action?pageId=${id}`);
    document.querySelector('meta[name="ajs-page-id"]').content = id;
    const notice = document.createElement("p");
    notice.textContent = "Lorem SPA navigation";
    document.querySelector("main").append(notice);
  }, pageId);
}

test("launcher drag snaps, persists, and remains in the viewport after resize", async ({ lab }) => {
  const page = lab.wiki.page;
  const launcher = page.locator("#cx-open-md-btn");
  await expect(launcher).toBeVisible();
  const initial = await launcher.boundingBox();
  expect(initial.width).toBeLessThanOrEqual(40);
  expect(initial.height).toBeLessThanOrEqual(40);
  expect(initial.y).toBeGreaterThan(page.viewportSize().height / 2);
  await page.mouse.move(initial.x + initial.width / 2, initial.y + initial.height / 2);
  await page.mouse.down();
  await page.mouse.move(32, 260, { steps: 15 });
  await page.mouse.up();
  await expect.poll(async () => (await launcher.boundingBox()).x).toBe(12);
  const options = await openLauncherOptions(lab);
  await expect.poll(() => options.evaluate(async (origin) => {
    const data = await chrome.storage.local.get("cx.launcher.v1");
    return data["cx.launcher.v1"]?.[`${origin}|confluence`]?.edge;
  }, LOCAL_ORIGIN)).toBe("left");
  await page.setViewportSize({ width: 400, height: 300 });
  await expect.poll(async () => {
    const box = await launcher.boundingBox();
    return box.x >= 12 && box.x + box.width <= 388 && box.y >= 12 && box.y + box.height <= 288;
  }).toBe(true);
  await navigateSpa(page, "1100");
  await expect(launcher).toHaveCount(1);
  await expect(launcher).toBeVisible();
  await page.reload();
  await expect.poll(async () => (await launcher.boundingBox())?.x).toBe(12);
});

test("site hiding survives SPA and restores from live options without affecting toolbar access", async ({ lab }) => {
  const page = lab.wiki.page;
  const launcher = page.locator("#cx-open-md-btn");
  await expect(launcher).toBeVisible();
  await launcher.focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Hide on this site", exact: true }).click();
  await expect(launcher).toHaveCount(0);
  await navigateSpa(page, "1100");
  await expect(launcher).toHaveCount(0);
  const options = await openLauncherOptions(lab);
  const site = options.getByRole("group", { name: `${LOCAL_ORIGIN} · Confluence`, exact: true });
  await site.getByRole("button", { name: "Restore launcher", exact: true }).click();
  await expect(launcher).toBeVisible();
  const global = options.getByRole("switch", { name: "Show button on Confluence pages", exact: true });
  await global.click();
  await expect(launcher).toHaveCount(0);
  await global.click();
  await expect(launcher).toBeVisible();
  await launcher.focus();
  await page.keyboard.press("Shift+F10");
  await page.keyboard.press("Escape");
  await expect(launcher).toBeFocused();
  await launcher.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Hide until tab reload", exact: true }).click();
  await navigateSpa(page, "1200");
  await expect(launcher).toHaveCount(0);
  await site.getByRole("button", { name: "Reset site settings", exact: true }).click();
  await expect(launcher).toHaveCount(0);
  await expect(lab.confx.page.getByRole("button", { name: "Open workspace tab", exact: true })).toBeEnabled();
  await page.reload();
  await expect(launcher).toBeVisible();
});
