import { readFile } from "node:fs/promises";
import { test, expect } from "./fixtures.mjs";
import { LOCAL_ORIGIN } from "./origin.mjs";
import { marked } from "marked";
import { CATALOG, OPAQUE_CDATA, OPAQUE_MACRO_ID } from "./expectations.mjs";
import {
  expectLocalMarkdownTargets,
  expectReadOnlyConversions,
  readEditableArtifact,
  readDownloadedArchive,
  readZipArchive,
} from "./artifacts.mjs";

async function expectPageArchive(archive, specimen, published, context) {
  const page = archive.manifest.pages.find((page) => page.id === specimen.id);
  expect(page, `The actual exporter includes page ${specimen.id}`).toBeDefined();
  expect(page).toMatchObject({
    title: specimen.title,
    version: published.page.version,
    space: "LOREM",
    editable: { status: "available", representation: "storage", version: published.page.version },
  });
  const markdown = archive.text(page.archive_path);
  expect(markdown).toContain(`# ${specimen.title}`);
  for (const text of specimen.text) expect(markdown).toContain(text);
  expect(markdown).not.toContain("confx:storage-markdown");
  const editable = readEditableArtifact(archive.text(page.editable.path), "storage");
  expect(editable.metadata).toMatchObject({
    host: LOCAL_ORIGIN,
    pageId: specimen.id,
    title: specimen.title,
    version: published.page.version,
    sourceHash: page.editable.source_hash,
  });
  expect(
    editable.source,
    "Archived source is the exact public API source, not the rendered projection",
  ).toBe(published.published.storage);
  if (specimen.id === "1400") {
    for (const literal of [
      "const lorem = `<Lorem>`;",
      '{"lorem":"ipsum"}',
      "lorem: ipsum",
      "<lorem>ipsum</lorem>",
      "SELECT lorem FROM ipsum",
    ])
      expect(markdown).toContain(literal);
    expect(markdown).toMatch(/```(?:javascript|js)\n/);
    expect(markdown).toMatch(/```(?:java)\n/);
  }
  if (specimen.id === "1300") {
    const reading = await context.newPage();
    try {
      await reading.setContent(marked.parse(markdown, { gfm: true, async: false }));
      const tables = reading.getByRole("table");
      await expect(tables).toHaveCount(3);
      for (const table of await tables.all()) await expect(table).toBeVisible();
      await expect(tables.nth(0).getByRole("row")).toHaveCount(3);
      await expect(tables.nth(0).getByRole("columnheader")).toHaveText([
        "Lorem key",
        "Lorem value",
      ]);
      await expect(tables.nth(0).getByRole("cell")).toHaveText([
        "ipsum",
        "dolor",
        "sit",
        "amet consectetur",
      ]);
      await expect(tables.nth(1).getByRole("columnheader")).toHaveText([
        "Lorem bold TD key",
        "Lorem bold TD value",
      ]);
      await expect(tables.nth(1).getByRole("cell")).toHaveText(["adipiscing", "elit"]);
      const flattened = tables.nth(2);
      await expect(flattened.getByRole("row")).toHaveCount(3);
      await expect(flattened.getByRole("columnheader")).toHaveText([
        "Lorem merged cell",
        "Lorem merged cell",
      ]);
      await expect(flattened.getByRole("cell")).toHaveCount(4);
      await expect(flattened.getByRole("row").nth(1).getByRole("cell")).toHaveText([
        "Lorem row span",
        "Lorem first row",
      ]);
      const finalRow = flattened.getByRole("row").nth(2).getByRole("cell");
      await expect(finalRow.nth(0)).toHaveText("Lorem row span");
      for (const text of [
        "Lorem multiline cell one",
        "Lorem multiline cell two",
        "Lorem line break",
        "Lorem preformatted cell",
        "ipsum",
      ])
        await expect(finalRow.nth(1)).toContainText(text);
    } finally {
      await reading.close();
    }
  }
  if (specimen.id === "1500") {
    expect(editable.source).toContain(`ac:macro-id="${OPAQUE_MACRO_ID}"`);
    expect(editable.source).toContain('ac:name="lorem-plugin"');
    expect(editable.source).toContain(OPAQUE_CDATA);
    expect(editable.markdown).toContain("Confx protected");
  }
  if (specimen.id === "1600") {
    expect(page.layout_outcome).toMatchObject({ status: "preserved", sections: 3 });
    for (const type of ["single", "two_equal", "three_equal"]) {
      expect(markdown).toContain(`<!-- confx:section:start type="${type}" -->`);
    }
    expect(markdown.match(/<!-- confx:cell:start -->/g)).toHaveLength(6);
  }
  if (specimen.id === "1800") {
    expect(markdown).not.toContain("loremEditor");
    expect(markdown).not.toContain("loremSession");
    expect(editable.source).toContain('{"loremEditor":{"collaboration":false,"seed":"ipsum"}}');
    expect(editable.source).toContain('{"loremSession":"synthetic-only"}');
  }
  return { page, markdown, editable };
}

