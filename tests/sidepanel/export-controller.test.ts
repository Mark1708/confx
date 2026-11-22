import { Blob as NodeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ExportSink,
  ExportSummary,
  PreparedExport,
  ProgressHandler,
} from "@/lib/export/contracts";
import { createStreamedZipSink, DestinationCollisionError } from "@/lib/export/sinks";
import { ZipLimitExceededError } from "@/lib/export/zip-encoder";
import { serializeJobState } from "@/lib/export-state";
import { createExportDefaults, migrateSettings } from "@/lib/settings";
import type { SourceContext } from "@/lib/source-context";
import {
  ExportController,
  type ExportControllerOptions,
  type ExportSinkFactories,
} from "@/sidepanel/workspace/export-controller";
import {
  SinkWriterError,
  type ExportRunner,
  type ExportRunResult,
  type SinkOpener,
} from "@/sidepanel/workspace/run-export";
import type { ExportJobOwner, ExportJobState } from "@/types";

const SOURCE: SourceContext = {
  tabId: 11,
  windowId: 1,
  product: "confluence",
  baseUrl: "https://wiki.example.com/wiki",
  pageUrl: "https://wiki.example.com/wiki/pages/viewpage.action?pageId=100",
  pageId: "100",
};
const OWNER: ExportJobOwner = {
  instanceId: "owner-a",
  surface: "workspace",
  tabId: 31,
  windowId: 1,
};
const DIRECTORY_HANDLE = { kind: "directory" } as unknown as FileSystemDirectoryHandle;
const PACKAGE_INFO = { rootName: "page-100", fileName: "lorem.zip" } as const;
const RESULT: ExportRunResult = {
  fileName: "lorem.zip",
  outcome: {
    partial: false,
    successfulPages: 1,
    failedPages: 0,
    successfulResources: null,
    failedResources: null,
    entriesWritten: 1,
  },
  receipt: { fileName: "lorem.zip", entriesWritten: 1, bytesWritten: 3 },
};
function deferred<T>() {
  return Promise.withResolvers<T>();
}

/** A runner that initializes the destination sink and reports its real finish receipt. */
function runner(): ExportRunner {
  return vi.fn(
    async (
      _prepared: PreparedExport,
      _onProgress: ProgressHandler,
      _signal: AbortSignal,
      openSink: SinkOpener,
    ) => {
      const sink = await openSink(PACKAGE_INFO);
      const receipt = await sink.finish(
        { ...PACKAGE_INFO, outcome: RESULT.outcome } as ExportSummary,
        new AbortController().signal,
      );
      return { fileName: receipt.fileName, outcome: RESULT.outcome, receipt };
    },
  );
}

function sinkStub(receipt: (summary: { fileName: string }) => ExportRunResult["receipt"]) {
  const sink: ExportSink = {
    write: vi.fn(async () => {}),
    finish: vi.fn(async (summary: { fileName: string }) => receipt(summary)),
    abort: vi.fn(async () => {}),
    stats: () => ({ entriesWritten: 1, bytesWritten: 3 }),
  };
  return sink;
}

function fakeSinks(): ExportSinkFactories & { directory: ReturnType<typeof vi.fn> } {
  return {
    memory: (rootName) => ({
      sink: sinkStub((summary) => ({
        fileName: summary.fileName,
        entriesWritten: 1,
        bytesWritten: 3,
      })),
      blob: async () => new Blob(["zip"]),
    }),
    directory: vi.fn(async () =>
      sinkStub((summary) => ({
        fileName: summary.fileName,
        directoryName: "page-100-job",
        entriesWritten: 1,
        bytesWritten: 5,
      })),
    ),
    streamed: vi.fn(async () =>
      sinkStub((summary) => ({ fileName: summary.fileName, entriesWritten: 1, bytesWritten: 3 })),
    ),
  };
}

function streamedDestination(
  hooks: {
    beforeCreateWritable?: () => Promise<void>;
    beforeClose?: () => Promise<void>;
  } = {},
) {
  const files = new Map<string, Uint8Array<ArrayBuffer> | null>();
  const calls = { opened: 0, written: 0, closed: 0, aborted: 0 };
  const parent = {
    kind: "directory",
    async getFileHandle(name: string, options?: FileSystemGetFileOptions) {
      if (!files.has(name)) {
        if (!options?.create) throw new DOMException("File not found", "NotFoundError");
        files.set(name, null);
      }
      return {
        async createWritable() {
          calls.opened += 1;
          await hooks.beforeCreateWritable?.();
          const parts: Uint8Array<ArrayBuffer>[] = [];
          return {
            async write(data: Uint8Array<ArrayBuffer>) {
              calls.written += 1;
              parts.push(data);
            },
            async close() {
              calls.closed += 1;
              await hooks.beforeClose?.();
              files.set(name, new Uint8Array(await new NodeBlob(parts).arrayBuffer()));
            },
            async abort() {
              calls.aborted += 1;
            },
          };
        },
      };
    },
  } as unknown as FileSystemDirectoryHandle;
  return { parent, files, calls };
}

