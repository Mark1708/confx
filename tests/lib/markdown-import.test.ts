import { strToU8, zipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildImportPlan,
  publishImportPlan,
  type ImportPagePlan,
  type ImportTarget,
} from "@/lib/markdown-import";
import { ApiError } from "@/types";
import type { ConfluenceApi, ConfluencePageRaw } from "@/lib/confluence-api";

const target: ImportTarget = {
  host: "https://wiki.example.com/wiki",
  spaceKey: "DEV",
  parentId: "100",
};

function file(path: string, content: string | Uint8Array, type = "text/markdown"): File {
  const f = new File([content], path.split("/").at(-1) ?? path, { type });
  Object.defineProperty(f, "webkitRelativePath", { value: path });
  return f;
}

function zipFile(entries: Record<string, string | Uint8Array>): File {
  const zipped = zipSync(
    Object.fromEntries(
      Object.entries(entries).map(([path, content]) => [
        path,
        typeof content === "string" ? strToU8(content) : content,
      ]),
    ),
  );
  return new File([zipped], "export.zip", { type: "application/zip" });
}

function createApi(overrides: Partial<ConfluenceApi> = {}): ConfluenceApi {
  return {
    host: target.host,
    getPage: vi.fn(async (id: string) => ({
      id,
      type: "page",
      status: "current",
      title: id === "200" ? "Root" : "Live",
      space: { key: "DEV" },
      version: { number: 4 },
      ancestors: [{ id: "100", title: "Parent" }],
      body: { storage: { value: "<p>Live</p>", representation: "storage" } },
    })),
    getChildren: vi.fn(async () => []),
    renderStorage: vi.fn(async (storage: string) => `<preview>${storage}</preview>`),
    createPage: vi.fn(async (input: { title: string }) => ({
      id: input.title === "Child" ? "301" : "300",
      type: "page",
      status: "current",
      title: input.title,
      space: { key: "DEV" },
      version: { number: 1 },
    })),
    updatePage: vi.fn(async (input: { id: string; title: string; version: number }) => ({
      id: input.id,
      type: "page",
      status: "current",
      title: input.title,
      space: { key: "DEV" },
      version: { number: input.version },
      _links: { webui: `/pages/${input.id}` },
    })),
    url: vi.fn((path: string) => `${target.host}${path}`),
    fetchJson: vi.fn(async (path: string) =>
      String(path).includes("/rest/inlinecomments/") ? [] : { results: [] },
    ),
    getAttachments: vi.fn(async () => []),
    uploadAttachment: vi.fn(async () => []),
    ...overrides,
  } as unknown as ConfluenceApi;
}

const rootMarkdown = `---
title: Root
page_id: "200"
space: DEV
source_url: https://wiki.example.com/wiki/pages/viewpage.action?pageId=200
version: 4
---
# Root

[TOC]

See [Child](child/index.md) and [Guide](attachments/guide.pdf).

![Diagram](images/diagram.png)

[macro:children] <!-- generated tree -->{}

<!-- confx:comments:start -->

## Comments

metadata

<!-- confx:comments:end -->
`;

const childMarkdown = `---
title: Child
---
# Child

- [x] Done

\`\`\`ts
const value = 1;
\`\`\`
`;

const manifest = JSON.stringify({
  pages: [
    { id: "200", title: "Root", folder: "root" },
    { title: "Child", folder: "root/child" },
  ],
});

const directoryFiles = [
  file("export/manifest.json", manifest, "application/json"),
  file("export/root/index.md", rootMarkdown),
  file("export/root/child/index.md", childMarkdown),
  file("export/root/images/diagram.png", new Uint8Array([1, 2, 3]), "image/png"),
  file("export/root/attachments/guide.pdf", new Uint8Array([4, 5, 6]), "application/pdf"),
  file("export/root/comments.json", "[]", "application/json"),
];

