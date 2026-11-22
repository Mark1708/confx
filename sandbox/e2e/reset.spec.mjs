import { test, expect } from "./fixtures.mjs";
import { LOCAL_ORIGIN } from "./origin.mjs";
import { conversions, draftWrites, publishWrites, successfulWrites } from "./artifacts.mjs";

function withGeneration(snapshot, generation) {
  return snapshot.details.map((detail) => ({ ...detail, generation }));
}

test("reset confirmation is meaningful, restores every seed and advances generation without clearing the monotonic request log", async ({
  lab,
}) => {
  const seed = await lab.snapshot();
  const cursor = await lab.cursor();
  await lab.wiki.open("1100", true);
  await lab.wiki.appendNative("Lorem draft that only reset discards");
  await lab.wiki.saveDraft();
  await lab.wiki.open("1500", true);
  await lab.wiki.appendNative("Lorem explicitly published reset specimen");
  await lab.wiki.publish();
  await lab.wiki.open("1700", true);
  await lab.wiki.scenario("published-newer");
  await lab.wiki.appendNative("Lorem native-only reset specimen");
  const nativeBeforeReset = await lab.wiki.nativeHtml();
  const changed = await lab.snapshot();
  expect(changed.details.find((detail) => detail.page.id === "1100").draft.storage).toContain(
    "Lorem draft that only reset discards",
  );
  expect(changed.details.find((detail) => detail.page.id === "1500").published.storage).toContain(
    "Lorem explicitly published reset specimen",
  );
  expect(changed.details.find((detail) => detail.page.id === "1700").scenario).toBe(
    "published-newer",
  );

  const cancelCursor = await lab.cursor();
  await lab.wiki.reset(false);
  expect(await lab.snapshot()).toEqual(changed);
  expect(await lab.wiki.nativeHtml()).toBe(nativeBeforeReset);
  expect(successfulWrites(await lab.logsAfter(cancelCursor))).toEqual([]);

  await lab.wiki.reset(true);
  const restored = await lab.snapshot();
  expect(restored.state.generation).toBe(seed.state.generation + 1);
  expect(restored.state.pages).toEqual(seed.state.pages);
  expect(restored.details).toEqual(withGeneration(seed, restored.state.generation));
  await lab.wiki.open("1700", true);
  await expect(lab.wiki.body).toContainText("Lorem asset specimen");
  await expect(lab.wiki.body).not.toContainText("Lorem native-only reset specimen");
  await expect(lab.wiki.content).not.toContainText("Lorem newer published revision.");

  const log = await lab.logsAfter(cursor);
  const resetWrites = successfulWrites(log).filter((entry) => entry.path === "/sandbox/api/reset");
  expect(resetWrites).toHaveLength(1);
  expect(resetWrites[0]).toMatchObject({ kind: "reset", method: "POST", status: 200 });
  expect(draftWrites(log)).toHaveLength(1);
  expect(draftWrites(log)[0]).toMatchObject({ kind: "draft", status: 200 });
  expect(publishWrites(log)).toHaveLength(1);
  expect(publishWrites(log)[0]).toMatchObject({ kind: "publish", status: 200 });
  const seq = log.map((entry) => entry.seq);
  expect(seq).toEqual([...seq].sort((left, right) => left - right));
  expect(new Set(seq).size).toBe(seq.length);
  expect(resetWrites[0].seq).toBeGreaterThan(cancelCursor);
  for (const entry of conversions(log)) expect(entry.kind).toBe("conversion");
  for (const entry of log) expect(Number.isNaN(Date.parse(entry.at))).toBe(false);
  const afterResetWrites = successfulWrites(log).filter((entry) => entry.seq > resetWrites[0].seq);
  expect(
    afterResetWrites,
    "Reloading clean native content must not autosave or publish after reset",
  ).toEqual([]);
  await lab.wiki.page.getByRole("button", { name: "Refresh snapshot", exact: true }).click();
  await expect(lab.wiki.page.locator("#request-log")).toContainText("/sandbox/api/reset");
});

test("reset in a second real tab invalidates stale draft and publish attempts without losing the stale native edits", async ({
  lab,
}) => {
  await lab.wiki.open("1100", true);
  const seed = await lab.detail("1100");
  const staleText = "Lorem stale native edits remain available for recovery";
  await lab.wiki.appendNative(staleText);
  const staleNative = await lab.wiki.nativeHtml();

  const resetPage = await lab.context.newPage();
  await resetPage.goto(`${LOCAL_ORIGIN}/pages/viewpage.action?pageId=1000`);
  await expect(resetPage.getByTestId("published-version")).toBeVisible();
  const dialogPromise = resetPage.waitForEvent("dialog");
  const responsePromise = resetPage.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith("/sandbox/api/reset"),
  );
  const click = resetPage.getByRole("button", { name: "Reset sandbox", exact: true }).click();
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe("confirm");
  await dialog.accept();
  const resetResponse = await responsePromise;
  expect(resetResponse.ok()).toBe(true);
  const { generation } = await resetResponse.json();
  expect(generation).toBe(seed.generation + 1);
  await click;
  const cursor = await lab.cursor();

  await lab.wiki.page.bringToFront();
  const draftResponsePromise = lab.wiki.page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/sandbox/api/pages/1100/draft"),
  );
  await lab.wiki.page.getByRole("button", { name: "Save draft", exact: true }).click();
  expect((await draftResponsePromise).status()).toBe(409);
  expect(await lab.wiki.nativeHtml()).toBe(staleNative);
  expect(await lab.detail("1100")).toEqual({ ...seed, generation });

  const publishResponsePromise = lab.wiki.page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" && response.url().endsWith("/rest/api/content/1100"),
  );
  await lab.wiki.page.getByRole("button", { name: "Publish", exact: true }).click();
  expect((await publishResponsePromise).status()).toBe(409);
  await expect(lab.wiki.body).toContainText(staleText);
  expect(await lab.wiki.nativeHtml()).toBe(staleNative);
  expect(await lab.detail("1100")).toEqual({ ...seed, generation });
  const log = await lab.logsAfter(cursor);
  expect(draftWrites(log)).toHaveLength(1);
  expect(draftWrites(log)[0].status).toBe(409);
  expect(publishWrites(log)).toHaveLength(1);
  expect(publishWrites(log)[0].status).toBe(409);
  expect(successfulWrites(log).every((entry) => conversions([entry]).length === 1)).toBe(true);
});
