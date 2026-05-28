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
    key: "CPEMGIS-8140",
    project: "CPEMGIS",
    type: "Task",
    status: "В РАБОТЕ",
    priority: "Medium",
    resolution: null,
    summary: "Summary text",
    assignee: "GuryanovMV",
    reporter: "FedorovIT",
    labels: [],
    components: [],
    versions: [],
    fixVersions: [],
    epicLink: "CPEMGIS-4208",
    created: "2025-01-15T10:30:00Z",
    updated: "2025-01-16T11:00:00Z",
    dueDate: null,
    baseUrl: "https://jira.example.test",
    url: "https://jira.example.test/browse/CPEMGIS-8140",
    ...overrides,
  };
}

function makeComment(overrides: Partial<JiraComment> = {}): JiraComment {
  return {
    id: "10001",
    author: "FedorovIT",
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
    contentUrl: "https://jira.example.test/secure/attachment/att-1/design.png",
    ...overrides,
  };
}

describe("jiraIssueToMarkdown", () => {
  it("generates markdown with YAML front matter, description, and comments", () => {
    const markdown = jiraIssueToMarkdown(makeIssueMeta(), "Description markdown", [
      makeComment(),
    ]);

    expect(markdown).toContain("---\nkey: CPEMGIS-8140");
    expect(markdown).toContain("project: CPEMGIS");
    expect(markdown).toContain("type: Task");
    expect(markdown).toContain('status: "В РАБОТЕ"');
    expect(markdown).toContain("priority: Medium");
    expect(markdown).toContain("resolution: null");
    expect(markdown).toContain("assignee: GuryanovMV");
    expect(markdown).toContain("reporter: FedorovIT");
    expect(markdown).toContain("epic: CPEMGIS-4208");
    expect(markdown).toContain("labels: []");
    expect(markdown).toContain("components: []");
    expect(markdown).toContain("created: 2025-01-15");
    expect(markdown).toContain("# CPEMGIS-8140 — Summary text");
    expect(markdown).toContain("## Description\n\nDescription markdown");
    expect(markdown).toContain("## Comments\n\n**FedorovIT** — 2025-01-15");
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
      key: "CPEMGIS-8140",
      project: "CPEMGIS",
      type: "Task",
      status: "В РАБОТЕ",
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
      "CPEMGIS-8140,CPEMGIS,Task,В РАБОТЕ,Medium,,GuryanovMV,FedorovIT,CPEMGIS-4208,2025-01-15T10:30:00Z,2025-01-16T11:00:00Z",
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
      makeIssueMeta({ key: "CPEMGIS-8141", status: "DONE" }),
    ]);

    expect(csv.split("\n")[0]).toBe(
      "key,project,type,status,priority,resolution,assignee,reporter,epic,created,updated",
    );
    expect(csv).toContain("CPEMGIS-8140,CPEMGIS,Task,В РАБОТЕ");
    expect(csv).toContain("CPEMGIS-8141,CPEMGIS,Task,DONE");
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
    expect(extracted.markdown).toContain("# CPEMGIS-8140 — Summary text");
    expect(extracted.json).toMatchObject({ key: "CPEMGIS-8140" });
    expect(extracted.csvRow).toBe(jiraIssueToCsvRow(meta));
  });
});
