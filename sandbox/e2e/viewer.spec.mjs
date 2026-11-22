import { test, expect } from "./fixtures.mjs";
import { LOCAL_ORIGIN } from "./origin.mjs";

test("the actual Markdown viewer loads online images without creating a pretend archive", async ({
  lab,
}) => {
  const viewer = await lab.context.newPage();
  const requests = [];
  viewer.on("request", (request) => {
    if (request.url().startsWith(`${LOCAL_ORIGIN}/`)) {
      requests.push({ url: request.url(), type: request.resourceType(), method: request.method() });
    }
  });
  const url = new URL("/src/viewer/index.html", lab.confx.page.url());
  url.searchParams.set("host", LOCAL_ORIGIN);
  url.searchParams.set("pageId", "1700");
  await viewer.goto(url.href);

  const image = viewer.getByRole("img", { name: "Lorem duplicate image", exact: true });
  await expect(image).toHaveAttribute("src", `${LOCAL_ORIGIN}/download/attachments/1700/lorem.png`);
  await expect
    .poll(() => image.evaluate((node) => node.complete && node.naturalWidth > 0))
    .toBe(true);
  await expect(
    viewer.getByRole("link", { name: "Lorem PDF attachment", exact: true }),
  ).toHaveAttribute("href", `${LOCAL_ORIGIN}/download/attachments/1700/lorem.pdf`);
  expect(
    requests.filter((request) => /\/child\/attachment|\/contentbody\/convert\//.test(request.url)),
  ).toEqual([]);
  expect(
    requests
      .filter((request) => request.url.includes("/download/attachments/"))
      .every((request) => request.type === "image"),
  ).toBe(true);
  expect(requests.every((request) => request.method === "GET")).toBe(true);
});
