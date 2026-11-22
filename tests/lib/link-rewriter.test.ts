import { marked } from "marked";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfluenceApi } from "@/lib/confluence-api";
import { extractFromHtml } from "@/lib/extractor";
import { makeLinkRewriter } from "@/lib/link-rewriter";

const host = "https://wiki.example.test/wiki";
const folders = new Map([
  ["100", "root"],
  ["200", "root/child"],
]);

function rewriter() {
  return makeLinkRewriter({ host, currentFolder: "root", pageIdToFolder: folders });
}

describe("portable links in Confluence archives", () => {
  afterEach(() => vi.restoreAllMocks());

  it("exports portable online links even when local page-link rewriting is disabled", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network disabled"));
    const api = new ConfluenceApi(host, { maxRetries: 0 });
    const page = await extractFromHtml(
      api,
      '<p><a href="/wiki/pages/viewpage.action?pageId=200#details">Child online</a></p>',
      {
        id: "100",
        title: "Root",
        spaceKey: "DOC",
        baseUrl: host,
        url: `${host}/pages/viewpage.action?pageId=100`,
        version: 1,
      },
      {
        rules: [],
        folder: "root",
        pageIdToFolder: folders,
        rewriteLinks: false,
        includeFrontMatter: false,
        exportImages: false,
        exportAttachments: false,
        includeComments: false,
        includeHistory: false,
      },
    );
    const document = new DOMParser().parseFromString(
      marked.parse(page.markdown, { async: false }),
      "text/html",
    );
    expect(document.querySelector("a")?.getAttribute("href")).toBe(
      "https://wiki.example.test/wiki/pages/viewpage.action?pageId=200#details",
    );
  });

  it("keeps included child pages navigable locally with their anchors", () => {
    expect(rewriter()("/wiki/pages/viewpage.action?pageId=200#details", "Child")).toBe(
      "child/index.md#details",
    );
  });

  it("uses an absolute online URL for an omitted page instead of a filesystem-root destination", () => {
    expect(
      rewriter()("/wiki/pages/viewpage.action?pageId=300&preview=true#details", "Other page"),
    ).toBe("https://wiki.example.test/wiki/pages/viewpage.action?pageId=300&preview=true#details");
  });

  it("resolves context-relative online destinations within the Confluence base path", () => {
    expect(rewriter()("pages/viewpage.action?pageId=300", "Other page")).toBe(
      "https://wiki.example.test/wiki/pages/viewpage.action?pageId=300",
    );
  });

  it("does not change mail links, page anchors or external HTTPS destinations", () => {
    const rewrite = rewriter();
    expect(rewrite("#section", "Section")).toBe("#section");
    expect(rewrite("mailto:team@example.test", "Team")).toBe("mailto:team@example.test");
    expect(rewrite("https://outside.example.test/page?x=1#section", "Outside")).toBe(
      "https://outside.example.test/page?x=1#section",
    );
  });

  it("keeps downloaded attachments local while making unavailable downloads online", () => {
    const rewrite = makeLinkRewriter({
      host,
      currentFolder: "root",
      pageIdToFolder: folders,
      attachmentLinks: new Map([
        ["/wiki/download/attachments/100/kept.txt", "root/attachments/kept.txt"],
      ]),
    });
    expect(rewrite("/wiki/download/attachments/100/kept.txt", "Kept")).toBe("attachments/kept.txt");
    expect(rewrite("/wiki/download/attachments/100/missing.txt", "Online")).toBe(
      "https://wiki.example.test/wiki/download/attachments/100/missing.txt",
    );
  });

  it("does not guess an unavailable attachment from another page's basename", () => {
    const rewrite = makeLinkRewriter({
      host,
      currentFolder: "root",
      attachmentLinks: new Map([
        ["/wiki/download/attachments/100/report.pdf", "root/attachments/report.pdf"],
        ["/wiki/download/attachments/200/report.pdf", "root/child/attachments/report.pdf"],
      ]),
    });
    expect(rewrite("/wiki/download/attachments/300/report.pdf", "Missing")).toBe(
      "https://wiki.example.test/wiki/download/attachments/300/report.pdf",
    );
    expect(rewrite("/wiki/download/attachments/100/report.pdf.backup", "Different")).toBe(
      "https://wiki.example.test/wiki/download/attachments/100/report.pdf.backup",
    );
  });

  it("matches normalized URL and resource identity without losing attachment fragments", () => {
    const rewrite = makeLinkRewriter({
      host,
      currentFolder: "root/child",
      attachmentLinks: new Map([
        ["/wiki/download/attachments/100/Lorem%20report.pdf?version=1&api=v2", "root/attachments/report.pdf"],
      ]),
    });
    expect(rewrite("/wiki/download/attachments/100/Lorem%20report.pdf?api=v2&version=1#page=2", "Report")).toBe(
      "../attachments/report.pdf#page=2",
    );
    expect(rewrite("/wiki/download/attachments/100/Lorem%20report.pdf?version=2&api=v2", "Other version")).toBe(
      "https://wiki.example.test/wiki/download/attachments/100/Lorem%20report.pdf?version=2&api=v2",
    );
  });

  it("does not rewrite ambiguous normalized resource identities or data URIs", () => {
    const rewrite = makeLinkRewriter({
      host,
      currentFolder: "root",
      attachmentLinks: new Map([
        ["/wiki/download/attachments/100/a%20b.pdf", "root/attachments/first.pdf"],
        ["https://wiki.example.test/wiki/download/attachments/100/a b.pdf", "root/attachments/second.pdf"],
      ]),
    });
    expect(rewrite("/wiki/download/attachments/100/a%20b.pdf", "Ambiguous")).toBe(
      "https://wiki.example.test/wiki/download/attachments/100/a%20b.pdf",
    );
    expect(rewrite("data:text/plain;base64,bG9yZW0=", "Inline")).toBe("data:text/plain;base64,bG9yZW0=");
  });
});
