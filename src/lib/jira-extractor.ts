import type {
  ExtractedJiraIssue,
  JiraAttachment,
  JiraComment,
  JiraIssueMeta,
} from "@/types";

const CSV_HEADER = "key,project,type,status,priority,resolution,assignee,reporter,epic,created,updated";
const YAML_SPECIAL_CHARS = [":", "#", "[", "]", "{", "}", "&", "*", "!", "|", ">", "'", '"', "%", "@", "`", ",", "\n"];

export function jiraIssueToMarkdown(
  meta: JiraIssueMeta,
  description: string,
  comments: JiraComment[] = [],
): string {
  const sections = [
    buildJiraFrontMatter(meta),
    `# ${meta.key} — ${meta.summary}`,
    "## Description",
    description,
  ];

  if (comments.length === 0) {
    return `${sections.join("\n\n")}\n`;
  }

  return `${[...sections, jiraCommentsToMarkdown(comments)].join("\n\n")}\n`;
}

export function jiraIssueToJson(
  meta: JiraIssueMeta,
  description: string,
  comments: JiraComment[] = [],
  attachments: JiraAttachment[] = [],
): Record<string, unknown> {
  return {
    ...meta,
    description,
    comments,
    attachments,
  };
}

export function jiraIssueToCsvRow(meta: JiraIssueMeta): string {
  return [
    meta.key,
    meta.project,
    meta.type,
    meta.status,
    meta.priority,
    meta.resolution,
    meta.assignee,
    meta.reporter,
    meta.epicLink,
    meta.created,
    meta.updated,
  ]
    .map(csvEscape)
    .join(",");
}

export function jiraIssuesToCsv(issues: JiraIssueMeta[]): string {
  return [CSV_HEADER, ...issues.map(jiraIssueToCsvRow)].join("\n");
}

export function extractJiraIssue(
  meta: JiraIssueMeta,
  description: string,
  comments: JiraComment[] = [],
  attachments: JiraAttachment[] = [],
): ExtractedJiraIssue {
  return {
    meta,
    description,
    comments,
    attachments,
    markdown: jiraIssueToMarkdown(meta, description, comments),
    json: jiraIssueToJson(meta, description, comments, attachments),
    csvRow: jiraIssueToCsvRow(meta),
  };
}

function buildJiraFrontMatter(meta: JiraIssueMeta): string {
  return [
    "---",
    `key: ${yamlValue(meta.key)}`,
    `project: ${yamlValue(meta.project)}`,
    `type: ${yamlValue(meta.type)}`,
    `status: ${yamlValue(meta.status)}`,
    `priority: ${yamlValue(meta.priority)}`,
    `resolution: ${yamlValue(meta.resolution)}`,
    `assignee: ${yamlValue(meta.assignee)}`,
    `reporter: ${yamlValue(meta.reporter)}`,
    `epic: ${yamlValue(meta.epicLink)}`,
    `labels: ${yamlArray(meta.labels)}`,
    `components: ${yamlArray(meta.components)}`,
    `created: ${yamlValue(formatDate(meta.created))}`,
    "---",
  ].join("\n");
}

function jiraCommentsToMarkdown(comments: JiraComment[]): string {
  const items = comments
    .map((comment) => `**${comment.author}** — ${formatDate(comment.createdAt)}\n${comment.markdown}`)
    .join("\n\n");

  return `## Comments\n\n${items}`;
}

function yamlArray(values: string[]): string {
  if (values.length === 0) return "[]";

  return `[${values.map(yamlValue).join(", ")}]`;
}

function yamlValue(value: string | null): string {
  if (value === null) return "null";
  if (value === "") return '""';

  const escaped = value.replace(/"/g, '\\"');
  const needsQuote = /\s/.test(value) || YAML_SPECIAL_CHARS.some((char) => value.includes(char));

  return needsQuote ? `"${escaped}"` : escaped;
}

function formatDate(value: string): string {
  return value.includes("T") ? value.slice(0, 10) : value;
}

function csvEscape(value: string | null): string {
  if (value === null) return "";

  const escaped = value.replace(/"/g, '""');
  const needsQuote = /[",\n\r]/.test(value);

  return needsQuote ? `"${escaped}"` : escaped;
}
