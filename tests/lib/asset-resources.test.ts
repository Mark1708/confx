import { webcrypto } from "node:crypto";
import { marked } from "marked";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAttachments } from "../../src/lib/attachment-fetcher";
import { commentsToJson, fetchCommentAttachments } from "../../src/lib/comment-fetcher";
import type { ConfluenceApi } from "../../src/lib/confluence-api";
import { AssetRegistry } from "../../src/lib/export/asset-registry";
import { extractFromHtml } from "../../src/lib/extractor";
import { fetchImagesFromHtml } from "../../src/lib/image-fetcher";
import { fetchPlantUmlAssetsFromHtml } from "../../src/lib/plantuml-assets";
import type { AttachmentInfo, ConfluencePageMeta, ExtractedComment } from "../../src/types";

const host = "https://wiki.example.test/wiki";
const meta: ConfluencePageMeta = { id: "100", title: "Lorem", baseUrl: host, url: `${host}/pages/viewpage.action?pageId=100`, spaceKey: "LOREM" };
const PLANTUML = "https://www.plantuml.com/plantuml/uml/SyfFKj2rKt3CoKnELR1Io4ZDoSa70000";

function api(overrides: Partial<ConfluenceApi> = {}): ConfluenceApi {
  return { host, getAttachments: vi.fn().mockResolvedValue([]), fetchBlob: vi.fn().mockResolvedValue(new Blob(["same"], { type: "image/png" })), ...overrides } as unknown as ConfluenceApi;
}
function info(path: string, title = "report.pdf"): AttachmentInfo {
  return { id: path, title, mediaType: "application/pdf", fileSize: 4, downloadPath: path, containerId: "100" };
}
function dom(markdown: string): Document {
  return new DOMParser().parseFromString(marked.parse(markdown, { async: false }), "text/html");
}
function target(folder: string, href: string): string {
  return new URL(href, `https://archive.example/${folder}/index.md`).pathname.slice(1);
}

beforeAll(() => vi.stubGlobal("crypto", webcrypto));
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => vi.restoreAllMocks());

