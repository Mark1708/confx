import { describe, expect, it } from "vitest";
import {
  detectPageContext,
  detectPageContextWithDiagnostics,
  extractJiraIssueKey,
} from "@/lib/page-context";

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

  it("detects Jira issue from known projects issues route", () => {
    expect(extractJiraIssueKey("https://jira.example.com/projects/ABC/issues/ABC-789")).toBe(
      "ABC-789",
    );
  });

  it("does not detect Jira issue from unrelated path segments", () => {
    expect(extractJiraIssueKey("https://example.com/posts/ABC-123")).toBeNull();
  });

  it("does not detect Jira issue from a full unrelated pathname", () => {
    expect(extractJiraIssueKey("https://example.com/docs/releases/ABC-123-notes")).toBeNull();
  });

  it("does not detect selectedIssue on unrelated routes", () => {
    expect(extractJiraIssueKey("https://example.com/posts?selectedIssue=ABC-123")).toBeNull();
  });

  it("prefers Jira meta over Confluence page id", () => {
    const context = detectPageContext({
      url: "https://jira.example.com/wiki/pages/12345?selectedIssue=ABC-123",
      meta: { confluencePageId: "12345", jiraIssueKey: "ABC-999" },
    });

    expect(context).toEqual({ kind: "jira", host: "https://jira.example.com", issueKey: "ABC-999" });
  });

  it("preserves /jira base path for Jira issue pages", () => {
    const context = detectPageContext({
      url: "https://issues.apache.org/jira/browse/KAFKA-15501",
      title: "KAFKA-15501",
    });

    expect(context).toEqual({
      kind: "jira",
      host: "https://issues.apache.org/jira",
      issueKey: "KAFKA-15501",
      title: "KAFKA-15501",
    });
  });

  it("preserves /jira base path for Jira selectedIssue URLs", () => {
    const context = detectPageContext({
      url: "https://jira.example.com/jira/software/projects/ABC/boards/1?selectedIssue=ABC-456",
    });

    expect(context).toEqual({
      kind: "jira",
      host: "https://jira.example.com/jira",
      issueKey: "ABC-456",
      title: undefined,
    });
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

  it("preserves /wiki base path for Confluence Cloud", () => {
    const context = detectPageContext({
      url: "https://example.atlassian.net/wiki/spaces/ABC/pages/12345/Page",
      meta: { confluencePageId: "12345", confluenceTitle: "Cloud Page" },
    });

    expect(context).toEqual({
      kind: "confluence",
      host: "https://example.atlassian.net/wiki",
      pageId: "12345",
      title: "Cloud Page",
    });
  });

  it("returns unknown for unrelated URLs", () => {
    expect(detectPageContext({ url: "https://example.com/docs" })).toEqual({
      kind: "unknown",
      host: "https://example.com",
      title: undefined,
    });
  });

  it("returns unknown for unrelated URLs containing Jira issue-like segments", () => {
    expect(detectPageContext({ url: "https://example.com/posts/ABC-123" })).toEqual({
      kind: "unknown",
      host: "https://example.com",
      title: undefined,
    });
  });

  it("reports Jira diagnostics from metadata with button visibility state", () => {
    const analysis = detectPageContextWithDiagnostics(
      {
        url: "https://jira.example.com/browse/ABC-123",
        meta: { jiraIssueKey: "ABC-123" },
      },
      { showConfluenceButton: false, showJiraButton: true },
    );

    expect(analysis).toEqual({
      context: {
        kind: "jira",
        host: "https://jira.example.com",
        issueKey: "ABC-123",
        title: undefined,
      },
      diagnostics: {
        detectedKind: "jira",
        host: "https://jira.example.com",
        issueKey: "ABC-123",
        pageId: undefined,
        detectionSource: "meta",
        detectionReason: "Detected Jira issue key from page metadata.",
        buttonVisibility: {
          confluence: { enabled: false, visible: false },
          jira: { enabled: true, visible: true },
        },
      },
    });
  });

  it("reports Confluence diagnostics from URL with button visibility state", () => {
    const analysis = detectPageContextWithDiagnostics(
      {
        url: "https://wiki.example.com/pages/viewpage.action?pageId=12345",
        title: "Runbook",
      },
      { showConfluenceButton: true, showJiraButton: false },
    );

    expect(analysis).toEqual({
      context: {
        kind: "confluence",
        host: "https://wiki.example.com",
        pageId: "12345",
        title: "Runbook",
      },
      diagnostics: {
        detectedKind: "confluence",
        host: "https://wiki.example.com",
        pageId: "12345",
        issueKey: undefined,
        detectionSource: "url",
        detectionReason: "Detected Confluence page id from the current URL.",
        buttonVisibility: {
          confluence: { enabled: true, visible: true },
          jira: { enabled: false, visible: false },
        },
      },
    });
  });

  it("reports unknown diagnostics without leaking page content", () => {
    const analysis = detectPageContextWithDiagnostics({ url: "https://example.com/docs" });

    expect(analysis).toEqual({
      context: {
        kind: "unknown",
        host: "https://example.com",
        title: undefined,
      },
      diagnostics: {
        detectedKind: "unknown",
        host: "https://example.com",
        pageId: undefined,
        issueKey: undefined,
        detectionSource: "none",
        detectionReason: "The tab URL did not match supported Confluence or Jira patterns.",
        buttonVisibility: {
          confluence: { enabled: true, visible: false },
          jira: { enabled: true, visible: false },
        },
      },
    });
  });
});
