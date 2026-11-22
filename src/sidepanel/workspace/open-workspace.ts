import { BrowserApi } from "@/lib/browser/browser-api";
import type { OpenWorkspaceRequest } from "@/types";

/** Always creates a new pinned tab; a live export owner is never reloaded or moved. */
export async function openWorkspaceTab(
  sourceTabId: number,
  tool: "export" | "edit",
): Promise<void> {
  const request: OpenWorkspaceRequest = { kind: "open-workspace", sourceTabId, tool };
  const response = await BrowserApi.sendMessage(request);
  if (!response || typeof response !== "object" || !("ok" in response) || response.ok !== true) {
    throw new Error(
      response && typeof response === "object" && "error" in response
        ? String(response.error)
        : "Could not open the workspace tab",
    );
  }
}
