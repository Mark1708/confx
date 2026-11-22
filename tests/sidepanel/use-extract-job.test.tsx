import { webcrypto } from "node:crypto";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { useExtractJob } from "@/sidepanel/hooks/useExtractJob";
import { ExportController } from "@/sidepanel/workspace/export-controller";

const hooks = vi.hoisted(() => ({ workspace: {} as Record<string, unknown> }));
vi.mock("@/sidepanel/workspace/WorkspaceProvider", () => ({
  useWorkspace: () => hooks.workspace,
}));
vi.mock("@/sidepanel/hooks/useI18n", async () => {
  const { createTranslator } = await import("@/i18n");
  const t = createTranslator("en");
  return { useI18n: () => ({ t }) };
});

const source = {
  tabId: 7,
  windowId: 1,
  product: "confluence",
  baseUrl: "https://wiki.example.test/wiki",
  pageUrl: "https://wiki.example.test/wiki/pages/viewpage.action?pageId=100",
  pageId: "100",
};
const request = {
  kind: "extract-page",
  host: source.baseUrl,
  pageId: "100",
  presetId: "md-only",
} as const;

describe("native export click activation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let controller: ExportController;
  let running: Promise<void> | undefined;

  function Host() {
    const job = useExtractJob();
    return (
      <>
        <button
          onClick={() => {
            running = job.run(request);
          }}
        >
          Start
        </button>
        <p>{job.defaultsError}</p>
      </>
    );
  }

  beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("isSecureContext", true);
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const owner = {
      instanceId: "picker-owner",
      surface: "workspace",
      tabId: 31,
      windowId: 1,
    } as const;
    controller = new ExportController({ owner, locks: null });
    hooks.workspace = {
      source,
      sourceKey: "7:confluence:https://wiki.example.test/wiki",
      draft: { destination: "directory", defaults: null },
      patchDraft: vi.fn(),
      controller,
      exportView: controller.getSnapshot(),
      settings: { data: DEFAULT_SETTINGS },
      store: {},
      binding: { owner },
    };
    running = undefined;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    controller.dispose();
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(["directory", "streamed-zip"] as const)(
    "%s opens the parent picker within the original synchronous click before any await",
    async (destination) => {
      const picked = Promise.withResolvers<FileSystemDirectoryHandle>();
      const sequence: string[] = [];
      vi.stubGlobal("showDirectoryPicker", () => {
        sequence.push("picker");
        return picked.promise;
      });
      hooks.workspace.draft = { destination, defaults: null };
      await act(async () => root.render(<Host />));
      try {
        await act(async () => {
          container.querySelector("button")!.click();
          sequence.push("click-returned");
        });
        expect(sequence).toEqual(["picker", "click-returned"]);
        expect(controller.getSnapshot()).toMatchObject({ selecting: true, state: null });
        expect(controller.cancel()).toBe(true);
      } finally {
        controller.dispose();
        picked.resolve({ kind: "directory" } as FileSystemDirectoryHandle);
        await act(async () => {
          await running;
        });
      }
      expect(controller.getSnapshot().state).toBeNull();
    },
  );

  it.each(["directory", "streamed-zip"] as const)(
    "%s stays unavailable without a directory picker instead of starting another destination",
    async (destination) => {
      vi.stubGlobal("showDirectoryPicker", undefined);
      hooks.workspace.draft = { destination, defaults: null };
      await act(async () => root.render(<Host />));
      await act(async () => {
        container.querySelector("button")!.click();
        await running;
      });
      expect(container.textContent).toContain("File System Access API");
      expect(controller.getSnapshot()).toMatchObject({
        selecting: false,
        busy: false,
        state: null,
      });
    },
  );
});