describe("buildImportPlan", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes directory and ZIP ConfX trees to the same deterministic plan", async () => {
    const api = createApi();
    const fromDirectory = await buildImportPlan(directoryFiles, target, { maxAttachmentSize: 1024 }, api);
    const fromZip = await buildImportPlan(
      [
        zipFile({
          "export/manifest.json": manifest,
          "export/root/index.md": rootMarkdown,
          "export/root/child/index.md": childMarkdown,
          "export/root/images/diagram.png": new Uint8Array([1, 2, 3]),
          "export/root/attachments/guide.pdf": new Uint8Array([4, 5, 6]),
          "export/root/comments.json": "[]",
        }),
      ],
      target,
      { maxAttachmentSize: 1024 },
      api,
    );

    expect(fromDirectory.pages.map((page) => ({
      path: page.path,
      title: page.title,
      parentPath: page.parentPath,
      action: page.action,
      assets: page.assets.map((asset) => asset.attachmentName).sort(),
    }))).toEqual(fromZip.pages.map((page) => ({
      path: page.path,
      title: page.title,
      parentPath: page.parentPath,
      action: page.action,
      assets: page.assets.map((asset) => asset.attachmentName).sort(),
    })));
    expect(fromDirectory.pages[0]).toMatchObject({
      path: "root/index.md",
      title: "Root",
      source: { pageId: "200", version: 4 },
      action: "update",
      reviewedVersion: 4,
    });
    expect(fromDirectory.pages[1]).toMatchObject({
      path: "root/child/index.md",
      title: "Child",
      parentPath: "root/index.md",
      action: "create",
    });
    expect(fromDirectory.pages[0].storage).toContain('ac:name="toc"');
    expect(fromDirectory.pages[0].storage).toContain('ri:filename="diagram.png"');
    expect(fromDirectory.pages[0].storage).toContain('ri:filename="guide.pdf"');
    expect(fromDirectory.pages[0].storage).toContain('ac:name="children"');
    expect(fromDirectory.pages[0].storage).not.toContain("confx:comments:start");
    expect(fromDirectory.pages[0].storage).not.toContain("<hr");
    expect(fromDirectory.pages[1].storage).toContain('ac:task-list');
    expect(fromDirectory.pages[0].previewHtml).not.toContain("CONFX_PAGE_LINK");
    expect(fromDirectory.pages[0].previewHtml).toContain('ri:content-title="Child"');
    expect(fromDirectory.pages[1].storage).toContain('ac:name="code"');
    expect(fromDirectory.pages.every((page) => page.previewHtml.startsWith("<preview>"))).toBe(true);
  });

  it("treats loose Markdown files as ad-hoc creates", async () => {
    const api = createApi();

    const plan = await buildImportPlan(
      [file("Loose.md", "# Loose\n\nPlain text")],
      target,
      { maxAttachmentSize: 1024 },
      api,
    );

    expect(plan.pages).toHaveLength(1);
    expect(plan.pages[0]).toMatchObject({ path: "Loose.md", title: "Loose", action: "create" });
    expect(plan.pages[0].storage).toContain("Plain text");
  });

  it("blocks unsafe content, missing assets, duplicate titles, and stale source versions", async () => {
    const api = createApi({
      getChildren: vi.fn(async () => [{ id: "500", title: "Loose", type: "page", status: "current" }]),
      getPage: vi.fn(async () => ({
        id: "200",
        title: "Root",
        type: "page",
        status: "current",
        space: { key: "DEV" },
        version: { number: 5 },
      })),
    });

    const plan = await buildImportPlan(
      [
        file("Loose.md", "# Loose\n"),
        file("Unsafe.md", "# Unsafe\n\n<script>alert(1)</script>"),
        file("Missing.md", "# Missing\n\n![x](images/missing.png)"),
        file("Root.md", rootMarkdown),
      ],
      target,
      { maxAttachmentSize: 1024 },
      api,
    );

    expect(Object.fromEntries(plan.pages.map((page) => [page.title, page.action]))).toEqual({
      Loose: "blocked",
      Unsafe: "blocked",
      Missing: "blocked",
      Root: "blocked",
    });
    expect(plan.pages.flatMap((page) => page.errors).join("\n")).toContain("duplicate title");
    expect(plan.pages.flatMap((page) => page.errors).join("\n")).toContain("raw HTML");
    expect(plan.pages.flatMap((page) => page.errors).join("\n")).toContain("Missing asset");
    expect(plan.pages.flatMap((page) => page.errors).join("\n")).toContain("version mismatch");
  });

  it("blocks unsafe update identity and duplicate planned siblings", async () => {
    const api = createApi();
    const noHostUpdate = `---
title: Foreign
page_id: "200"
version: 4
---
# Foreign
`;
    const foreignManifest = JSON.stringify({
      source: { host: "https://other.example.com/wiki" },
      pages: [{ id: "200", title: "Foreign", folder: "foreign" }],
    });

    const foreignPlan = await buildImportPlan(
      [
        file("export/manifest.json", foreignManifest, "application/json"),
        file("export/foreign/index.md", noHostUpdate),
      ],
      target,
      { maxAttachmentSize: 1024 },
      api,
    );

    expect(foreignPlan.pages.find((page) => page.title === "Foreign")).toMatchObject({
      action: "blocked",
      errors: expect.arrayContaining([expect.stringContaining("source host mismatch")]),
    });

    const duplicatePlan = await buildImportPlan(
      [file("a.md", "# Same\n"), file("b.md", "# Same\n")],
      target,
      { maxAttachmentSize: 1024 },
      api,
    );

    expect(
      duplicatePlan.pages.filter((page) => page.title === "Same").every((page) => page.action === "blocked"),
    ).toBe(true);
    expect(duplicatePlan.pages.flatMap((page) => page.errors).join("\n")).toContain(
      "duplicate imported sibling title",
    );
  });

  it("uses space-manifest path mappings and blocks when sibling preflight fails", async () => {
    const spaceManifest = JSON.stringify({
      source: { host: target.host },
      pages: [{ id: "200", title: "Root", path: "space-root", version: 4 }],
    });

    await expect(
      buildImportPlan(
        [
          file("export/space-manifest.json", spaceManifest, "application/json"),
          file("export/space-root/index.md", rootMarkdown),
        ],
        target,
        { maxAttachmentSize: 1024 },
        createApi({
          getChildren: vi.fn(async () => {
            throw new Error("children unavailable");
          }),
        }),
      ),
    ).rejects.toThrow("children unavailable");

    const plan = await buildImportPlan(
      [
        file("export/space-manifest.json", spaceManifest, "application/json"),
        file("export/space-root/index.md", rootMarkdown),
      ],
      target,
      { maxAttachmentSize: 1024 },
      createApi(),
    );

    expect(plan.pages.map((page) => page.path)).toEqual(["space-root/index.md"]);
  });

  it("blocks new child titles that already exist under an imported update parent", async () => {
    const api = createApi({
      getChildren: vi.fn(async (pageId: string) =>
        pageId === "200"
          ? [{ id: "600", title: "Child", type: "page", status: "current" }]
          : [],
      ),
    });

    const plan = await buildImportPlan(directoryFiles, target, { maxAttachmentSize: 1024 }, api);

    expect(plan.pages.find((page) => page.title === "Child")).toMatchObject({
      action: "blocked",
      errors: expect.arrayContaining([expect.stringContaining("duplicate title under imported parent")]),
    });
  });

  it("rejects unsafe ZIP entries before planning", async () => {
    await expect(
      buildImportPlan(
        [zipFile({ "export/../evil.md": "# Evil" })],
        target,
        { maxAttachmentSize: 1024 },
        createApi(),
      ),
    ).rejects.toThrow("path traversal");

    await expect(
      buildImportPlan(
        [zipFile({ "export/big.bin": new Uint8Array(2_048) })],
        target,
        { maxAttachmentSize: 1024 },
        createApi(),
      ),
    ).rejects.toThrow("Attachment too large");
  });

  it("escapes attachment link CDATA terminators", async () => {
    const api = createApi();

    const plan = await buildImportPlan(
      [
        file("Doc.md", "# Doc\n\n[bad &#93;&#93;> label](file.bin)"),
        file("file.bin", new Uint8Array([1]), "application/octet-stream"),
      ],
      target,
      { maxAttachmentSize: 1024 },
      api,
    );

    expect(plan.pages[0].storage).toContain("]]]]><![CDATA[>");
  });

  it("allows intentional local renames with manifest baseline", async () => {
    const manifest = JSON.stringify({
      source: { host: target.host },
      pages: [{ id: "200", title: "Old Name", folder: "root", version: 4 }],
    });
    const renamedMarkdown = `---
title: New Name
page_id: "200"
version: 4
source_url: ${target.host}/pages/viewpage.action?pageId=200
---
# New Name
`;
    const livePage = {
      id: "200",
      type: "page",
      status: "current",
      title: "Old Name",
      space: { key: "DEV" },
      version: { number: 4 },
      ancestors: [{ id: "100", title: "Parent" }],
      body: { storage: { value: "<p>Old</p>", representation: "storage" } },
    };
    const api = createApi({ getPage: vi.fn(async () => livePage) });

    const plan = await buildImportPlan(
      [file("export/manifest.json", manifest, "application/json"), file("export/root/index.md", renamedMarkdown)],
      target,
      { maxAttachmentSize: 1024 },
      api,
    );

    expect(plan.pages[0]).toMatchObject({ action: "update", title: "New Name" });
    expect(plan.pages[0].errors).toEqual([]);
  });

  it("blocks pages renamed in Confluence after export", async () => {
    const manifest = JSON.stringify({
      source: { host: target.host },
      pages: [{ id: "200", title: "Old Name", folder: "root", version: 4 }],
    });
    const unchangedMarkdown = `---
title: Old Name
page_id: "200"
version: 4
source_url: ${target.host}/pages/viewpage.action?pageId=200
---
# Old Name
`;
    const api = createApi({
      getPage: vi.fn(async () => ({
        id: "200",
        type: "page",
        status: "current",
        title: "Renamed Remotely",
        space: { key: "DEV" },
        version: { number: 4 },
        ancestors: [{ id: "100", title: "Parent" }],
        body: { storage: { value: "<p>x</p>", representation: "storage" } },
      })),
    });

    const plan = await buildImportPlan(
      [file("export/manifest.json", manifest, "application/json"), file("export/root/index.md", unchangedMarkdown)],
      target,
      { maxAttachmentSize: 1024 },
      api,
    );

    expect(plan.pages[0].action).toBe("blocked");
    expect(plan.pages[0].errors.join("\n")).toContain('renamed in Confluence to "Renamed Remotely"');
  });

  it("blocks intentional renames colliding with live sibling titles", async () => {
    const manifest = JSON.stringify({
      source: { host: target.host },
      pages: [{ id: "200", title: "Old Name", folder: "root", version: 4 }],
    });
    const renamedMarkdown = `---
title: New Name
page_id: "200"
version: 4
source_url: ${target.host}/pages/viewpage.action?pageId=200
---
# New Name
`;
    const api = createApi({
      getPage: vi.fn(async () => ({
        id: "200",
        type: "page",
        status: "current",
        title: "Old Name",
        space: { key: "DEV" },
        version: { number: 4 },
        ancestors: [{ id: "100", title: "Parent" }],
        body: { storage: { value: "<p>Old</p>", representation: "storage" } },
      })),
      getChildren: vi.fn(async () => [{ id: "x", title: "New Name", type: "page", status: "current" }]),
    });

    const plan = await buildImportPlan(
      [file("export/manifest.json", manifest, "application/json"), file("export/root/index.md", renamedMarkdown)],
      target,
      { maxAttachmentSize: 1024 },
      api,
    );

    expect(plan.pages[0].action).toBe("blocked");
    expect(plan.pages[0].errors.join("\n")).toContain("duplicate title under live parent: New Name");
  });

  it("blocks updates of pages with open inline comments", async () => {
    const api = createApi({
      fetchJson: vi.fn(async () => [
        { id: 7, authorDisplayName: "A", body: "<p>x</p>", resolveProperties: { resolved: false } },
      ]),
    });

    const plan = await buildImportPlan(directoryFiles, target, { maxAttachmentSize: 1024 }, api);

    expect(plan.pages.find((page) => page.title === "Root")?.action).toBe("blocked");
    expect(plan.pages.find((page) => page.title === "Root")?.errors.join("\n")).toContain("open inline comment");
  });

  it("allows updates when inline comments are resolved", async () => {
    const api = createApi({
      fetchJson: vi.fn(async () => [
        { id: 7, authorDisplayName: "A", body: "<p>x</p>", resolveProperties: { resolved: true } },
      ]),
    });

    const plan = await buildImportPlan(directoryFiles, target, { maxAttachmentSize: 1024 }, api);

    expect(plan.pages.find((page) => page.title === "Root")?.action).toBe("update");
  });

  it("drops stray exporter snapshot paragraphs", async () => {
    const plan = await buildImportPlan(
      [file("T.md", "# T\n\nbody\n\n{}\n")],
      target,
      { maxAttachmentSize: 1024 },
      createApi(),
    );

    expect(plan.pages[0].storage).toContain("<p>body</p>");
    expect(plan.pages[0].storage).not.toContain("<p>{}</p>");
  });

  it("warns about unmarked legacy comment metadata without stripping authored body", async () => {
    const api = createApi();

    const plan = await buildImportPlan(
      [file("Legacy.md", "# Legacy\n\n## Comments\n\nAuthored text"), file("comments.json", "[]")],
      target,
      { maxAttachmentSize: 1024 },
      api,
    );

    expect(plan.pages[0].warnings.join("\n")).toContain("Legacy comments metadata");
    expect(plan.pages[0].storage).toContain("Authored text");
  });
});

