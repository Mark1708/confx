import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isJiraPage,
  parseJiraDescription,
  parseJiraIssueFromHtml,
} from "../../src/lib/jira-dom-parser";

const fixturePath = path.resolve(process.cwd(), "tests/fixtures/jira-issue.html");

const BASE_URL = "https://mostrek.atlassian.net";

describe("isJiraPage", () => {
  it("returns true for Jira issue HTML", async () => {
    const html = await readFile(fixturePath, "utf8");
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
    const html = await readFile(fixturePath, "utf8");
    const meta = parseJiraIssueFromHtml(html, BASE_URL);

    expect(meta).not.toBeNull();
    expect(meta!.key).toBe("CPEMGIS-8140");
    expect(meta!.project).toBe("CPEMGIS");
    expect(meta!.status).toBe("В РАБОТЕ");
    expect(meta!.assignee).toBe("GuryanovMV");
    expect(meta!.reporter).toBe("FedorovIT");
    expect(meta!.epicLink).toBe("CPEMGIS-4208");
    expect(meta!.resolution).toBeNull();
    expect(meta!.baseUrl).toBe(BASE_URL);
    expect(meta!.url).toBe(`${BASE_URL}/browse/CPEMGIS-8140`);
  });

  it("extracts labels as empty array when 'Не заполнено'", async () => {
    const html = await readFile(fixturePath, "utf8");
    const meta = parseJiraIssueFromHtml(html, BASE_URL);
    expect(meta!.labels).toEqual([]);
  });

  it("extracts components as empty array when absent", async () => {
    const html = await readFile(fixturePath, "utf8");
    const meta = parseJiraIssueFromHtml(html, BASE_URL);
    expect(meta!.components).toEqual([]);
  });

  it("extracts type from img alt or text fallback", async () => {
    const html = await readFile(fixturePath, "utf8");
    const meta = parseJiraIssueFromHtml(html, BASE_URL);
    // Fixture has type with img — should extract alt text or text content
    expect(meta!.type).toBeTruthy();
    expect(meta!.type).not.toBe("Unknown");
  });

  it("extracts priority from img alt or text fallback", async () => {
    const html = await readFile(fixturePath, "utf8");
    const meta = parseJiraIssueFromHtml(html, BASE_URL);
    expect(meta!.priority).toBeTruthy();
    expect(meta!.priority).not.toBe("Unset");
  });

  it("resolves resolution as null for 'unresolved' class", async () => {
    const html = await readFile(fixturePath, "utf8");
    const meta = parseJiraIssueFromHtml(html, BASE_URL);
    expect(meta!.resolution).toBeNull();
  });
});

describe("parseJiraDescription", () => {
  it("extracts description from Jira fixture and returns markdown", async () => {
    const html = await readFile(fixturePath, "utf8");
    const md = parseJiraDescription(html);
    // Fixture has description content in #description-val
    expect(md.length).toBeGreaterThan(0);
  });

  it("returns empty string for non-Jira HTML", () => {
    expect(parseJiraDescription("<html><body>No desc</body></html>")).toBe("");
  });
});
