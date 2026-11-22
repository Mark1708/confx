import type { DestinationKind } from "@/lib/export/contracts";
import type { SourceContext } from "@/lib/source-context";
import type { ExportDefaults } from "@/types";

export type WorkspaceSection = "export" | "edit" | "watch";
export type ExportScope = "page" | "subtree" | "space" | "fragment" | "issue" | "search";
export type WorkspaceSource = Pick<SourceContext, "tabId" | "windowId" | "product" | "baseUrl">;

export interface WorkspaceDraft {
  source: WorkspaceSource;
  section: WorkspaceSection;
  scope: ExportScope;
  defaults: ExportDefaults | null;
  destination: DestinationKind;
  subtree: {
    rootId?: string;
    treeRootId?: string;
    filter: string;
    expandedIds: string[];
    serverSearch: {
      status: "idle" | "searching" | "done" | "error";
      query: string;
      count: number;
      error?: string;
    };
  };
  space: { spaceKey?: string; label: string; prefix: string };
  jira: { jql: string };
  watch: { expandedId: string | null; selectedPageIds: Record<string, string[]> };
  lastIntentIds: { open?: string; picker?: string };
}

export type WorkspaceDraftPatch = Partial<Omit<WorkspaceDraft, "source">>;

export interface WorkspaceSnapshot {
  hydrated: boolean;
  activeKey: string | null;
  drafts: ReadonlyMap<string, WorkspaceDraft>;
  error: string | null;
}
