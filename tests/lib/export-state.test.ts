import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  deserializeJobState,
  loadLastJobState,
  saveJobState,
  serializeJobState,
} from "@/lib/export-state";
import type { ExportJobState } from "@/types";

function state(id = "job-1"): ExportJobState {
  return {
    version: 2,
    id,
    sourceKey: "11:confluence:https://wiki.example.com/wiki",
    owner: { instanceId: "surface-1", surface: "workspace", tabId: 31, windowId: 1 },
    request: {
      kind: "extract-subtree",
      destination: "download-zip",
      presetId: "md-only",
      rootPageId: "100",
      maxDepth: null,
    },
    status: "running",
    phase: "reading",
    message: "Reading Lorem",
    cancelRequested: false,
    counts: {
      processed: 2,
      total: 5,
      successfulPages: 2,
      failedPages: 0,
      successfulResources: null,
      failedResources: null,
      entriesWritten: null,
      bytesWritten: null,
    },
    startedAt: "2026-11-18T10:00:00.000Z",
  };
}

function legacy() {
  return {
    version: 1,
    id: "legacy-1",
    status: "running",
    config: {
      kind: "extract-block",
      host: "https://wiki.example.com/wiki",
      presetId: "generic",
      html: "<main>PRIVATE BODY</main>",
      pageMeta: { id: "100", title: "PRIVATE TITLE" },
      jql: "PRIVATE QUERY",
    },
    progress: { current: 2, total: 5, message: "" },
    processedPageIds: ["100", "101"],
    resumeFromIndex: 1,
    startedAt: "2026-11-18T09:00:00.000Z",
  };
}

let values: Record<string, unknown>;
let set: Mock<(items: Record<string, unknown>) => Promise<void>>;
let remove: Mock<(keys: string | string[]) => Promise<void>>;

beforeEach(() => {
  values = {};
  set = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(values, items);
  });
  remove = vi.fn(async (keys: string | string[]) => {
    for (const key of typeof keys === "string" ? [keys] : keys) delete values[key];
  });
  vi.stubGlobal("chrome", {
    storage: {
      session: {
        get: async (keys: string | string[] | null) =>
          keys === null
            ? { ...values }
            : Object.fromEntries(
                (typeof keys === "string" ? [keys] : keys).map((key) => [key, values[key]]),
              ),
        set,
        remove,
      },
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("metadata-only export snapshots", () => {
  it("whitelists every nested v2 object rather than persisting arbitrary caller data", () => {
    const input = {
      ...state(),
      html: "PRIVATE BODY",
      processedPageIds: ["100"],
      resumeFromIndex: 1,
      owner: { ...state().owner, headers: { Authorization: "PRIVATE HEADER" } },
      request: {
        ...state().request,
        html: "PRIVATE BODY",
        diff: { content: "PRIVATE DIFF" },
        jql: "PRIVATE QUERY",
        pageMeta: { title: "PRIVATE TITLE" },
      },
      counts: { ...state().counts, document: "PRIVATE DOCUMENT" },
    };
    const serialized = serializeJobState(input);
    const restored = deserializeJobState(serialized);
    expect(restored).toEqual(state());
    expect(serialized).not.toMatch(/PRIVATE|processedPageIds|resumeFromIndex|headers|pageMeta|jql/);
    expect(restored?.counts.entriesWritten).toBeNull();
    expect(restored?.counts.bytesWritten).toBeNull();
  });

  it("turns v1 into interrupted metadata without restoring HTML, query, or resume data", () => {
    const restored = deserializeJobState(JSON.stringify(legacy()));
    expect(restored).toMatchObject({
      version: 2,
      id: "legacy-1",
      status: "interrupted",
      owner: { surface: "unknown" },
      phase: null,
      request: { kind: "extract-block", destination: "download-zip" },
      counts: {
        processed: 2,
        total: 5,
        successfulPages: null,
        failedPages: null,
        successfulResources: null,
        failedResources: null,
        entriesWritten: null,
        bytesWritten: null,
      },
    });
    expect(JSON.stringify(restored)).not.toMatch(
      /PRIVATE|processedPageIds|resumeFromIndex|pageMeta|jql|"html"/,
    );
  });

  it.each([
    "{",
    JSON.stringify({ ...state(), version: 3 }),
    JSON.stringify({ ...state(), counts: { ...state().counts, bytesWritten: -1 } }),
  ])("rejects malformed or unsupported metadata: %s", (json) => {
    expect(deserializeJobState(json)).toBeNull();
  });

  it("saves v2 state and its active pointer together without v1 payload fields", async () => {
    const current = state();
    await saveJobState(current);
    expect(values["cx.export.active.v2"]).toBe(current.id);
    expect(deserializeJobState(String(values[`cx.exportJob.v2:${current.id}`]))).toEqual(current);
    expect(Object.keys(values).some((key) => key.startsWith("cx:exportJob:"))).toBe(false);
  });

  it("reads the active pointer rather than selecting an unrelated newest record", async () => {
    values["cx.export.active.v2"] = "active";
    values["cx.exportJob.v2:active"] = serializeJobState(state("active"));
    values["cx.exportJob.v2:unrelated"] = serializeJobState({
      ...state("unrelated"),
      startedAt: "2026-11-18T23:00:00.000Z",
    });
    await expect(loadLastJobState()).resolves.toMatchObject({ id: "active" });
  });

  it("stores sanitized legacy metadata before deleting the old payload and leaves import journal untouched", async () => {
    values["cx:exportJob:legacy-1"] = JSON.stringify(legacy());
    values["cx.import.run.v1"] = { lastPublication: "user-owned" };
    await expect(loadLastJobState()).resolves.toMatchObject({
      id: "legacy-1",
      status: "interrupted",
    });
    expect(values["cx:exportJob:legacy-1"]).toBeUndefined();
    expect(values["cx.export.active.v2"]).toBe("legacy-1");
    expect(String(values["cx.exportJob.v2:legacy-1"])).not.toContain("PRIVATE");
    expect(values["cx.import.run.v1"]).toEqual({ lastPublication: "user-owned" });
    expect(set.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0]);
  });

  it("does not erase the only legacy record if sanitized persistence fails", async () => {
    values["cx:exportJob:legacy-1"] = JSON.stringify(legacy());
    set.mockRejectedValue(new Error("session quota"));
    await expect(loadLastJobState()).rejects.toThrow("session quota");
    expect(values["cx:exportJob:legacy-1"]).toBeDefined();
    expect(remove).not.toHaveBeenCalled();
  });

  it("surfaces storage failure instead of reporting that a snapshot was saved", async () => {
    set.mockRejectedValue(new Error("session quota"));
    await expect(saveJobState(state())).rejects.toThrow("session quota");
  });
});
