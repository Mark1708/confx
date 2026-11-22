import type { ConfluencePageMeta } from "@/types";
import { CONFX_LAYOUT_MARKER_VERSION } from "./confluence-layout";

export interface FrontMatterOptions {
  versionCount?: number;
  layoutStatus?: "preserved" | "flattened";
}

export function buildFrontMatter(meta: ConfluencePageMeta, opts?: FrontMatterOptions): string {
  const yaml: string[] = ["---"];
  yaml.push(`title: ${quote(meta.title)}`);
  yaml.push(`page_id: "${meta.id}"`);
  if (meta.spaceKey) yaml.push(`space: ${meta.spaceKey}`);
  yaml.push(`source_url: ${meta.url}`);
  if (meta.version != null) yaml.push(`version: ${meta.version}`);
  if (meta.ancestors?.length) {
    yaml.push("ancestors:");
    for (const a of meta.ancestors) {
      yaml.push(`  - id: "${a.id}"`);
      yaml.push(`    title: ${quote(a.title)}`);
    }
  }
  if (meta.labels?.length) {
    yaml.push(`labels: [${meta.labels.map(quote).join(", ")}]`);
  }
  if (opts?.versionCount != null && opts.versionCount > 0) {
    yaml.push(`versions: ${opts.versionCount}`);
  }
  if (opts?.layoutStatus === "preserved") yaml.push(`confx_layout: ${CONFX_LAYOUT_MARKER_VERSION}`);
  if (opts?.layoutStatus === "flattened") yaml.push("confx_layout: unsupported");
  yaml.push(`exported_at: ${new Date().toISOString()}`);
  yaml.push("---");
  return yaml.join("\n") + "\n\n";
}

function quote(s: string): string {
  if (s == null) return '""';
  const needsQuote = /[:#\[\]{}&*!|>'%@`,\n]/.test(s) || /^\s|\s$/.test(s);
  const escaped = s.replace(/"/g, '\\"');
  return needsQuote ? `"${escaped}"` : `"${escaped}"`;
}
