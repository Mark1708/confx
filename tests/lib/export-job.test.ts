import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExportJob } from "@/lib/export-job";
import { prepareExport } from "@/lib/export/prepare";
import { migrateSettings } from "@/lib/settings";
import type { ExportJobOwner } from "@/types";

const OWNER: ExportJobOwner = {
  instanceId: "surface-1",
  surface: "workspace",
  tabId: 31,
  windowId: 1,
};
function job() {
  const settings = migrateSettings(undefined);
  return new ExportJob(
    prepareExport(
      {
        tabId: 11,
        windowId: 1,
        product: "confluence",
        baseUrl: "https://wiki.example.com/wiki",
        pageUrl: "https://wiki.example.com/wiki/pages/viewpage.action?pageId=100",
      },
      {
        kind: "extract-block",
        html: "<main>PRIVATE BODY</main>",
        presetId: "md-only",
        pageMeta: {
          id: "100",
          title: "PRIVATE TITLE",
          spaceKey: "DOC",
          baseUrl: "https://wiki.example.com/wiki",
          url: "https://wiki.example.com/wiki/pages/100",
        },
      },
      settings,
    ),
    OWNER,
  );
}
const outcome = {
  partial: false,
  successfulPages: 1,
  failedPages: 0,
  successfulResources: null,
  failedResources: null,
  entriesWritten: null,
};

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("export job metadata lifecycle", () => {
  it("does not invent resource or writer measurements and never retains the fragment body", () => {
    const value = job();
    const snapshot = value.toState();
    expect(snapshot).toMatchObject({
      version: 2,
      status: "pending",
      owner: OWNER,
      counts: {
        processed: 0,
        total: null,
        successfulPages: null,
        failedPages: null,
        successfulResources: null,
        failedResources: null,
        entriesWritten: null,
        bytesWritten: null,
      },
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE|pageMeta|"html"|"config"|resume/);
  });

  it("cannot complete a pending job that has not run or written output", () => {
    const value = job();
    expect(() => value.complete({ fileName: "lorem.zip" }, outcome)).toThrow(/transition/i);
    expect(value.toState().status).toBe("pending");
  });

  it("requests abort immediately but settles cancellation only after the owner cleans up", () => {
    const value = job();
    value.start();
    const signal = value.signal;
    value.cancel();
    value.cancel();
    expect(signal.aborted).toBe(true);
    expect(value.toState()).toMatchObject({ status: "running", cancelRequested: true });
    value.finishCancelled();
    expect(value.toState()).toMatchObject({ status: "cancelled", completedAt: expect.any(String) });
    expect(() => value.start()).toThrow(/transition/i);
  });

  it("aborts outstanding work on failure without recasting the terminal reason as cancellation", () => {
    const value = job();
    value.start();
    const signal = value.signal;
    value.fail("Jira API 500 @ /rest/api/2/issue/LOREM-1/comment", "export-failed");
    expect(signal.aborted).toBe(true);
    expect(value.toState()).toMatchObject({
      status: "failed",
      cancelRequested: false,
      terminalReason: "export-failed",
      error: "Jira API 500 @ /rest/api/2/issue/LOREM-1/comment",
    });
  });

  it("uses explicit phase and counters while retaining truthful null measurements", () => {
    const value = job();
    value.start();
    value.updateProgress({
      current: 2,
      total: 5,
      message: "Lorem",
      phase: "writing",
      counts: { successfulPages: 2, failedPages: 0 },
    });
    expect(value.toState()).toMatchObject({
      phase: "writing",
      message: "Lorem",
      counts: {
        processed: 2,
        total: 5,
        successfulPages: 2,
        failedPages: 0,
        entriesWritten: null,
        bytesWritten: null,
      },
    });
  });

  it("preserves partial evidence without inventing unknown resource measurements", () => {
    const complete = job();
    complete.start();
    complete.complete({ fileName: "lorem.zip", downloadId: 71 }, outcome);
    expect(complete.toState()).toMatchObject({
      status: "completed",
      result: { fileName: "lorem.zip", downloadId: 71 },
      counts: {
        successfulPages: 1,
        failedPages: 0,
        successfulResources: null,
        failedResources: null,
        entriesWritten: null,
      },
    });
    const partial = job();
    partial.start();
    partial.complete({ fileName: "lorem.zip", downloadId: 72 }, { ...outcome, partial: true });
    expect(partial.toState()).toMatchObject({
      status: "partial",
      counts: { failedResources: null },
    });
  });

  it("ignores progress after terminal state and does not let external snapshots mutate live metadata", () => {
    const value = job();
    value.start();
    value.complete({ fileName: "lorem.zip" }, outcome);
    const before = value.toState();
    before.counts.processed = 999;
    before.owner.instanceId = "foreign";
    value.updateProgress({ current: 100, total: 100, message: "late", phase: "reading" });
    expect(value.toState()).toMatchObject({ status: "completed", owner: OWNER, message: "" });
    expect(value.toState().counts.processed).not.toBe(999);
    expect(() => value.fail("late failure")).toThrow(/transition/i);
  });
});
