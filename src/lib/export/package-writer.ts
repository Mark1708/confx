import type { ExtractedPage } from "@/types";
import { commentsToJson } from "../comment-fetcher";
import type { ArchiveEntry, EmitEntry } from "./contracts";
import { safeZipSegment } from "./paths";

export function csvIndexMarkdown(title: string, csvPaths: readonly string[]): string {
  const links = csvPaths.map((path) => `- [${path.split("/").at(-1)}](${path})`);
  return [`# ${title}`, "", ...links, ""].join("\n");
}

/** Writes only this page's physical entries; canonical resource paths are already final. */
export async function writePageEntries(
  page: ExtractedPage,
  emit: EmitEntry,
  signal: AbortSignal,
  tablesOnly = false,
): Promise<{ entriesWritten: number; resourcesWritten: number }> {
  const prefix = page.folder ? `${page.folder}/` : "";
  let entriesWritten = 0;
  let resourcesWritten = 0;
  const write = async (entry: ArchiveEntry): Promise<void> => {
    signal.throwIfAborted();
    await emit(entry);
    entriesWritten += 1;
    if (typeof entry.body !== "string") resourcesWritten += 1;
    signal.throwIfAborted();
  };

  if (!tablesOnly) {
    await write({ path: `${prefix}index.md`, body: page.markdown });
    if (page.editable?.status === "available") {
      await write({ path: `${prefix}editable.md`, body: page.editable.markdown });
    }
  }

  const csvPaths: string[] = [];
  for (const table of page.tables) {
    const path = `tables/${safeZipSegment(table.name)}`;
    await write({ path: `${prefix}${path}`, body: table.csv });
    csvPaths.push(path);
  }
  if (tablesOnly) {
    await write({
      path: `${prefix}index.md`,
      body: csvIndexMarkdown(page.meta.title, csvPaths),
    });
    return { entriesWritten, resourcesWritten };
  }

  for (const image of page.images) {
    await write({ path: image.archivePath, body: image.blob });
  }
  for (const attachment of page.attachments) {
    if (!attachment.skipped) {
      await write({ path: attachment.archivePath, body: attachment.blob });
    }
  }
  for (const diagram of page.plantUmlAssets) {
    await write({ path: diagram.png.archivePath, body: diagram.png.blob });
    await write({ path: diagram.source.archivePath, body: diagram.source.blob });
  }
  for (const attachment of page.commentAttachments) {
    if (!attachment.skipped) {
      await write({ path: attachment.archivePath, body: attachment.blob });
    }
  }
  if (page.comments.length > 0 || page.inlineComments.length > 0) {
    await write({
      path: `${prefix}comments.json`,
      body: commentsToJson(page.comments, page.inlineComments, page.folder),
    });
  }
  if (page.history.length > 0) {
    await write({ path: `${prefix}history.json`, body: JSON.stringify(page.history, null, 2) });
  }
  return { entriesWritten, resourcesWritten };
}
