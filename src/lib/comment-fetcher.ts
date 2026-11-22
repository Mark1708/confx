import {
  ApiError,
  type AttachmentReference,
  type ExtractedAttachment,
  type ExtractedComment,
  type ExtractedInlineComment,
  type ExtractedInlineCommentReply,
} from "@/types";
import { fetchAttachments, type FetchAttachmentsResult } from "./attachment-fetcher";
import type { ConfluenceApi } from "./confluence-api";
import { AssetRegistry, type PageAssetRegistry } from "./export/asset-registry";
import { isAbortError } from "./http-client";
import { htmlToMarkdown } from "./html-to-md";
import { relativePath } from "./link-rewriter";

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
  signal?.throwIfAborted();
  let res: CommentsResponse;
  try {
    res = await api.fetchJson<CommentsResponse>(
      `/rest/api/content/${pageId}/comment?expand=body.view,version`,
      signal,
    );
  } catch (error) {
    signal?.throwIfAborted();
    if (isAbortError(error)) throw error;
    if (error instanceof ApiError && error.status === 404) return [];
    throw error;
  }
  signal?.throwIfAborted();

  return res.results.map((raw) => ({
    id: raw.id,
    author: raw.version?.by?.displayName ?? "Unknown",
    createdAt: raw.version?.when ?? "",
    body: raw.body?.view?.value ?? "",
    markdown: htmlToMarkdown(raw.body?.view?.value ?? ""),
    attachments: [],
  }));
}

export async function fetchInlineComments(
  pageId: string,
  api: ConfluenceApi,
  signal?: AbortSignal,
): Promise<ExtractedInlineComment[]> {
  signal?.throwIfAborted();
  let roots: unknown;
  try {
    roots = await api.fetchJson<unknown>(
      `/rest/inlinecomments/1.0/comments?containerId=${encodeURIComponent(pageId)}`,
      signal,
    );
  } catch (error) {
    signal?.throwIfAborted();
    if (isAbortError(error)) throw error;
    if (error instanceof ApiError && error.status === 404) return [];
    throw error;
  }
  signal?.throwIfAborted();

  const rootRecords = assertInlineArray(roots, "inline comments").filter(hasInlineId);
  if (rootRecords.length === 0) return [];

  const replyCollections: Array<Array<InlineCommentRaw & { id: string | number }>> = [];
  for (const root of rootRecords) {
    signal?.throwIfAborted();
    const replies = await api.fetchJson<unknown>(
      `/rest/inlinecomments/1.0/comments/${String(root.id)}/replies`,
      signal,
    );
    signal?.throwIfAborted();
    replyCollections.push(
      assertInlineArray(replies, `inline comment ${String(root.id)} replies`).filter(hasInlineId),
    );
  }

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
    attachments: [],
  };
}

export interface FetchCommentAttachmentsOptions {
  pageId: string;
  folder?: string;
  assets?: PageAssetRegistry;
  maxSize?: number;
  signal?: AbortSignal;
}

export interface FetchCommentAttachmentsResult {
  comments: ExtractedComment[];
  inlineComments: ExtractedInlineComment[];
  attachments: ExtractedAttachment[];
  outcome: FetchAttachmentsResult["outcome"];
  failures: FetchAttachmentsResult["failures"];
}

export async function fetchCommentAttachments(
  comments: readonly ExtractedComment[],
  inlineComments: readonly ExtractedInlineComment[],
  api: ConfluenceApi,
  options: FetchCommentAttachmentsOptions,
): Promise<FetchCommentAttachmentsResult> {
  options.signal?.throwIfAborted();
  const folder = options.folder ?? "";
  const assets = options.assets ?? new AssetRegistry(false).beginPage(folder);
  const fetchOwnedAttachments = (commentId: string) =>
    fetchAttachments(commentId, api, {
      folder: `${folder ? `${folder}/` : ""}attachments/comments/${encodeURIComponent(commentId)}`,
      assets,
      ownershipKey: `comment:${folder}:${commentId}`,
      maxSize: options.maxSize,
      signal: options.signal,
      includeImages: true,
      optionalOwnerNotFound: true,
      pageId: options.pageId,
    });

  const commentResults: FetchAttachmentsResult[] = [];
  for (const comment of comments) {
    options.signal?.throwIfAborted();
    commentResults.push(await fetchOwnedAttachments(comment.id));
  }
  const inlineResults: Array<{ root: FetchAttachmentsResult; replies: FetchAttachmentsResult[] }> =
    [];
  for (const comment of inlineComments) {
    options.signal?.throwIfAborted();
    const root = await fetchOwnedAttachments(comment.id);
    const replies: FetchAttachmentsResult[] = [];
    for (const reply of comment.replies) {
      options.signal?.throwIfAborted();
      replies.push(await fetchOwnedAttachments(reply.id));
    }
    inlineResults.push({ root, replies });
  }
  options.signal?.throwIfAborted();

  const enrichedComments = comments.map((comment, index) => ({
    ...comment,
    attachments: commentResults[index].references,
  }));
  const enrichedInlineComments = inlineComments.map((comment, index) => ({
    ...comment,
    attachments: inlineResults[index].root.references,
    replies: comment.replies.map((reply, replyIndex) => ({
      ...reply,
      attachments: inlineResults[index].replies[replyIndex].references,
    })),
  }));
  const attachments = [
    ...commentResults.flatMap((result) => result.attachments),
    ...inlineResults.flatMap((result) => [
      ...result.root.attachments,
      ...result.replies.flatMap((reply) => reply.attachments),
    ]),
  ];
  const results = [
    ...commentResults,
    ...inlineResults.flatMap((result) => [result.root, ...result.replies]),
  ];
  const outcome = results.reduce<FetchAttachmentsResult["outcome"]>(
    (total, result) => ({
      listed: total.listed + result.outcome.listed,
      eligible: total.eligible + result.outcome.eligible,
      archived: total.archived + result.outcome.archived,
      skippedSize: total.skippedSize + result.outcome.skippedSize,
      failedDownloads: total.failedDownloads + result.outcome.failedDownloads,
    }),
    { listed: 0, eligible: 0, archived: 0, skippedSize: 0, failedDownloads: 0 },
  );

  return {
    comments: enrichedComments,
    inlineComments: enrichedInlineComments,
    attachments,
    outcome,
    failures: results.flatMap((result) => result.failures),
  };
}

export function commentsToJson(
  comments: readonly ExtractedComment[],
  inlineComments: readonly ExtractedInlineComment[],
  folder = "",
): string {
  const serializeReferences = (references: readonly AttachmentReference[]) =>
    references.map(
      ({ sourceUrl, archivePath, fileName, mediaType, fileSize, skipped, skipReason }) => ({
        sourceUrl,
        // This published field deliberately keeps its original page-relative semantics.
        zipPath: archivePath === undefined ? undefined : relativePath(folder, archivePath),
        fileName,
        mediaType,
        fileSize,
        skipped,
        skipReason,
      }),
    );
  return JSON.stringify(
    {
      comments: comments.map((comment) => ({
        ...comment,
        attachments: serializeReferences(comment.attachments),
      })),
      inlineComments: inlineComments.map((comment) => ({
        ...comment,
        attachments: serializeReferences(comment.attachments),
        replies: comment.replies.map((reply) => ({
          ...reply,
          attachments: serializeReferences(reply.attachments),
        })),
      })),
    },
    null,
    2,
  );
}