class OriginLocks {
  held = false;
  beforeGrant: (() => void | Promise<void>) | null = null;
  private queue: Array<() => void> = [];

  request<T>(
    _name: string,
    options: { ifAvailable?: true; signal?: AbortSignal },
    callback: (lock: Lock | null) => T | Promise<T>,
  ): Promise<T> {
    if (this.held && options.ifAvailable) return Promise.resolve(callback(null));
    const result = Promise.withResolvers<T>();
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      result.reject(new DOMException("Aborted", "AbortError"));
    };
    const grant = async () => {
      options.signal?.removeEventListener("abort", onAbort);
      if (aborted || options.signal?.aborted) {
        result.reject(new DOMException("Aborted", "AbortError"));
        this.release();
        return;
      }
      this.held = true;
      try {
        const before = this.beforeGrant;
        this.beforeGrant = null;
        await before?.();
        result.resolve(await callback({ name: "cx.export.v2", mode: "exclusive" } as Lock));
      } catch (error) {
        result.reject(error);
      } finally {
        this.release();
      }
    };
    if (this.held) {
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(() => {
        void grant();
      });
    } else {
      void grant();
    }
    return result.promise;
  }

  private release() {
    const next = this.queue.shift();
    this.held = next !== undefined;
    next?.();
  }
}

function sessionStorage() {
  const values: Record<string, unknown> = {};
  const listeners = new Set<
    (changes: Record<string, chrome.storage.StorageChange>, area: string) => void
  >();
  let beforeSet: ((items: Record<string, unknown>) => Promise<void>) | null = null;
  const session = {
    get: vi.fn(async (keys: string | string[] | null) => {
      if (keys === null) return { ...values };
      return Object.fromEntries(
        (typeof keys === "string" ? [keys] : keys).map((key) => [key, values[key]]),
      );
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      await beforeSet?.(items);
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: values[key], newValue: value };
        values[key] = value;
      }
      for (const listener of listeners) listener(changes, "session");
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of typeof keys === "string" ? [keys] : keys) delete values[key];
    }),
  };
  vi.stubGlobal("chrome", {
    storage: {
      session,
      onChanged: {
        addListener: (
          listener: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void,
        ) => listeners.add(listener),
        removeListener: (
          listener: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void,
        ) => listeners.delete(listener),
      },
    },
  });
  return {
    values,
    session,
    delaySet: (handler: typeof beforeSet) => {
      beforeSet = handler;
    },
  };
}

function prepare(
  controller: ExportController,
  destination: PreparedExport["destination"] = "download-zip",
) {
  const settings = migrateSettings(undefined);
  return controller.prepare(
    SOURCE,
    {
      request: { kind: "extract-page", host: SOURCE.baseUrl, pageId: "100", presetId: "md-only" },
      defaults: settings.exportDefaults,
      destination,
    },
    settings,
  );
}

function savedState(id: string, status: ExportJobState["status"]): ExportJobState {
  return {
    version: 2,
    id,
    sourceKey: "11:confluence:https://wiki.example.com/wiki",
    owner: OWNER,
    request: { kind: "extract-page", destination: "download-zip", pageId: "100" },
    status,
    phase: "reading",
    message: "",
    cancelRequested: false,
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
  };
}

async function drainMicrotasks() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

function whenIdle(value: ExportController) {
  if (!value.getSnapshot().busy) return Promise.resolve();
  const idle = Promise.withResolvers<void>();
  const stop = value.subscribe(() => {
    if (!value.getSnapshot().busy) {
      stop();
      idle.resolve();
    }
  });
  return idle.promise;
}

