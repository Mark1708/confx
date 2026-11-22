import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobStatus } from "@/sidepanel/components/JobStatus";
import type { ExportJobState } from "@/types";

vi.mock("@/sidepanel/hooks/useI18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

function snapshot(status: ExportJobState["status"] = "running"): ExportJobState {
  return {
    version: 2,
    id: "lorem-export",
    sourceKey: "7:confluence:https://wiki.example.test/wiki",
    owner: { instanceId: "other-ui", surface: "workspace", tabId: 91, windowId: 1 },
    request: { kind: "extract-page", destination: "download-zip", pageId: "100" },
    status,
    phase: "writing",
    message: "Writing Lorem content",
    counts: {
      processed: null,
      total: null,
      successfulPages: null,
      failedPages: null,
      successfulResources: null,
      failedResources: null,
      entriesWritten: null,
      bytesWritten: null,
    },
    cancelRequested: false,
  };
}

describe("workspace job status ownership", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  function button(label: string) {
    return [...container.querySelectorAll("button")].find((node) => node.textContent === label);
  }

  it("offers a foreign owner's surface instead of a nonfunctional cancel", async () => {
    const cancel = vi.fn();
    const focusOwner = vi.fn();
    await act(async () =>
      root.render(
        <JobStatus
          state={snapshot()}
          onCancel={cancel}
          ownsJob={false}
          busy
          onFocusOwner={focusOwner}
        />,
      ),
    );

    expect(button("jobs.cancel")).toBeUndefined();
    expect(button("jobs.focusOwner")).toBeDefined();
    await act(async () => button("jobs.focusOwner")!.click());
    expect(focusOwner).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    expect(container.textContent).toContain("jobs.foreignOwner");
  });

  it("only exposes cancellation for the actual live owner, including pending", async () => {
    const cancel = vi.fn();
    await act(async () =>
      root.render(
        <JobStatus
          state={snapshot("pending")}
          onCancel={cancel}
          ownsJob
          busy
          onFocusOwner={vi.fn()}
        />,
      ),
    );
    expect(container.textContent).toContain("jobs.pendingTitle");
    await act(async () => button("jobs.cancel")!.click());
    expect(cancel).toHaveBeenCalledOnce();

    await act(async () =>
      root.render(
        <JobStatus
          state={snapshot("interrupted")}
          onCancel={cancel}
          ownsJob={false}
          busy={false}
          onFocusOwner={vi.fn()}
        />,
      ),
    );
    expect(button("jobs.cancel")).toBeUndefined();
    expect(button("jobs.focusOwner")).toBeUndefined();
    expect(container.textContent).toContain("jobs.interruptedTitle");
  });

  it.each(["partial", "interrupted"] as const)(
    "keeps the %s terminal result visible without claiming it was fully saved",
    async (status) => {
      await act(async () =>
        root.render(
          <JobStatus
            state={{ ...snapshot(status), terminalReason: "Lorem incomplete" }}
            onCancel={vi.fn()}
            ownsJob={false}
            busy={false}
            onFocusOwner={vi.fn()}
          />,
        ),
      );
      expect(container.textContent).toContain(`jobs.${status}Title`);
      expect(container.textContent).toContain("Lorem incomplete");
      expect(container.textContent).not.toContain("jobs.savedBadge");
    },
  );

  it("localizes known destination failure reasons and keeps unknown ones verbatim", async () => {
    await act(async () =>
      root.render(
        <JobStatus
          state={{
            ...snapshot("failed"),
            error: "lorem detail",
            terminalReason: "zip-limit-exceeded",
          }}
          onCancel={vi.fn()}
          ownsJob={false}
          busy={false}
          onFocusOwner={vi.fn()}
        />,
      ),
    );
    expect(container.textContent).toContain("jobs.reasons.zipLimitExceeded");
    expect(container.textContent).toContain("lorem detail");
  });

  it("shows the created folder for a completed directory export", async () => {
    await act(async () =>
      root.render(
        <JobStatus
          state={{
            ...snapshot("completed"),
            result: { fileName: "lorem.zip", directoryName: "page-100-job" },
          }}
          onCancel={vi.fn()}
          ownsJob={false}
          busy={false}
          onFocusOwner={vi.fn()}
        />,
      ),
    );
    expect(container.textContent).toContain("jobs.directory");
    expect(container.textContent).toContain("page-100-job");
    expect(container.textContent).toContain("jobs.file");
    expect(container.textContent).toContain("lorem.zip");
  });

  it("does not fabricate percentages or zero counters for unmeasured statistics", async () => {
    await act(async () =>
      root.render(
        <JobStatus state={snapshot()} onCancel={vi.fn()} ownsJob busy onFocusOwner={vi.fn()} />,
      ),
    );
    expect(container.textContent).toContain("jobs.phases.writing");
    expect(container.textContent).toContain("Writing Lorem content");
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.textContent).not.toContain("0%");
    expect(container.textContent).not.toContain("jobs.successfulPages");
    expect(container.textContent).not.toContain("jobs.entriesWritten");
  });

  it("keeps a requested download cancellation visible while the save dialog is still open", async () => {
    const state = { ...snapshot(), phase: "downloading" as const, cancelRequested: true };
    await act(async () =>
      root.render(
        <JobStatus state={state} onCancel={vi.fn()} ownsJob busy onFocusOwner={vi.fn()} />,
      ),
    );
    expect(container.textContent).toContain("jobs.cancelRequested");
    expect(container.textContent).toContain("jobs.cancelSaveDialog");
    expect(button("jobs.cancel")).toBeUndefined();
  });
});
