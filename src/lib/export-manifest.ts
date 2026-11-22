import {
  type BuildConfluenceExportManifestOptions,
  type ConfluenceExportManifest,
  type ConfluenceExportInventory,
  type ConfluenceExportManifestPage,
  type ExtractedPage,
} from "@/types";

export function buildConfluenceExportManifest(
  options: BuildConfluenceExportManifestOptions,
): ConfluenceExportManifest {
  const pages = options.pages.map((inventory) => inventory.page);

  return {
    manifest_version: 2,
    type: options.type,
    exported_at: options.exportedAt ?? new Date().toISOString(),
    preset: options.preset,
    source: options.source,
    counts: {
      pages: options.pages.length,
      tables_csv: options.pages.reduce(
        (count, inventory) => count + inventory.counts.tables_csv,
        0,
      ),
      images: options.pages.reduce((count, inventory) => count + inventory.counts.images, 0),
      attachments: options.pages.reduce(
        (count, inventory) => count + inventory.counts.attachments,
        0,
      ),
      plantuml_diagrams: options.pages.reduce(
        (count, inventory) => count + inventory.counts.plantuml_diagrams,
        0,
      ),
      ...options.additionalCounts,
    },
    pages,
    failures: [
      ...options.pages.flatMap((inventory) => inventory.failures),
      ...(options.failures ?? []),
    ],
  };
}

export function serializeConfluenceExportManifest(
  options: BuildConfluenceExportManifestOptions,
): string {
  return JSON.stringify(buildConfluenceExportManifest(options), null, 2);
}

function archivePathForPage(page: Pick<ExtractedPage, "folder">): string {
  return page.folder ? `${page.folder}/index.md` : "index.md";
}

/** Captured only after all page writes succeed; no source text or binary is retained. */
export function capturePageInventory(
  page: ExtractedPage,
  origin: ConfluenceExportManifestPage["origin"],
  linkDepth: number | null = null,
  discoveredFrom: readonly string[] = [],
): ConfluenceExportInventory {
  return {
    page: buildManifestPage(page, origin, linkDepth, [...discoveredFrom]),
    counts: {
      tables_csv: page.tables.length,
      images: page.images.length,
      attachments:
        page.attachments.filter((attachment) => !attachment.skipped).length +
        page.commentAttachments.filter((attachment) => !attachment.skipped).length,
      plantuml_diagrams: page.plantUmlAssets.length,
    },
    failures: page.outcome.failures.map((failure) => ({ ...failure })),
  };
}

function buildManifestPage(
  page: ExtractedPage,
  origin: ConfluenceExportManifestPage["origin"],
  linkDepth: number | null,
  discoveredFrom: string[],
): ConfluenceExportManifestPage {
  const ancestors = page.meta.ancestors?.map((ancestor) => ({ ...ancestor })) ?? [];
  const attachmentOutcome = page.outcome.attachments;
  const plantUmlOutcome = page.outcome.plantUml;
  const layoutOutcome = page.outcome.layout;

  return {
    id: page.meta.id,
    title: page.meta.title,
    version: page.meta.version ?? null,
    url: page.meta.url,
    space: page.meta.spaceKey || null,
    parent_id: ancestors.at(-1)?.id ?? null,
    ancestors,
    archive_path: archivePathForPage(page),
    editable:
      page.editable?.status === "available"
        ? {
            metadata_version: 1,
            status: "available",
            path: page.folder ? `${page.folder}/editable.md` : "editable.md",
            representation: page.editable.representation,
            version: page.editable.version,
            source_hash: page.editable.sourceHash,
          }
        : {
            metadata_version: 1,
            status: "unavailable",
            reason: page.editable?.reason ?? "source-unavailable",
          },
    origin,
    link_depth: linkDepth,
    discovered_from: discoveredFrom,
    attachment_outcome: {
      declared: attachmentOutcome.declared,
      listed: attachmentOutcome.listed,
      eligible: attachmentOutcome.eligible,
      archived:
        page.attachments.filter((attachment) => !attachment.skipped).length +
        page.commentAttachments.filter((attachment) => !attachment.skipped).length,
      skipped_size: attachmentOutcome.skippedSize,
      failed_downloads: attachmentOutcome.failedDownloads,
    },
    plantuml_outcome: {
      discovered: plantUmlOutcome.discovered,
      archived: page.plantUmlAssets.length,
      skipped_limit: plantUmlOutcome.skippedLimit,
      failed_downloads: plantUmlOutcome.failedDownloads,
      unsupported: plantUmlOutcome.unsupported,
    },
    layout_outcome: {
      status: layoutOutcome.status,
      sections: layoutOutcome.sections,
    },
  };
}