describe("canonical resource links and physical entries", () => {
  it("resolves later page image and attachment references to the first written physical entry", async () => {
    const assets = new AssetRegistry(true);
    assets.protectPage("lorem"); assets.protectPage("ipsum");
    const firstAttempt = assets.beginPage("lorem");
    const first = await extractFromHtml(
      api({ getAttachments: vi.fn().mockResolvedValue([info("/wiki/download/attachments/100/report.pdf")]) }),
      '<img src="/wiki/download/attachments/100/shared.png" alt="First" /><a href="/wiki/download/attachments/100/report.pdf">Report</a>',
      meta,
      { rules: [], folder: "lorem", assets: firstAttempt },
    );
    const entries = new Set([...first.images, ...first.attachments].map((entry) => entry.archivePath));
    expect(entries).toEqual(new Set(["lorem/images/shared.png", "lorem/attachments/report.pdf"]));
    firstAttempt.commit();
    const secondAttempt = assets.beginPage("ipsum");
    const second = await extractFromHtml(api({ getAttachments: vi.fn().mockResolvedValue([info("/wiki/download/attachments/200/shared.png", "shared.png")]) }), '<img src="/wiki/download/attachments/200/image.png" alt="Second" /><a href="/wiki/download/attachments/200/shared.png">Shared</a>', { ...meta, id: "200" }, { rules: [], folder: "ipsum", assets: secondAttempt });
    expect(second.images).toEqual([]);
    expect(second.attachments).toEqual([]);
    const rendered = dom(second.markdown);
    expect(rendered.querySelector("img")?.getAttribute("src")).toBe("../lorem/images/shared.png");
    expect(Array.from(rendered.querySelectorAll("a")).find((node) => node.textContent === "Shared")?.getAttribute("href")).toBe("../lorem/attachments/report.pdf");
    for (const node of rendered.querySelectorAll("img[src],a[href]")) {
      const href = node.getAttribute("src") ?? node.getAttribute("href")!;
      if (/^[a-z][a-z\d+.-]*:/i.test(href)) continue;
      expect(entries.has(target("ipsum", href))).toBe(true);
    }
  });

  it("shares generic image and attachment bytes only when normalized extensions also match", async () => {
    const assets = new AssetRegistry(true);
    const first = assets.beginPage("lorem");
    const image = await fetchImagesFromHtml('<img src="/image.png" />', api(), "lorem/images", first);
    first.commit();
    const second = await fetchAttachments("200", api({ getAttachments: vi.fn().mockResolvedValue([{ ...info("/same.png", "same.png"), mediaType: "application/octet-stream" }]) }), { folder: "ipsum/attachments", assets: assets.beginPage("ipsum") });
    expect(second.attachments).toEqual([]);
    expect(second.references[0].archivePath).toBe(image.images[0].archivePath);
    expect(second.linkToArchive.get("/same.png")).toBe("lorem/images/image.png");
  });

  it("keeps image-type attachment links online when image export is disabled but attachments stay enabled", async () => {
    const source = api({
      getAttachments: vi.fn().mockResolvedValue([
        { ...info("/wiki/download/attachments/100/shot.png", "shot.png"), mediaType: "image/png" },
      ]),
    });
    const page = await extractFromHtml(
      source,
      '<a href="/wiki/download/attachments/100/shot.png">Shot</a>',
      meta,
      {
        rules: [],
        folder: "lorem",
        exportImages: false,
        exportAttachments: true,
        includeFrontMatter: false,
      },
    );
    expect(page.attachments).toEqual([]);
    expect(page.images).toEqual([]);
    expect(dom(page.markdown).querySelector("a")?.getAttribute("href")).toBe(
      `${new URL(host).origin}/wiki/download/attachments/100/shot.png`,
    );
  });

  it("keeps differing bytes with the same basename and links each exact URL to its bytes", async () => {
    const source = api({ fetchBlob: vi.fn().mockImplementation(async (path: string) => new Blob([path], { type: "image/png" })) });
    const page = await extractFromHtml(source, '<img src="/a/shared.png" alt="A" /><img src="/b/shared.png" alt="B" />', meta, { rules: [], folder: "lorem", exportAttachments: false });
    expect(page.images).toHaveLength(2);
    expect(new Set(page.images.map((image) => image.archivePath)).size).toBe(2);
    const rendered = dom(page.markdown);
    for (const image of page.images) {
      const label = image.sourceUrl.startsWith("/a/") ? "A" : "B";
      const href = rendered.querySelector(`img[alt="${label}"]`)!.getAttribute("src")!;
      expect(target("lorem", href)).toBe(image.archivePath);
      expect(await image.blob.text()).toBe(image.sourceUrl);
    }
  });

  it("does not inherit discarded source-attempt dedup targets", async () => {
    const assets = new AssetRegistry(true);
    const abandoned = assets.beginPage("lorem");
    await fetchImagesFromHtml('<img src="/shared.png" />', api(), "lorem/images", abandoned);
    abandoned.discard();
    const retry = await fetchImagesFromHtml('<img src="/shared.png" />', api(), "ipsum/images", assets.beginPage("ipsum"));
    expect(retry.images.map((image) => image.archivePath)).toEqual(["ipsum/images/shared.png"]);
    expect(retry.srcToArchive.get("/shared.png")).toBe("ipsum/images/shared.png");
  });

  it("keeps dedup-disabled cross-page entries separate and references their own files", async () => {
    const assets = new AssetRegistry(false);
    const firstPage = assets.beginPage("lorem");
    const first = await fetchImagesFromHtml('<img src="/shared.png" />', api(), "lorem/images", firstPage);
    firstPage.commit();
    const second = await fetchImagesFromHtml('<img src="/shared.png" />', api(), "ipsum/images", assets.beginPage("ipsum"));
    expect(first.images.map((image) => image.archivePath)).toEqual(["lorem/images/shared.png"]);
    expect(second.images.map((image) => image.archivePath)).toEqual(["ipsum/images/shared.png"]);
    expect(second.srcToArchive.get("/shared.png")).toBe(second.images[0].archivePath);
  });

  it("never registers inline data as an archived path or changes its authored data URI", async () => {
    const source = api();
    const data = "DATA:image/png;base64,iVBORw0KGgo=";
    const html = `<img src="${data}" alt="Inline" />`;
    const resources = await fetchImagesFromHtml(html, source, "lorem/images");
    expect(resources.images).toEqual([]);
    expect(resources.srcToArchive.size).toBe(0);
    const page = await extractFromHtml(source, html, meta, {
      rules: [], folder: "lorem", exportAttachments: false,
    });
    expect(dom(page.markdown).querySelector("img")?.getAttribute("src")).toBe(data);
    expect(source.fetchBlob).not.toHaveBeenCalled();
  });

  it("stops comment-owner resource work after cancellation instead of returning success", async () => {
    const controller = new AbortController();
    const comments: ExtractedComment[] = ["a", "b"].map((id) => ({
      id, author: "Lorem", createdAt: "", body: "", markdown: "", attachments: [],
    }));
    const source = api({
      getAttachments: vi.fn().mockImplementation(async (id: string) => [info(`/attachment/${id}`)]),
      fetchBlob: vi.fn().mockImplementation(async () => {
        controller.abort();
        return new Blob(["cancelled"]);
      }),
    });
    await expect(fetchCommentAttachments(comments, [], source, {
      pageId: "100", folder: "lorem", signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(source.getAttachments).toHaveBeenCalledOnce();
    expect(source.fetchBlob).toHaveBeenCalledOnce();
  });

  it("retains failed and oversized attachment links online and inline image data unchanged", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const source = api({ getAttachments: vi.fn().mockResolvedValue([info("/wiki/download/attachments/100/failed.pdf"), { ...info("/wiki/download/attachments/100/large.pdf"), fileSize: 100 }]), fetchBlob: vi.fn().mockRejectedValue(new Error("resource unavailable")) });
    const data = "data:image/png;base64,iVBORw0KGgo=";
    const page = await extractFromHtml(source, `<a href="/wiki/download/attachments/100/failed.pdf">Failed</a><a href="/wiki/download/attachments/100/large.pdf">Large</a><img src="${data}" alt="Inline" />`, meta, { rules: [], folder: "lorem", maxAttachmentSize: 10 });
    const rendered = dom(page.markdown);
    expect(Array.from(rendered.querySelectorAll("a")).filter((node) => node.textContent === "Failed" || node.textContent === "Large").map((node) => node.getAttribute("href"))).toEqual([`${new URL(host).origin}/wiki/download/attachments/100/failed.pdf`, `${new URL(host).origin}/wiki/download/attachments/100/large.pdf`]);
    expect(rendered.querySelector("img")?.getAttribute("src")).toBe(data);
    expect(page.attachments).toEqual([]);
    expect(page.images).toEqual([]);
  });

  it("preserves comment ownership, includes page folder once, and serializes the published zipPath field", async () => {
    const assets = new AssetRegistry(true);
    const comments: ExtractedComment[] = ["a", "b"].map((id) => ({ id, author: "Lorem", createdAt: "", body: "<p>Lorem</p>", markdown: "Lorem", attachments: [] }));
    const result = await fetchCommentAttachments(comments, [], api({ getAttachments: vi.fn().mockImplementation(async (id: string) => [info(`/wiki/download/attachments/${id}/report.pdf`)]) }), { pageId: "100", folder: "lorem", assets: assets.beginPage("lorem") });
    expect(result.attachments.map((entry) => entry.archivePath)).toEqual(["lorem/attachments/comments/a/report.pdf", "lorem/attachments/comments/b/report.pdf"]);
    const json = JSON.parse(commentsToJson(result.comments, [], "lorem"));
    expect(json.comments[0].attachments[0]).toMatchObject({ zipPath: "attachments/comments/a/report.pdf" });
    expect(json.comments[0].attachments[0]).not.toHaveProperty("archivePath");
  });

  it("retains each PlantUML png/source pair under its own page even for identical bytes", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } }));
    const assets = new AssetRegistry(true);
    const firstPage = assets.beginPage("lorem");
    const first = await fetchPlantUmlAssetsFromHtml(`<a href="${PLANTUML}">Diagram</a>`, { pageId: "100", folder: "lorem", assets: firstPage, maxAssetBytes: 1024 });
    firstPage.commit();
    const second = await fetchPlantUmlAssetsFromHtml(`<a href="${PLANTUML}">Diagram</a>`, { pageId: "200", folder: "ipsum", assets: assets.beginPage("ipsum"), maxAssetBytes: 1024 });
    expect(first.assets).toHaveLength(1); expect(second.assets).toHaveLength(1);
    for (const [folder, result] of [["lorem", first], ["ipsum", second]] as const) {
      expect(result.assets[0].png.archivePath.startsWith(`${folder}/attachments/linked/plantuml/`)).toBe(true);
      expect(result.assets[0].source.archivePath).toBe(result.assets[0].png.archivePath.replace(/\.png$/, ".puml"));
      expect(result.hrefToPng.get(PLANTUML)).toBe(result.assets[0].png.archivePath);
    }
  });

  it("throws image aborts across realms without fetching the next resource", async () => {
    const source = api({ fetchBlob: vi.fn().mockRejectedValue({ name: "AbortError" }) });
    await expect(fetchImagesFromHtml('<img src="/one.png" /><img src="/two.png" />', source, "lorem/images")).rejects.toMatchObject({ name: "AbortError" });
    expect(source.fetchBlob).toHaveBeenCalledOnce();
  });
});