test("real Confx single-page UI export downloads local assets without writing published content", async ({
  lab,
}) => {
  const specimen = CATALOG.find((page) => page.id === "1700");
  await lab.wiki.open(specimen.id);
  for (const text of specimen.text) await expect(lab.wiki.content).toContainText(text);
  await expect(lab.wiki.page.locator("#cx-open-md-btn")).toBeVisible();
  const before = await lab.detail(specimen.id);
  const cursor = await lab.cursor();
  const archive = await lab.confx.exportPage();
  expect(archive.manifest).toMatchObject({
    manifest_version: 2,
    type: "single-page",
    counts: { pages: 1 },
    failures: [],
  });
  expect(archive.manifest.pages).toHaveLength(1);
  await expectPageArchive(archive, specimen, before, lab.context);
  const after = await lab.detail(specimen.id);
  expect(after.published).toEqual(before.published);
  expect(after.page.version).toBe(before.page.version);
  expect(after.draft).toBeNull();
  expectReadOnlyConversions(await lab.logsAfter(cursor));
});

test("whole-subtree UI export includes every descendant, independent content and deduplicated local binary assets", async ({
  lab,
}) => {
  const initial = await lab.snapshot();
  expect(initial.state.pages.map((page) => page.id).sort()).toEqual(
    CATALOG.map((page) => page.id).sort(),
  );
  await lab.wiki.open("1000");
  const cursor = await lab.cursor();
  await lab.confx.selectSubtreeRoot("1000");
  const archive = await lab.confx.exportSubtree();
  expect(archive.manifest).toMatchObject({
    type: "subtree",
    counts: { pages: CATALOG.length },
    failures: [],
  });
  expect(archive.manifest.pages.map((page) => page.id).sort()).toEqual(
    CATALOG.map((page) => page.id).sort(),
  );
  for (const specimen of CATALOG) {
    const published = initial.details.find((detail) => detail.page.id === specimen.id);
    await expectPageArchive(archive, specimen, published, lab.context);
  }
  const nested = archive.manifest.pages.find((page) => page.id === "1710");
  expect(nested.parent_id).toBe("1700");
  expect(nested.ancestors.map((page) => page.id)).toEqual(["1000", "1700"]);
  const assetsPage = archive.manifest.pages.find((page) => page.id === "1700");
  const assetsMarkdown = archive.text(assetsPage.archive_path);
  expect(assetsMarkdown).toContain("mailto:lorem@example.invalid");
  expect(assetsMarkdown).toContain(
    `[Lorem nested link](${LOCAL_ORIGIN}/pages/viewpage.action?pageId=1710)`,
  );
  expect(assetsMarkdown).toContain("Lorem image caption");
  expect(assetsMarkdown).toContain("![Lorem local image](");
  expect(assetsMarkdown).not.toMatch(/!\[[^\]]*\]\(https?:/);
  // Reader Markdown uses package paths; editable sidecars retain source identities.
  const localLinks = expectLocalMarkdownTargets(archive, [
    ...archive.manifest.pages.map((page) => page.archive_path),
    "README.md",
  ]);
  expect(localLinks).toContainEqual(
    expect.objectContaining({
      from: nested.archive_path,
      target: assetsPage.archive_path,
      kind: "link",
    }),
  );
  expect(localLinks.some((link) => link.kind === "image")).toBe(true);

  const entries = Object.entries(archive.entries);
  const pngs = entries.filter(([name]) => name.endsWith(".png"));
  expect(
    pngs,
    "Repeated images and attachment references share the same archived bytes",
  ).toHaveLength(1);
  expect([...pngs[0][1].slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const json = entries.filter(([name]) => name.endsWith("/lorem.json"));
  const csv = entries.filter(([name]) => name.endsWith("/lorem.csv"));
  const pdf = entries.filter(([name]) => name.endsWith("/lorem.pdf"));
  expect(json).toHaveLength(1);
  expect(csv).toHaveLength(1);
  expect(pdf).toHaveLength(1);
  expect(JSON.parse(Buffer.from(json[0][1]).toString("utf8"))).toEqual({
    lorem: "ipsum",
    count: 3,
    visible: true,
  });
  expect(Buffer.from(csv[0][1]).toString("utf8")).toContain("lorem,ipsum");
  expect(Buffer.from(pdf[0][1]).toString("ascii").startsWith("%PDF-")).toBe(true);
  const comments = entries.filter(([name]) => name.endsWith("/comments.json"));
  const history = entries.filter(([name]) => name.endsWith("/history.json"));
  expect(comments).toHaveLength(1);
  const exportedComments = JSON.parse(Buffer.from(comments[0][1]).toString("utf8"));
  expect(exportedComments.comments).toEqual([
    expect.objectContaining({
      id: "27001",
      body: "<p>Lorem comment by a synthetic author.</p>",
      markdown: "Lorem comment by a synthetic author.",
    }),
  ]);
  expect(exportedComments.inlineComments).toEqual([
    expect.objectContaining({
      id: "37001",
      body: "<p>Lorem inline comment.</p>",
      selection: "Lorem asset specimen",
      markerRef: "lorem-inline-001",
      status: "open",
      replies: [expect.objectContaining({ id: "37002", body: "<p>Lorem inline reply.</p>" })],
    }),
  ]);
  expect(history).toHaveLength(CATALOG.length);
  for (const exportedPage of archive.manifest.pages) {
    const historyPath = exportedPage.archive_path.replace(/[^/]+$/, "history.json");
    expect(JSON.parse(archive.text(historyPath))).toEqual([
      expect.objectContaining({ number: exportedPage.version, message: "Lorem initial specimen" }),
    ]);
  }
  const after = await lab.snapshot();
  expect(after.details).toEqual(initial.details);
  expectReadOnlyConversions(await lab.logsAfter(cursor));
});

test("the Space scope exports every Lorem page through the composer without changing the source", async ({
  lab,
}) => {
  const before = await lab.snapshot();
  await lab.confx.selectScope("Space");
  await lab.confx.page.locator("#space-label-filter").fill("");
  await lab.confx.page.locator("#space-prefix-filter").fill("");
  await lab.confx.selectTemplate("Markdown + attachments");
  await lab.confx.selectDestination("Download ZIP");
  await expect(lab.confx.startButton).toBeEnabled();
  const cursor = await lab.cursor();
  const downloaded = await lab.confx.download(() => lab.confx.startButton.click(), ".zip");
  const zip = readZipArchive(await readFile(downloaded.path));
  const archive = { ...zip, manifest: JSON.parse(zip.text("space-manifest.json")) };
  expect(archive.manifest).toMatchObject({
    type: "space",
    source: { host: LOCAL_ORIGIN, space: "LOREM" },
    counts: {
      pages: CATALOG.length,
      requested_pages: CATALOG.length,
      exported_pages: CATALOG.length,
      skipped_pages: 0,
    },
    failures: [],
  });
  expect(archive.manifest.pages.map((page) => page.id).sort()).toEqual(
    CATALOG.map((page) => page.id).sort(),
  );
  for (const specimen of CATALOG) {
    const original = before.details.find((detail) => detail.page.id === specimen.id);
    await expectPageArchive(archive, specimen, original, lab.context);
  }
  expectLocalMarkdownTargets(archive, archive.manifest.pages.map((page) => page.archive_path));
  expect((await lab.snapshot()).details).toEqual(before.details);
  expectReadOnlyConversions(await lab.logsAfter(cursor));
});

test("the Fragment scope exports only the block chosen with the real page picker and never offers an editable sidecar", async ({
  lab,
}) => {
  const specimen = CATALOG.find((page) => page.id === "1700");
  await lab.wiki.open(specimen.id);
  const before = await lab.detail(specimen.id);
  const savedDefaults = await lab.confx.page.evaluate(async () =>
    chrome.storage.sync.get("cx.settings.v1"),
  );
  await lab.confx.selectScope("Fragment");
  await lab.confx.selectTemplate("Markdown + attachments");
  await lab.confx.selectDestination("Download ZIP");
  await expect(lab.confx.startButton).toBeDisabled();
  for (const name of [
    "Editable Markdown sidecar",
    "File attachments",
    "Page comments",
    "Version history",
  ]) {
    const control = lab.confx.page.getByRole("switch", { name, exact: true });
    await expect(control).toBeVisible();
    await expect(control).toBeDisabled();
    await expect(control).toHaveAttribute("aria-checked", "false");
  }
  await lab.confx.page.getByText("Conversion and rules", { exact: true }).click();
  const fragmentPageLinks = lab.confx.page.getByRole("switch", { name: "Rewrite internal links", exact: true });
  await expect(fragmentPageLinks).toBeDisabled();
  await expect(fragmentPageLinks).toHaveAttribute("aria-checked", "false");
  const cursor = await lab.cursor();
  await lab.confx.pickFragment(
    lab.wiki.content.getByRole("heading", { name: specimen.title, exact: true }),
  );
  const archive = await readDownloadedArchive(
    await lab.confx.download(() => lab.confx.startButton.click(), ".zip"),
  );
  expect(archive.manifest).toMatchObject({
    type: "block",
    counts: { pages: 1, images: 0, attachments: 0 },
    failures: [],
  });
  expect(archive.manifest.pages).toMatchObject([
    {
      id: specimen.id,
      editable: { status: "unavailable", reason: "partial-export" },
    },
  ]);
  expect(archive.text("index.md")).toContain(`# ${specimen.title}`);
  expect(archive.text("index.md")).not.toContain("Lorem asset specimen");
  expect(archive.text("index.md")).not.toContain("Lorem comment by a synthetic author.");
  expect(Object.keys(archive.entries).sort()).toEqual(
    ["index.md", "manifest.json"].map((path) => archive.root + path).sort(),
  );
  expect(
    await lab.confx.page.evaluate(async () => chrome.storage.sync.get("cx.settings.v1")),
    "Fragment capability masks never overwrite the saved true companion preferences",
  ).toEqual(savedDefaults);
  await lab.confx.page.getByRole("button", { name: "Clear selected fragment", exact: true }).click();
  await expect(lab.confx.startButton).toBeDisabled();
  expect(await lab.detail(specimen.id)).toEqual(before);
  expectReadOnlyConversions(await lab.logsAfter(cursor));
});