describe("publishImportPlan", () => {
  it("creates shells, uploads assets, finalizes storage, and blocks publish-time conflicts", async () => {
    const api = createApi();
    const plan = await buildImportPlan(directoryFiles, target, { maxAttachmentSize: 1024 }, api);
    const conflicting: ImportPagePlan = {
      ...plan.pages[0],
      path: "conflict.md",
      title: "Conflict",
      source: { pageId: "999", version: 4 },
      reviewedVersion: 4,
      assets: [],
      action: "update",
    };
    vi.mocked(api.getPage).mockImplementation(async (id: string) => ({
      id,
      type: "page",
      status: "current",
      title: id === "999" ? "Conflict" : "Root",
      space: { key: "DEV" },
      version: { number: id === "999" ? 5 : 4 },
      ancestors: [{ id: "100", title: "Parent" }],
    }));

    const result = await publishImportPlan(
      { ...plan, pages: [plan.pages[0], plan.pages[1], conflicting] },
      new Set([plan.pages[0].path, plan.pages[1].path, conflicting.path]),
      api,
    );

    expect(vi.mocked(api.createPage)).toHaveBeenCalledWith(
      { title: "Child", spaceKey: "DEV", parentId: "200", storage: "<p></p>" },
      undefined,
    );
    expect(vi.mocked(api.uploadAttachment)).toHaveBeenCalledWith("200", expect.any(File), undefined);
    expect(vi.mocked(api.updatePage)).toHaveBeenCalledWith(
      expect.objectContaining({ id: "200", version: 5, title: "Root" }),
      undefined,
    );
    expect(vi.mocked(api.updatePage)).toHaveBeenCalledWith(
      expect.objectContaining({ id: "301", version: 2, title: "Child" }),
      undefined,
    );
    const rootUpdate = vi
      .mocked(api.updatePage)
      .mock.calls.find(([input]) => input.id === "200")?.[0];
    expect(rootUpdate?.storage).toContain('ri:content-id="301"');
    expect(vi.mocked(api.updatePage)).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "999" }),
      undefined,
    );
    expect(result.rows.find((row) => row.path === "conflict.md")).toMatchObject({
      status: "blocked",
      error: expect.stringContaining("version conflict"),
    });
  });
  it("reports PUT 409 conflicts as blocked rows", async () => {
    const api = createApi({
      updatePage: vi.fn(async () => {
        throw new ApiError("conflict", 409, "Conflict", "/rest/api/content/200");
      }),
    });
    const plan = await buildImportPlan(directoryFiles, target, { maxAttachmentSize: 1024 }, api);

    const result = await publishImportPlan({ ...plan, pages: [plan.pages[0]] }, new Set([plan.pages[0].path]), api);

    expect(result.rows[0]).toMatchObject({
      status: "blocked",
      error: expect.stringContaining("version conflict"),
    });
  });

  it("skips uploading attachments unchanged by name and size", async () => {
    const plan = await buildImportPlan(directoryFiles, target, { maxAttachmentSize: 1024 }, createApi());
    const api = createApi({
      getAttachments: vi.fn(async () => [
        {
          id: "a1",
          title: "diagram.png",
          mediaType: "image/png",
          fileSize: 3,
          downloadPath: "/download/attachments/200/diagram.png",
          containerId: "200",
        },
      ]),
    });

    const result = await publishImportPlan(
      plan,
      new Set(plan.pages.map((page) => page.path)),
      api,
    );

    expect(vi.mocked(api.getAttachments)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.uploadAttachment).mock.calls.map(([, file]) => file.name)).toEqual(["guide.pdf"]);
    expect(result.rows.find((row) => row.path === "root/index.md")).toMatchObject({ status: "updated" });
  });
});
