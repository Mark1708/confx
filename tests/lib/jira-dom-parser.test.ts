import { marked } from "marked";
import { describe, expect, it } from "vitest";
import {
  isJiraPage,
  parseJiraDescription,
  parseJiraIssueFromHtml,
} from "../../src/lib/jira-dom-parser";
import { readFixtureText } from "../fixtures/fixture-loader";

const BASE_URL = "https://jira.example";

async function loadJiraFixtureMeta() {
  const html = await readFixtureText("jira-issue.html");
  const meta = parseJiraIssueFromHtml(html, BASE_URL);

  expect(meta).not.toBeNull();

  if (meta === null) {
    throw new Error("Authored Jira fixture should parse");
  }

  return meta;
}

describe("isJiraPage", () => {
  it("recognizes an issue marker in the authored Jira shell", async () => {
    const html = await readFixtureText("jira-issue.html");
    expect(isJiraPage(html)).toBe(true);
  });

  it("rejects HTML without an issue marker", () => {
    expect(isJiraPage("<html><body>Lorem ipsum</body></html>")).toBe(false);
  });

  it("rejects empty input", () => {
    expect(isJiraPage("")).toBe(false);
  });
});

describe("parseJiraIssueFromHtml", () => {
  it.each([
    "<html><body>Lorem ipsum</body></html>",
    '<meta name="ajs-issue-key" content=""><h1 id="summary-val">Lorem</h1>',
  ])("rejects HTML without a nonempty issue identity: %s", (html) => {
    expect(parseJiraIssueFromHtml(html, BASE_URL)).toBeNull();
  });

  it("derives project and canonical issue URL from the issue identity", async () => {
    const meta = await loadJiraFixtureMeta();

    expect(meta.key).toBe("LOR-12");
    expect(meta.project).toBe("LOR");
    expect(meta.baseUrl).toBe(BASE_URL);
    expect(meta.url).toBe(`${BASE_URL}/browse/LOR-12`);
  });

  it("preserves separate label, component, version and epic collections", async () => {
    const meta = await loadJiraFixtureMeta();

    expect(meta.labels).toEqual(["lorem", "ipsum", "dolor"]);
    expect(meta.components).toEqual(["Lorem component", "Ipsum component"]);
    expect(meta.versions).toEqual(["lorem-1"]);
    expect(meta.fixVersions).toEqual(["ipsum-2"]);
    expect(meta.epicLink).toBe("LOR-1");
  });

  it("normalizes summary whitespace and excludes controls around the status lozenge", () => {
    const meta = parseJiraIssueFromHtml(
      `<meta name="ajs-issue-key" content="LOR-12">
       <h1 id="summary-val"> Lorem\n  ipsum <span>dolor</span> </h1>
       <div id="status-val">Lorem chrome <span class="jira-issue-status-lozenge"> Lorem\n ready </span></div>`,
      BASE_URL,
    );

    expect(meta?.summary).toBe("Lorem ipsum dolor");
    expect(meta?.status).toBe("Lorem ready");
  });

  it("prefers type and priority icon alternatives over surrounding text", () => {
    const meta = parseJiraIssueFromHtml(
      `<meta name="ajs-issue-key" content="LOR-12">
       <div id="type-val">Lorem chrome<img alt="Lorem type"></div>
       <div id="priority-val">Ipsum chrome<img alt="Lorem priority"></div>`,
      BASE_URL,
    );

    expect(meta?.type).toBe("Lorem type");
    expect(meta?.priority).toBe("Lorem priority");
  });

  it("accepts text-only type and priority without requiring image assets", async () => {
    const meta = await loadJiraFixtureMeta();

    expect(meta.type).toBe("Lorem type");
    expect(meta.priority).toBe("Lorem priority");
  });

  it("uses date attributes instead of display text", async () => {
    const meta = await loadJiraFixtureMeta();

    expect(meta.created).toBe("2026-01-01T00:00:00Z");
    expect(meta.updated).toBe("2026-01-02T00:00:00Z");
    expect(meta.dueDate).toBe("2026-02-01");
  });

  it("retains a text date when no machine-readable attribute is available", () => {
    const meta = parseJiraIssueFromHtml(
      `<meta name="ajs-issue-key" content="LOR-12">
       <span id="created-val"> 2026-01-03 </span>`,
      BASE_URL,
    );

    expect(meta?.created).toBe("2026-01-03");
  });

  it.each([
    ["unresolved", null],
    ["", "Lorem resolution"],
  ])("distinguishes unresolved state from resolution text: %s", (className, resolution) => {
    const meta = parseJiraIssueFromHtml(
      `<meta name="ajs-issue-key" content="LOR-12">
       <div id="resolution-val" class="${className}"> Lorem\n resolution </div>`,
      BASE_URL,
    );

    expect(meta?.resolution).toBe(resolution);
  });
});

describe("parseJiraDescription", () => {
  it("converts only description content into structured Markdown", async () => {
    const html = await readFixtureText("jira-issue.html");
    const markdown = parseJiraDescription(html);
    const rendered = new DOMParser().parseFromString(
      marked.parse(markdown, { async: false }),
      "text/html",
    );

    expect(rendered.querySelectorAll("h2")).toHaveLength(1);
    expect(rendered.querySelector("strong")?.textContent).toBe("ipsum");
    expect(rendered.querySelector("em")?.textContent).toBe("dolor");
    expect(rendered.querySelector("a")?.getAttribute("href")).toBe(
      "https://wiki.example/pages/viewpage.action?pageId=1300",
    );
    expect(rendered.querySelectorAll("ul > li")).toHaveLength(2);
    expect(rendered.querySelectorAll("table thead th")).toHaveLength(2);
    expect(rendered.querySelectorAll("table tbody tr")).toHaveLength(1);
    expect(rendered.querySelector("pre code.language-json")?.textContent?.trim()).toBe(
      '{"lorem":"ipsum"}',
    );
    expect(markdown).not.toContain("Lorem issue chrome");
    expect(markdown).not.toContain("Lorem ipsum dolor");
    expect(markdown).not.toContain("Lorem component");
  });

  it.each(["<html><body>Lorem ipsum</body></html>", '<div id="description-val"> \n </div>'])(
    "returns no Markdown when description content is unavailable: %s",
    (html) => {
      expect(parseJiraDescription(html)).toBe("");
    },
  );
});
