import { describe, expect, it } from "vitest";
import { detectPageContext, extractJiraIssueKey } from "@/lib/page-context";

describe("page context detection", () => {
  it("detects Jira issue from browse URL", () => {
    expect(extractJiraIssueKey("https://jira.example.com/browse/ABC-123")).toBe("ABC-123");
  });

  it("detects Jira issue from selectedIssue query", () => {
    expect(
      extractJiraIssueKey(
        "https://jira.example.com/jira/software/projects/ABC/boards/1?selectedIssue=ABC-456",
      ),
    ).toBe("ABC-456");
  });

  it("detects Jira issue from path segments", () => {
    expect(extractJiraIssueKey("https://jira.example.com/projects/ABC/issues/ABC-789")).toBe(
      "ABC-789",
    );
  });

  it("prefers Jira meta over Confluence page id", () => {
    const context = detectPageContext({
      url: "https://jira.example.com/wiki/pages/12345?selectedIssue=ABC-123",
      meta: { confluencePageId: "12345", jiraIssueKey: "ABC-999" },
    });

    expect(context).toEqual({ kind: "jira", host: "https://jira.example.com", issueKey: "ABC-999" });
  });

  it("detects Confluence page from meta", () => {
    const context = detectPageContext({
      url: "https://wiki.example.com/pages/viewpage.action?pageId=12345",
      title: "Runbook",
      meta: { confluencePageId: "12345", confluenceTitle: "Ops Runbook" },
    });

    expect(context).toEqual({
      kind: "confluence",
      host: "https://wiki.example.com",
      pageId: "12345",
      title: "Ops Runbook",
    });
  });

  it("returns unknown for unrelated URLs", () => {
    expect(detectPageContext({ url: "https://example.com/docs" })).toEqual({
      kind: "unknown",
      host: "https://example.com",
      title: undefined,
    });
  });
});
