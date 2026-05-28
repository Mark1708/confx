import type { ExtractedComment } from "@/types";
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

export async function fetchComments(
  pageId: string,
  api: ConfluenceApi,
  signal?: AbortSignal,
): Promise<ExtractedComment[]> {
  const res = await api.fetchJson<CommentsResponse>(
    `/rest/api/content/${pageId}/comment?expand=body.view,version`,
    signal,
  );

  return res.results.map((raw) => ({
    id: raw.id,
    author: raw.version?.by?.displayName ?? "Unknown",
    createdAt: raw.version?.when ?? "",
    body: raw.body?.view?.value ?? "",
    markdown: htmlToMarkdown(raw.body?.view?.value ?? ""),
  }));
}

export function commentsToMarkdown(comments: ExtractedComment[]): string {
  if (comments.length === 0) return "";

  const header = "\n---\n\n## Comments\n\n";
  const items = comments
    .map((c) => `### @${c.author} — ${c.createdAt}\n\n${c.markdown}`)
    .join("\n\n");

  return header + items + "\n";
}