const controllers: ExportController[] = [];
function controller(options: ExportControllerOptions) {
  const value = new ExportController({ sinks: fakeSinks(), ...options });
  controllers.push(value);
  return value;
}

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
  for (const value of controllers.splice(0)) value.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("origin-wide export ownership", () => {
  it("does not grant a foreign UI cancellation or a second run even with copied owner metadata", async () => {
    sessionStorage();
    const locks = new OriginLocks();
    const entered = deferred<void>();
    const release = deferred<ExportRunResult>();
    const runExport = vi.fn(
      async (
        _prepared: PreparedExport,
        _onProgress: ProgressHandler,
        _signal: AbortSignal,
        openSink: SinkOpener,
      ) => {
        await openSink(PACKAGE_INFO);
        entered.resolve();
        return release.promise;
      },
    );
    const download = vi.fn(async () => 71);
    const owner = controller({ owner: OWNER, locks, runExport, download });
    await owner.initialize();
    const running = owner.start(prepare(owner), "download-zip");
    await entered.promise;

    const foreign = controller({ owner: OWNER, locks, runExport, download });
    await foreign.initialize();
    expect(foreign.getSnapshot()).toMatchObject({
      busy: true,
      ownsJob: false,
      state: { status: "running" },
    });
    expect(foreign.cancel()).toBe(false);
    await foreign.start(prepare(foreign), "download-zip");
    expect(runExport).toHaveBeenCalledTimes(1);
    expect(owner.getSnapshot().state?.cancelRequested).toBe(false);

    const released = whenIdle(foreign);
    release.resolve(RESULT);
    await running;
    await released;
    expect(foreign.getSnapshot()).toMatchObject({
      busy: false,
      ownsJob: false,
      state: { status: "completed" },
    });
  });

  it("holds ownership through cancelled runner cleanup and actual download cleanup", async () => {
    sessionStorage();
    const locks = new OriginLocks();
    const downloadEntered = deferred<void>();
    const cleanup = deferred<number>();
    const owner = controller({
      owner: OWNER,
      locks,
      runExport: runner(),
      download: async () => {
        downloadEntered.resolve();
        return cleanup.promise;
      },
    });
    await owner.initialize();
    const running = owner.start(prepare(owner), "download-zip");
    await downloadEntered.promise;
    expect(owner.cancel()).toBe(true);
    expect(owner.cancel()).toBe(true);
    expect(locks.held).toBe(true);
    expect(owner.getSnapshot()).toMatchObject({
      busy: true,
      ownsJob: true,
      state: { cancelRequested: true },
    });
    const secondRun = runner();
    const foreign = controller({
      owner: { ...OWNER, instanceId: "owner-b" },
      locks,
      runExport: secondRun,
      download: async () => 72,
    });
    await foreign.initialize();
    await foreign.start(prepare(foreign), "download-zip");
    expect(secondRun).not.toHaveBeenCalled();
    cleanup.resolve(71);
    await running;
    expect(owner.getSnapshot()).toMatchObject({
      busy: false,
      ownsJob: false,
      state: { status: "cancelled" },
    });
  });

  it("keeps the lock while an aborted runner releases its resources", async () => {
    sessionStorage();
    const locks = new OriginLocks();
    const entered = deferred<void>();
    const cleanup = deferred<ExportRunResult>();
    const download = vi.fn(async () => 71);
    const owner = controller({
      owner: OWNER,
      locks,
      download,
      runExport: async (_prepared, _progress, signal, openSink) => {
        await openSink(PACKAGE_INFO);
        entered.resolve();
        await cleanup.promise;
        signal.throwIfAborted();
        return RESULT;
      },
    });
    await owner.initialize();
    const running = owner.start(prepare(owner), "download-zip");
    await entered.promise;
    owner.cancel();
    expect(locks.held).toBe(true);
    cleanup.resolve(RESULT);
    await running;
    expect(download).not.toHaveBeenCalled();
    expect(owner.getSnapshot().state?.status).toBe("cancelled");
  });

  it("aborts the job signal when a fatal run fails without cancellation semantics", async () => {
    sessionStorage();
    const locks = new OriginLocks();
    const entered = deferred<void>();
    let jobSignal: AbortSignal | undefined;
    const owner = controller({
      owner: OWNER,
      locks,
      runExport: async (_prepared, _onProgress, signal, openSink) => {
        jobSignal = signal;
        await openSink(PACKAGE_INFO);
        entered.resolve();
        throw new Error("Synthetic fatal source failure");
      },
    });
    await owner.initialize();
    await owner.start(prepare(owner), "download-zip");
    expect(jobSignal?.aborted).toBe(true);
    expect(owner.getSnapshot().state).toMatchObject({
      status: "failed",
      cancelRequested: false,
      terminalReason: "export-failed",
    });
    expect(owner.getSnapshot().busy).toBe(false);
    expect(locks.held).toBe(false);
  });

  it("keeps the export lock until aborted sibling source reads settle after a fatal parallel batch", async () => {
    sessionStorage();
    const locks = new OriginLocks();
    const jiraSource: SourceContext = {
      tabId: 11,
      windowId: 1,
      product: "jira",
      baseUrl: "https://jira.example.test/jira",
      pageUrl: "https://jira.example.test/jira/browse/LOREM-1",
      issueKey: "LOREM-1",
    };
    const issueJson = {
      key: "LOREM-1",
      fields: {
        summary: "Lorem issue",
        description: "Lorem issue description",
        project: { key: "LOREM" },
        issuetype: { name: "Task" },
        status: { name: "Open" },
        created: "2026-01-01T12:00:00Z",
        updated: "2026-01-02T12:00:00Z",
      },
    };
    const description = { requests: 0, aborted: false };
    const cleanupTail = Promise.withResolvers<void>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (
          url.pathname === "/jira/rest/api/2/issue/LOREM-1" &&
          url.searchParams.get("fields") === "description"
        ) {
          description.requests += 1;
          const read = Promise.withResolvers<Response>();
          const abort = (): void => {
            if (description.aborted) return;
            description.aborted = true;
            void cleanupTail.promise.then(() =>
              read.reject(new DOMException("The operation was aborted.", "AbortError")),
            );
          };
          const signal = init?.signal;
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
          return read.promise;
        }
        if (url.pathname === "/jira/rest/api/2/issue/LOREM-1")
          return new Response(JSON.stringify(issueJson), {
            headers: { "Content-Type": "application/json" },
          });
        if (url.pathname === "/jira/rest/api/2/issue/LOREM-1/comment")
          return new Response("", { status: 500, statusText: "Server Error" });
        throw new Error(`Unexpected Jira request: ${url}`);
      }),
    );
    const download = vi.fn(async () => 71);
    const owner = controller({ owner: OWNER, locks, download });
    await owner.initialize();
    const settings = migrateSettings(undefined);
    settings.exportDefaults = createExportDefaults("md-attachments");
    settings.exportDefaults.package.comments = true;
    settings.maxRetries = 0;
    settings.locale = "en";
    const running = owner.start(
      owner.prepare(
        jiraSource,
        {
          request: { kind: "extract-jira-issue", host: jiraSource.baseUrl, issueKey: "LOREM-1" },
          defaults: settings.exportDefaults,
          destination: "download-zip",
        },
        settings,
      ),
      "download-zip",
    );
    for (let index = 0; index < 200 && description.requests === 0; index += 1) {
      await Promise.resolve();
    }
    expect(description.requests).toBe(1);
    await drainMicrotasks();
    expect(description.aborted).toBe(true);
    expect(locks.held).toBe(true);
    expect(owner.getSnapshot().busy).toBe(true);
    expect(owner.getSnapshot().state?.status).toBe("running");
    cleanupTail.resolve();
    await running;
    expect(owner.getSnapshot().state).toMatchObject({ status: "failed" });
    expect(owner.getSnapshot().error).toMatch(/500/);
    expect(owner.getSnapshot().busy).toBe(false);
    expect(locks.held).toBe(false);
    expect(description.requests).toBe(1);
    expect(download).not.toHaveBeenCalled();
  });

  it("re-reads the active pointer inside the acquired stale-reconciliation lock", async () => {
    const store = sessionStorage();
    const locks = new OriginLocks();
    store.values["cx.export.active.v2"] = "old";
    store.values["cx.exportJob.v2:old"] = serializeJobState(savedState("old", "running"));
    locks.beforeGrant = () => {
      store.values["cx.export.active.v2"] = "new";
      store.values["cx.exportJob.v2:new"] = serializeJobState(savedState("new", "completed"));
    };
    const observer = controller({ owner: OWNER, locks });
    await observer.initialize();
    expect(observer.getSnapshot()).toMatchObject({
      busy: false,
      state: { id: "new", status: "completed" },
    });
    expect(JSON.parse(String(store.values["cx.exportJob.v2:new"])).status).toBe("completed");
  });

  it("observes owner loss through the queued lock without a storage, channel, or tab event", async () => {
    const store = sessionStorage();
    const locks = new OriginLocks();
    store.values["cx.export.active.v2"] = "lost";
    store.values["cx.exportJob.v2:lost"] = serializeJobState(savedState("lost", "running"));
    const ownerGone = deferred<void>();
    const externalOwner = locks.request(
      "cx.export.v2",
      { ifAvailable: true },
      async () => ownerGone.promise,
    );
    const observer = controller({ owner: OWNER, locks });
    await observer.initialize();
    expect(observer.getSnapshot()).toMatchObject({
      busy: true,
      ownsJob: false,
      state: { status: "running" },
    });
    const released = whenIdle(observer);
    ownerGone.resolve();
    await externalOwner;
    await released;
    expect(observer.getSnapshot()).toMatchObject({
      busy: false,
      ownsJob: false,
      state: { status: "interrupted" },
    });
    expect(JSON.parse(String(store.values["cx.exportJob.v2:lost"])).status).toBe("interrupted");
  });

  it("marks unowned running metadata interrupted instead of offering fake cancellation", async () => {
    const store = sessionStorage();
    store.values["cx.export.active.v2"] = "orphan";
    store.values["cx.exportJob.v2:orphan"] = serializeJobState(savedState("orphan", "running"));
    const observer = controller({ owner: OWNER, locks: new OriginLocks() });
    await observer.initialize();
    expect(observer.getSnapshot()).toMatchObject({
      busy: false,
      ownsJob: false,
      state: { status: "interrupted" },
    });
    expect(observer.cancel()).toBe(false);
  });

  it.each([
    ["directory", "dispose"],
    ["directory", "cancel"],
    ["streamed-zip", "dispose"],
    ["streamed-zip", "cancel"],
  ] as const)(
    "%s %s invalidates a pending parent picker without a job or file creation",
    async (destination, action) => {
      const store = sessionStorage();
      const selection = deferred<FileSystemDirectoryHandle>();
      const runExport = runner();
      const getFileHandle = vi.fn();
      const owner = controller({ owner: OWNER, locks: new OriginLocks(), runExport });
      await owner.initialize();
      const starting = owner.start(prepare(owner, destination), selection.promise);
      expect(owner.getSnapshot().selecting).toBe(true);
      expect(Object.keys(store.values)).toEqual([]);
      owner[action]();
      selection.resolve({
        kind: "directory",
        getFileHandle,
      } as unknown as FileSystemDirectoryHandle);
      await starting;
      expect(runExport).not.toHaveBeenCalled();
      expect(getFileHandle).not.toHaveBeenCalled();
      expect(Object.keys(store.values)).toEqual([]);
    },
  );

  it("keeps disk destinations locked to the workspace surface without touching the handle", async () => {
    const store = sessionStorage();
    const getFileHandle = vi.fn();
    const owner = controller({
      owner: { ...OWNER, surface: "panel" },
      locks: new OriginLocks(),
    });
    await owner.initialize();
    await owner.start(
      prepare(owner, "streamed-zip"),
      Promise.resolve({
        kind: "directory",
        getFileHandle,
      } as unknown as FileSystemDirectoryHandle),
    );
    expect(owner.getSnapshot()).toMatchObject({
      busy: false,
      state: null,
      error: expect.stringMatching(/workspace/i),
    });
    expect(getFileHandle).not.toHaveBeenCalled();
    expect(Object.keys(store.values)).toEqual([]);
  });

  it.each(["directory", "streamed-zip"] as const)(
    "rejects a file handle for %s before any job or writable",
    async (destination) => {
      const store = sessionStorage();
      const createWritable = vi.fn();
      const owner = controller({ owner: OWNER, locks: new OriginLocks() });
      await owner.initialize();
      await owner.start(
        prepare(owner, destination),
        Promise.resolve({
          kind: "file",
          createWritable,
        } as unknown as FileSystemDirectoryHandle),
      );
      expect(owner.getSnapshot()).toMatchObject({
        busy: false,
        state: null,
        error: expect.stringMatching(/directory choice/i),
      });
      expect(createWritable).not.toHaveBeenCalled();
      expect(Object.keys(store.values)).toEqual([]);
    },
  );

  it("classifies a denied picker as permission denied and a cancelled picker as silent", async () => {
    const store = sessionStorage();
    const owner = controller({ owner: OWNER, locks: new OriginLocks() });
    await owner.initialize();
    await owner.start(
      prepare(owner, "directory"),
      Promise.reject(new DOMException("Picker denied", "NotAllowedError")),
    );
    expect(owner.getSnapshot()).toMatchObject({
      state: null,
      error: "NotAllowedError: Picker denied",
      errorCode: "permission-denied",
    });
    await owner.start(
      prepare(owner, "directory"),
      Promise.reject(new DOMException("The user aborted a request", "AbortError")),
    );
    expect(owner.getSnapshot()).toMatchObject({ state: null, error: null, errorCode: null });
    expect(Object.keys(store.values)).toEqual([]);
  });

  it("rejects cross-origin requests and a Watch request from another canonical base before retargeting", async () => {
    sessionStorage();
    const owner = controller({ owner: OWNER, locks: new OriginLocks() });
    await owner.initialize();
    const settings = migrateSettings(undefined);
    const draft = { defaults: settings.exportDefaults, destination: "download-zip" as const };
    expect(() =>
      owner.prepare(
        SOURCE,
        {
          ...draft,
          request: {
            kind: "extract-page",
            host: "https://other.example.com/wiki",
            pageId: "100",
            presetId: "md-only",
          },
        },
        settings,
      ),
    ).toThrow(/source|origin/i);
    expect(() =>
      owner.prepare(
        SOURCE,
        {
          ...draft,
          request: {
            kind: "extract-watch-changed",
            host: "https://wiki.example.com/confluence",
            presetId: "md-only",
            pageIds: ["100"],
            rootTitle: "Lorem",
            diff: {},
          },
        },
        settings,
      ),
    ).toThrow(/source|base/i);
    expect(prepare(owner).source.baseUrl).toBe(SOURCE.baseUrl);
  });

  it("fails closed on initial persistence failure before producer or download I/O", async () => {
    const store = sessionStorage();
    store.delaySet(async () => {
      throw new Error("session unavailable");
    });
    const runExport = runner();
    const download = vi.fn(async () => 71);
    const owner = controller({ owner: OWNER, locks: new OriginLocks(), runExport, download });
    await owner.initialize();
    await owner.start(prepare(owner), "download-zip");
    expect(runExport).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(owner.getSnapshot().error).toMatch(/persist|session unavailable/i);
    expect(owner.getSnapshot().busy).toBe(false);
  });

  it("persists queued progress before terminal state and ignores late producer notifications", async () => {
    const store = sessionStorage();
    const progressEntered = deferred<void>();
    const releaseWrite = deferred<void>();
    const releaseRun = deferred<ExportRunResult>();
    let notify!: ProgressHandler;
    store.delaySet(async (items) => {
      const raw = Object.entries(items).find(([key]) => key.startsWith("cx.exportJob.v2:"))?.[1];
      if (typeof raw === "string" && JSON.parse(raw).message === "blocked progress") {
        progressEntered.resolve();
        await releaseWrite.promise;
      }
    });
    const owner = controller({
      owner: OWNER,
      locks: new OriginLocks(),
      download: async () => 71,
      runExport: async (_prepared, progress, _signal, openSink) => {
        await openSink(PACKAGE_INFO);
        notify = progress;
        progress({ current: 1, total: 2, message: "blocked progress", phase: "reading" });
        return releaseRun.promise;
      },
    });
    await owner.initialize();
    const prepared = prepare(owner);
    const running = owner.start(prepared, "download-zip");
    await progressEntered.promise;
    releaseRun.resolve(RESULT);
    await drainMicrotasks();
    expect(owner.getSnapshot().busy).toBe(true);
    releaseWrite.resolve();
    await running;
    notify({ current: 2, total: 2, message: "late running", phase: "reading" });
    await drainMicrotasks();
    const saved = JSON.parse(String(store.values[`cx.exportJob.v2:${prepared.id}`]));
    expect(saved.status).toBe("completed");
    expect(saved.message).not.toBe("late running");
    expect(owner.getSnapshot().busy).toBe(false);
  });

  it("refuses to start without real Web Locks rather than falling back to a storage claim", async () => {
    const store = sessionStorage();
    const runExport = runner();
    const owner = controller({ owner: OWNER, locks: null, runExport });
    await owner.initialize();
    await owner.start(prepare(owner), "download-zip");
    expect(runExport).not.toHaveBeenCalled();
    expect(Object.keys(store.values)).toEqual([]);
    expect(owner.getSnapshot().error).toMatch(/lock|not supported/i);
  });

  it("does not display fake running metadata when lock ownership cannot be supported", async () => {
    const store = sessionStorage();
    store.values["cx.export.active.v2"] = "unverifiable";
    store.values["cx.exportJob.v2:unverifiable"] = serializeJobState(
      savedState("unverifiable", "running"),
    );
    const observer = controller({ owner: OWNER, locks: null });
    await observer.initialize();
    expect(observer.getSnapshot()).toMatchObject({
      busy: false,
      ownsJob: false,
      state: { status: "interrupted" },
    });
    expect(observer.cancel()).toBe(false);
    expect(store.session.set).not.toHaveBeenCalled();
  });

  it("keeps output completion truthful and exposes terminal persistence failure", async () => {
    const store = sessionStorage();
    const download = vi.fn(async () => 71);
    store.delaySet(async (items) => {
      if (
        Object.values(items).some(
          (value) => typeof value === "string" && value.includes('"status":"completed"'),
        )
      ) {
        throw new Error("terminal metadata unavailable");
      }
    });
    const owner = controller({
      owner: OWNER,
      locks: new OriginLocks(),
      runExport: runner(),
      download,
    });
    await owner.initialize();
    await owner.start(prepare(owner), "download-zip");
    expect(download).toHaveBeenCalledTimes(1);
    expect(owner.getSnapshot()).toMatchObject({
      busy: false,
      state: { status: "completed" },
      error: expect.stringMatching(/persist|terminal metadata unavailable/i),
    });
  });
});

