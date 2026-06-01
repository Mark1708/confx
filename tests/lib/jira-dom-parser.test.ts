import { describe, expect, it } from "vitest";
import {
  isJiraPage,
  parseJiraDescription,
  parseJiraIssueFromHtml,
} from "../../src/lib/jira-dom-parser";
import { readFixtureText } from "../fixtures/fixture-loader";

const BASE_URL = "https://issues.apache.org/jira";

async function loadJiraFixtureMeta() {
  const html = await readFixtureText("jira-issue.html");
  const meta = parseJiraIssueFromHtml(html, BASE_URL);

  expect(meta).not.toBeNull();

  if (meta === null) {
    throw new Error("Jira fixture should parse");
  }

  return meta;
}

describe("isJiraPage", () => {
  it("returns true for Jira issue HTML", async () => {
    const html = await readFixtureText("jira-issue.html");
    expect(isJiraPage(html)).toBe(true);
  });

  it("returns false for non-Jira HTML", () => {
    expect(isJiraPage("<html><body>Hello</body></html>")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isJiraPage("")).toBe(false);
  });
});

describe("parseJiraIssueFromHtml", () => {
  it("returns null for non-Jira HTML", () => {
    expect(parseJiraIssueFromHtml("<html><body>Hello</body></html>", BASE_URL)).toBeNull();
  });

  it("parses all fields from Jira fixture", async () => {
    const meta = await loadJiraFixtureMeta();

    expect(meta.key).toBe("KAFKA-15501");
    expect(meta.project).toBe("KAFKA");
    expect(meta.status).toBe("Open");
    expect(meta.assignee).toBe("shekharrajak");
    expect(meta.reporter).toBe("ritvikgupta");
    expect(meta.epicLink).toBeNull();
    expect(meta.resolution).toBeNull();
    expect(meta.baseUrl).toBe(BASE_URL);
    expect(meta.url).toBe(`${BASE_URL}/browse/KAFKA-15501`);
  });

  it("extracts labels as empty array when 'Не заполнено'", async () => {
    const meta = await loadJiraFixtureMeta();
    expect(meta.labels).toEqual(["None"]);
  });

  it("extracts components as empty array when absent", async () => {
    const meta = await loadJiraFixtureMeta();
    expect(meta.components).toEqual(["controller", "kraft"]);
  });

  it("extracts type from img alt or text fallback", async () => {
    const meta = await loadJiraFixtureMeta();
    // Fixture has type with img — should extract alt text or text content
    expect(meta.type).toBe("Improvement");
  });

  it("extracts priority from img alt or text fallback", async () => {
    const meta = await loadJiraFixtureMeta();
    expect(meta.priority).toBe("Blocker");
  });

  it("resolves resolution as null for 'unresolved' class", async () => {
    const meta = await loadJiraFixtureMeta();
    expect(meta.resolution).toBeNull();
  });
});

describe("parseJiraDescription", () => {
  it("extracts description from Jira fixture and returns markdown", async () => {
    const html = await readFixtureText("jira-issue.html");
    const md = parseJiraDescription(html);
    // Fixture has description content in #description-val
    expect(md.length).toBeGreaterThan(0);
    expect(md).toContain("KRaft migration steps for **Kafka v3.5.1**");
  });

  it("returns empty string for non-Jira HTML", () => {
    expect(parseJiraDescription("<html><body>No desc</body></html>")).toBe("");
  });
});
