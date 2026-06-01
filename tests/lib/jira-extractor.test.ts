import { describe, expect, it } from "vitest";

import {
  extractJiraIssue,
  jiraIssuesToCsv,
  jiraIssueToCsvRow,
  jiraIssueToJson,
  jiraIssueToMarkdown,
} from "../../src/lib/jira-extractor";
import type { JiraAttachment, JiraComment, JiraIssueMeta } from "../../src/types";

function makeIssueMeta(overrides: Partial<JiraIssueMeta> = {}): JiraIssueMeta {
  return {
    key: "KAFKA-15501",
    project: "KAFKA",
    type: "Improvement",
    status: "Open",
    priority: "Blocker",
    resolution: null,
    summary: "Kafka to KRaft combined mode migration v3.5",
    assignee: "TestUser",
    reporter: "TestReporter",
    labels: [],
    components: ["controller", "kraft"],
    versions: [],
    fixVersions: [],
    epicLink: null,
    created: "2023-09-25T13:48:41+0000",
    updated: "2026-04-06T12:11:18+0000",
    dueDate: null,
    baseUrl: "https://issues.apache.org/jira",
    url: "https://issues.apache.org/jira/browse/KAFKA-15501",
    ...overrides,
  };
}

function makeComment(overrides: Partial<JiraComment> = {}): JiraComment {
  return {
    id: "10001",
    author: "TestReporter",
    createdAt: "2025-01-15T12:00:00Z",
    body: "<p>Comment</p>",
    markdown: "Comment body markdown",
    ...overrides,
  };
}

function makeAttachment(overrides: Partial<JiraAttachment> = {}): JiraAttachment {
  return {
    id: "att-1",
    fileName: "design.png",
    mediaType: "image/png",
    fileSize: 2048,
    contentUrl: "https://issues.apache.org/jira/secure/attachment/att-1/design.png",
    ...overrides,
  };
}

describe("jiraIssueToMarkdown", () => {
  it("generates markdown with YAML front matter, description, and comments", () => {
    const markdown = jiraIssueToMarkdown(makeIssueMeta(), "Description markdown", [
      makeComment(),
    ]);

    expect(markdown).toContain("---\nkey: KAFKA-15501");
    expect(markdown).toContain("project: KAFKA");
    expect(markdown).toContain("type: Improvement");
    expect(markdown).toContain("status: Open");
    expect(markdown).toContain("priority: Blocker");
    expect(markdown).toContain("resolution: null");
    expect(markdown).toContain("assignee: TestUser");
    expect(markdown).toContain("reporter: TestReporter");
    expect(markdown).toContain("epic: null");
    expect(markdown).toContain("labels: []");
    expect(markdown).toContain("components: [controller, kraft]");
    expect(markdown).toContain("created: 2023-09-25");
    expect(markdown).toContain("# KAFKA-15501 — Kafka to KRaft combined mode migration v3.5");
    expect(markdown).toContain("## Description\n\nDescription markdown");
    expect(markdown).toContain("## Comments\n\n**TestReporter** — 2025-01-15");
    expect(markdown).toContain("Comment body markdown");
  });

  it("omits comments section when comments are absent", () => {
    const markdown = jiraIssueToMarkdown(makeIssueMeta(), "Description markdown");

    expect(markdown).toContain("## Description");
    expect(markdown).not.toContain("## Comments");
  });
});

describe("jiraIssueToJson", () => {
  it("returns flat structured JSON with meta fields and payload arrays", () => {
    const comment = makeComment();
    const attachment = makeAttachment();
    const json = jiraIssueToJson(makeIssueMeta(), "Description markdown", [comment], [
      attachment,
    ]);

    expect(json).toMatchObject({
      key: "KAFKA-15501",
      project: "KAFKA",
      type: "Improvement",
      status: "Open",
      description: "Description markdown",
      comments: [comment],
      attachments: [attachment],
    });
  });

  it("defaults comments and attachments to empty arrays", () => {
    const json = jiraIssueToJson(makeIssueMeta(), "Description markdown");

    expect(json.comments).toEqual([]);
    expect(json.attachments).toEqual([]);
  });
});

describe("jiraIssueToCsvRow", () => {
  it("returns fields in CSV order", () => {
    const row = jiraIssueToCsvRow(makeIssueMeta());

    expect(row).toBe(
      "KAFKA-15501,KAFKA,Improvement,Open,Blocker,,TestUser,TestReporter,,2023-09-25T13:48:41+0000,2026-04-06T12:11:18+0000",
    );
  });

  it("escapes CSV values containing commas, quotes, and line breaks", () => {
    const row = jiraIssueToCsvRow(
      makeIssueMeta({
        priority: "High, urgent",
        assignee: 'Ivan "Tester"',
        reporter: "Line\nBreak",
      }),
    );

    expect(row).toContain('"High, urgent"');
    expect(row).toContain('"Ivan ""Tester"""');
    expect(row).toContain('"Line\nBreak"');
  });
});

describe("jiraIssuesToCsv", () => {
  it("returns header and all issue rows", () => {
    const csv = jiraIssuesToCsv([
      makeIssueMeta(),
      makeIssueMeta({ key: "KAFKA-15502", status: "Resolved" }),
    ]);

    expect(csv.split("\n")[0]).toBe(
      "key,project,type,status,priority,resolution,assignee,reporter,epic,created,updated",
    );
    expect(csv).toContain("KAFKA-15501,KAFKA,Improvement,Open");
    expect(csv).toContain("KAFKA-15502,KAFKA,Improvement,Resolved");
  });
});

describe("extractJiraIssue", () => {
  it("returns full extracted Jira issue pipeline result", () => {
    const meta = makeIssueMeta();
    const comments = [makeComment()];
    const attachments = [makeAttachment()];
    const extracted = extractJiraIssue(meta, "Description markdown", comments, attachments);

    expect(extracted.meta).toBe(meta);
    expect(extracted.description).toBe("Description markdown");
    expect(extracted.comments).toEqual(comments);
    expect(extracted.attachments).toEqual(attachments);
    expect(extracted.markdown).toContain(
      "# KAFKA-15501 — Kafka to KRaft combined mode migration v3.5",
    );
    expect(extracted.json).toMatchObject({ key: "KAFKA-15501" });
    expect(extracted.csvRow).toBe(jiraIssueToCsvRow(meta));
  });
});