describe("disk destinations", () => {
  it("completes a directory export with the created folder and no download handoff", async () => {
    sessionStorage();
    const directory = vi.fn(async () =>
      sinkStub((summary) => ({
        fileName: summary.fileName,
        directoryName: "page-100-job",
        entriesWritten: 1,
        bytesWritten: 5,
      })),
    );
    const sinks: ExportSinkFactories = { ...fakeSinks(), directory };
    const download = vi.fn(async () => 71);
    const owner = controller({
      owner: OWNER,
      locks: new OriginLocks(),
      runExport: runner(),
      download,
      sinks,
    });
    await owner.initialize();
    const prepared = prepare(owner, "directory");
    await owner.start(prepared, Promise.resolve(DIRECTORY_HANDLE));
    expect(owner.getSnapshot().state).toMatchObject({
      status: "completed",
      phase: expect.not.stringMatching(/downloading/),
      result: { fileName: "lorem.zip", directoryName: "page-100-job" },
    });
    expect(download).not.toHaveBeenCalled();
  });

  it("creates the actual package's unique ZIP and holds ownership through close and terminal persistence", async () => {
    const store = sessionStorage();
    const locks = new OriginLocks();
    const closing = deferred<void>();
    const releaseClose = deferred<void>();
    const persisting = deferred<void>();
    const releasePersistence = deferred<void>();
    const destination = streamedDestination({
      beforeCreateWritable: async () => {
        expect(locks.held).toBe(true);
      },
      beforeClose: async () => {
        expect(locks.held).toBe(true);
        closing.resolve();
        await releaseClose.promise;
      },
    });
    store.delaySet(async (items) => {
      if (
        Object.values(items).some(
          (value) => typeof value === "string" && value.includes('"status":"completed"'),
        )
      ) {
        persisting.resolve();
        await releasePersistence.promise;
      }
    });
    const download = vi.fn(async () => 71);
    const info = { rootName: "actual-package", fileName: "actual-package.zip" };
    const owner = controller({
      owner: OWNER,
      locks,
      sinks: { ...fakeSinks(), streamed: createStreamedZipSink },
      download,
      runExport: async (_prepared, _progress, signal, openSink) => {
        const sink = await openSink(info);
        await sink.write({ path: "index.md", body: "# Lorem actual package" }, signal);
        const receipt = await sink.finish({ ...info, outcome: RESULT.outcome }, signal);
        return { fileName: receipt.fileName, outcome: RESULT.outcome, receipt };
      },
    });
    await owner.initialize();
    const prepared = prepare(owner, "streamed-zip");
    const fileName = `actual-package-${prepared.id}.zip`;
    const running = owner.start(prepared, Promise.resolve(destination.parent));
    await closing.promise;
    expect(locks.held).toBe(true);
    expect(owner.getSnapshot()).toMatchObject({ busy: true, state: { status: "running" } });
    expect(destination.files.get(fileName)).toBeNull();
    releaseClose.resolve();
    await persisting.promise;
    expect(locks.held).toBe(true);
    releasePersistence.resolve();
    await running;

    const bytes = destination.files.get(fileName)!;
    expect([...destination.files.keys()]).toEqual([fileName]);
    expect(strFromU8(unzipSync(bytes)["actual-package/index.md"])).toBe("# Lorem actual package");
    expect(owner.getSnapshot()).toMatchObject({
      busy: false,
      state: {
        status: "completed",
        result: { fileName },
        counts: { entriesWritten: 1, bytesWritten: bytes.byteLength },
      },
    });
    const saved = JSON.parse(String(store.values[`cx.exportJob.v2:${prepared.id}`]));
    expect(saved.counts.bytesWritten).toBe(bytes.byteLength);
    expect(locks.held).toBe(false);
    expect(download).not.toHaveBeenCalled();
  });

  it("reports an actual streamed collision without opening a writable or changing existing bytes", async () => {
    sessionStorage();
    const destination = streamedDestination();
    const owner = controller({
      owner: OWNER,
      locks: new OriginLocks(),
      runExport: runner(),
      sinks: { ...fakeSinks(), streamed: createStreamedZipSink },
    });
    await owner.initialize();
    const prepared = prepare(owner, "streamed-zip");
    const fileName = `page-100-${prepared.id}.zip`;
    const previous = new TextEncoder().encode("existing ZIP bytes");
    destination.files.set(fileName, previous);
    await owner.start(prepared, Promise.resolve(destination.parent));

    expect(owner.getSnapshot()).toMatchObject({
      busy: false,
      errorCode: "destination-collision",
      state: { status: "failed", terminalReason: "destination-collision" },
    });
    expect(owner.getSnapshot().state?.result).toBeUndefined();
    expect(destination.files.get(fileName)).toEqual(previous);
    expect(destination.calls.opened).toBe(0);
  });

  it.each(["cancel", "dispose"] as const)(
    "%s waits for a late streamed writable to abort before releasing ownership",
    async (action) => {
      const store = sessionStorage();
      const locks = new OriginLocks();
      const creating = deferred<void>();
      const releaseCreate = deferred<void>();
      const destination = streamedDestination({
        beforeCreateWritable: () => {
          creating.resolve();
          return releaseCreate.promise;
        },
      });
      const previous = new TextEncoder().encode("unrelated file bytes");
      destination.files.set("existing.zip", previous);
      const owner = controller({
        owner: OWNER,
        locks,
        runExport: runner(),
        sinks: { ...fakeSinks(), streamed: createStreamedZipSink },
      });
      await owner.initialize();
      const prepared = prepare(owner, "streamed-zip");
      const running = owner.start(prepared, Promise.resolve(destination.parent));
      await creating.promise;
      owner[action]();
      expect(locks.held).toBe(true);
      releaseCreate.resolve();
      await running;

      const status = action === "cancel" ? "cancelled" : "interrupted";
      const observer = controller({
        owner: { ...OWNER, instanceId: "after-late-writable" },
        locks,
      });
      await observer.initialize();
      expect(observer.getSnapshot()).toMatchObject({ busy: false, state: { status } });
      expect(observer.getSnapshot().state?.result).toBeUndefined();
      expect(JSON.parse(String(store.values[`cx.exportJob.v2:${prepared.id}`])).status).toBe(
        status,
      );
      expect(locks.held).toBe(false);
      expect(destination.calls).toEqual({ opened: 1, written: 0, closed: 0, aborted: 1 });
      expect(destination.files.get("existing.zip")).toEqual(previous);
      expect(destination.files.get(`page-100-${prepared.id}.zip`)).toBeNull();
    },
  );

  it("marks writer failures, ZIP limits, and destination collisions with distinct terminals", async () => {
    sessionStorage();
    const cases: Array<{ error: unknown; reason: string }> = [
      { error: new SinkWriterError(new Error("write failed")), reason: "writer-failure" },
      {
        error: new SinkWriterError(
          new ZipLimitExceededError("Archive exceeds the supported ZIP32 size"),
        ),
        reason: "zip-limit-exceeded",
      },
      { error: new DestinationCollisionError("page-100-job"), reason: "destination-collision" },
      {
        error: new SinkWriterError(new DOMException("Access revoked", "NotAllowedError")),
        reason: "permission-denied",
      },
    ];
    for (const { error, reason } of cases) {
      const owner = controller({
        owner: OWNER,
        locks: new OriginLocks(),
        runExport: async (_prepared, _progress, _signal, openSink) => {
          await openSink(PACKAGE_INFO);
          throw error;
        },
      });
      await owner.initialize();
      await owner.start(prepare(owner, "directory"), Promise.resolve(DIRECTORY_HANDLE));
      expect(owner.getSnapshot().state).toMatchObject({ status: "failed", terminalReason: reason });
      expect(owner.getSnapshot().errorCode).toBe(reason);
    }
  });

  it("aborts the directory sink and records cancellation when the run is cancelled mid-write", async () => {
    sessionStorage();
    const entered = deferred<void>();
    const directorySink = sinkStub((summary) => ({
      fileName: summary.fileName,
      directoryName: "page-100-job",
      entriesWritten: 0,
      bytesWritten: 0,
    }));
    const owner = controller({
      owner: OWNER,
      locks: new OriginLocks(),
      sinks: { ...fakeSinks(), directory: vi.fn(async () => directorySink) },
      runExport: async (_prepared, _progress, signal, openSink) => {
        await openSink(PACKAGE_INFO);
        entered.resolve();
        const aborted = Promise.withResolvers<unknown>();
        signal.addEventListener("abort", () => aborted.reject(signal.reason), { once: true });
        throw await aborted.promise;
      },
    });
    await owner.initialize();
    const running = owner.start(prepare(owner, "directory"), Promise.resolve(DIRECTORY_HANDLE));
    await entered.promise;
    expect(owner.cancel()).toBe(true);
    await running;
    expect(owner.getSnapshot().state).toMatchObject({ status: "cancelled" });
    expect(directorySink.abort).toHaveBeenCalledTimes(1);
  });
});
