import {
  ApiError,
  type ExtractedComment,
  type ExtractedInlineComment,
  type ExtractedInlineCommentReply,
} from "@/types";
import type { ConfluenceApi } from "./confluence-api";
import { htmlToMarkdown } from "./html-to-md";

interface CommentRaw {
  id: string;
  body?: { view?: { value: string } };
  version?: {
    by?: { displayName?: string };
    when?: string;
  };
}

interface CommentsResponse {
  results: CommentRaw[];
}

interface InlineCommentRaw {
  id?: string | number;
  authorDisplayName?: string;
  lastModificationDate?: string;
  body?: string;
  originalSelection?: string;
  markerRef?: string;
  resolveProperties?: { resolved?: boolean };
}

export async function fetchComments(
  pageId: string,
  api: ConfluenceApi,
  signal?: AbortSignal,
): Promise<ExtractedComment[]> {
  let res: CommentsResponse;
  try {
    res = await api.fetchJson<CommentsResponse>(
      `/rest/api/content/${pageId}/comment?expand=body.view,version`,
      signal,
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return [];
    throw error;
  }

  return res.results.map((raw) => ({
    id: raw.id,
    author: raw.version?.by?.displayName ?? "Unknown",
    createdAt: raw.version?.when ?? "",
    body: raw.body?.view?.value ?? "",
    markdown: htmlToMarkdown(raw.body?.view?.value ?? ""),
  }));
}

export async function fetchInlineComments(
  pageId: string,
  api: ConfluenceApi,
  signal?: AbortSignal,
): Promise<ExtractedInlineComment[]> {
  let roots: unknown;
  try {
    roots = await api.fetchJson<unknown>(
      `/rest/inlinecomments/1.0/comments?containerId=${encodeURIComponent(pageId)}`,
      signal,
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return [];
    throw error;
  }

  const rootRecords = assertInlineArray(roots, "inline comments").filter(hasInlineId);
  if (rootRecords.length === 0) return [];

  const replyCollections = await Promise.all(
    rootRecords.map(async (root) =>
      assertInlineArray(
        await api.fetchJson<unknown>(
          `/rest/inlinecomments/1.0/comments/${String(root.id)}/replies`,
          signal,
        ),
        `inline comment ${String(root.id)} replies`,
      ).filter(hasInlineId),
    ),
  );

  return rootRecords.map((root, index) => ({
    ...mapInlineReply(root),
    selection: root.originalSelection ?? "",
    markerRef: root.markerRef ?? "",
    status: root.resolveProperties?.resolved === true ? "resolved" : "open",
    replies: replyCollections[index].map(mapInlineReply),
  }));
}

function assertInlineArray(value: unknown, label: string): InlineCommentRaw[] {
  if (!Array.isArray(value)) throw new Error(`Expected ${label} endpoint response to be an array`);
  return value as InlineCommentRaw[];
}

function hasInlineId(raw: InlineCommentRaw): raw is InlineCommentRaw & { id: string | number } {
  return raw.id !== undefined && raw.id !== null && String(raw.id) !== "";
}

function mapInlineReply(
  raw: InlineCommentRaw & { id: string | number },
): ExtractedInlineCommentReply {
  const body = raw.body ?? "";
  return {
    id: String(raw.id),
    author: raw.authorDisplayName ?? "Unknown",
    updatedAt: raw.lastModificationDate ?? "",
    body,
    markdown: htmlToMarkdown(body),
  };
}

export function commentsToMarkdown(
  pageComments: readonly ExtractedComment[],
  inlineComments: readonly ExtractedInlineComment[],
): string {
  if (pageComments.length === 0 && inlineComments.length === 0) return "";

  const sections = ["\n<!-- confx:comments:start -->\n\n## Comments"];

  if (pageComments.length > 0) {
    sections.push(
      [
        "### Page comments",
        ...pageComments.map((comment) =>
          [`#### @${comment.author} — ${comment.createdAt}`, comment.markdown].join("\n\n"),
        ),
      ].join("\n\n"),
    );
  }

  if (inlineComments.length > 0) {
    sections.push(
      [
        "### Inline comments",
        ...inlineComments.map((comment) => renderInlineComment(comment)),
      ].join("\n\n"),
    );
  }

  return `${sections.join("\n\n")}\n\n<!-- confx:comments:end -->\n`;
}

function renderInlineComment(comment: ExtractedInlineComment): string {
  const status = comment.status === "resolved" ? "Resolved" : "Open";
  return [
    `#### [${status}] «${comment.selection}»`,
    `**@${comment.author} — ${comment.updatedAt}**`,
    comment.markdown,
    ...comment.replies.map((reply) =>
      [`##### Reply — @${reply.author} — ${reply.updatedAt}`, reply.markdown].join("\n\n"),
    ),
  ].join("\n\n");
}
