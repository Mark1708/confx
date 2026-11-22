import { Blob as NodeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { produceJiraExport } from "@/lib/export/jira";
import { collectExport } from "../helpers/export-collector";
import { prepareExport } from "@/lib/export/prepare";
import { createExportDefaults, migrateSettings } from "@/lib/settings";
import type { SourceContext } from "@/lib/source-context";
import type { ExportPresetId } from "@/types";

const BASE = "https://jira.example.test/jira";
const source: SourceContext = {
  tabId: 7,
  windowId: 1,
  product: "jira",
  baseUrl: BASE,
  pageUrl: `${BASE}/browse/LOREM-1`,
  issueKey: "LOREM-1",
};
const issue = {
  key: "LOREM-1",
  fields: {
    summary: "Lorem issue",
    description: "Lorem issue description",
    project: { key: "LOREM" },
    issuetype: { name: "Task" },
    status: { name: "Open" },
    created: "2026-01-01T12:00:00Z",
    updated: "2026-01-02T12:00:00Z",
    attachment: [
      {
        id: "lorem-file",
        filename: "lorem.txt",
        mimeType: "text/plain",
        size: 12,
        content: `${BASE}/attachment/lorem.txt`,
      },
    ],
  },
};

function settingsFor(presetId: ExportPresetId) {
  const settings = migrateSettings(undefined);
  settings.exportDefaults = createExportDefaults(presetId);
  settings.maxRetries = 0;
  settings.locale = "en";
  return settings;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}

async function entriesFor(result: { zipBlob: Blob }) {
  return unzipSync(new Uint8Array(await result.zipBlob.arrayBuffer()));
}
async function drain(rounds = 50): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

describe("prepared Jira exports", () => {
  beforeEach(() => {
    vi.stubGlobal("Blob", NodeBlob);
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("chrome", {
      storage: {
        sync: {
          get: vi.fn(() => {
            throw new Error("Unexpected settings reread");
          }),
        },
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.origin !== new URL(BASE).origin) throw new Error(`Wrong frozen origin: ${url}`);
        if (url.pathname === "/jira/rest/api/2/issue/LOREM-1") return jsonResponse(issue);
        if (url.pathname === "/jira/rest/api/2/issue/LOREM-1/comment")
          return jsonResponse({
            comments: [
              {
                id: "lorem-comment",
                body: "Lorem comment",
                author: { key: "lorem" },
                created: "2026-01-01T12:00:00Z",
              },
            ],
          });
        if (url.pathname === "/jira/rest/api/2/search") return jsonResponse({ issues: [issue] });
        if (url.pathname === "/jira/attachment/lorem.txt") return new Response("Lorem bytes");
        throw new Error(`Unexpected Jira request: ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(["issue", "search"])(
    "%s reports only actually written issue resources and entries",
    async (mode) => {
      const settings = settingsFor("md-attachments");
      const result =
        mode === "issue"
          ? await collectExport(
              produceJiraExport,
              prepareExport(
                source,
                { kind: "extract-jira-issue", host: BASE, issueKey: "LOREM-1" },
                settings,
              ),
            )
          : await collectExport(
              produceJiraExport,
              prepareExport(
                source,
                { kind: "extract-jira-search", host: BASE, jql: "project = LOREM" },
                settings,
              ),
            );
      const entries = await entriesFor(result);
      const markdown = Object.entries(entries).find(([path]) => path.endsWith("/index.md"))!;
      expect(strFromU8(markdown[1])).toContain("Lorem issue description");
      expect(Object.keys(entries).some((path) => path.endsWith("/lorem.txt"))).toBe(true);
      expect(result).toHaveProperty("outcome", {
        partial: false,
        successfulPages: 1,
        failedPages: 0,
        successfulResources: 1,
        failedResources: 0,
        entriesWritten: Object.keys(entries).length,
      });
    },
  );

  it("keeps source, comments, resource policy and front matter frozen after preparation", async () => {
    const settings = settingsFor("md-only");
    settings.exportDefaults.package.comments = false;
    settings.exportDefaults.conversion.includeFrontMatter = false;
    const prepared = prepareExport(
      source,
      { kind: "extract-jira-issue", host: BASE, issueKey: "LOREM-1" },
      settings,
    );
    settings.exportDefaults.package.comments = true;
    settings.exportDefaults.package.attachments = true;
    settings.exportDefaults.presetId = "md-attachments";
    settings.exportDefaults.conversion.includeFrontMatter = true;
    settings.confluenceBaseUrl = "https://other.example.test";

    const entries = await entriesFor(await collectExport(produceJiraExport, prepared));
    expect(Object.keys(entries)).toEqual(["LOREM-1/index.md", "LOREM-1/issue.json"]);
    expect(strFromU8(entries["LOREM-1/index.md"])).toMatch(/^# LOREM-1/);
    expect(strFromU8(entries["LOREM-1/index.md"])).not.toContain("Lorem comment");
    expect(JSON.parse(strFromU8(entries["LOREM-1/issue.json"]))).toMatchObject({
      comments: [],
      attachments: [],
    });
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/comment"))).toBe(
      false,
    );
    expect(chrome.storage.sync.get).not.toHaveBeenCalled();
  });

  it("retains explicitly enabled comments but never downloads md-only resources", async () => {
    const settings = settingsFor("md-only");
    settings.exportDefaults.package.comments = true;
    settings.exportDefaults.package.attachments = true;
    const entries = await entriesFor(
      await collectExport(
        produceJiraExport,
        prepareExport(
          source,
          { kind: "extract-jira-issue", host: BASE, issueKey: "LOREM-1" },
          settings,
        ),
      ),
    );

    expect(strFromU8(entries["LOREM-1/index.md"])).toContain("Lorem comment");
    expect(Object.keys(entries).some((path) => path.includes("/attachments/"))).toBe(false);
    expect(
      vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/attachment/")),
    ).toBe(false);
  });

  it("writes enabled Jira attachment bytes and honors the prepared size limit", async () => {
    const settings = settingsFor("md-attachments");
    settings.exportDefaults.package.attachments = true;
    const prepared = prepareExport(
      source,
      { kind: "extract-jira-issue", host: BASE, issueKey: "LOREM-1" },
      settings,
    );
    const entries = await entriesFor(await collectExport(produceJiraExport, prepared));
    expect(strFromU8(entries["LOREM-1/attachments/lorem.txt"])).toBe("Lorem bytes");

    settings.maxAttachmentSize = 1;
    const limitedResult = await collectExport(
      produceJiraExport,
      prepareExport(
        source,
        { kind: "extract-jira-issue", host: BASE, issueKey: "LOREM-1" },
        settings,
      ),
    );
    const limited = await entriesFor(limitedResult);
    expect(limitedResult.outcome).toMatchObject({
      partial: true,
      successfulPages: 1,
      failedPages: 0,
      successfulResources: 0,
      failedResources: 0,
      entriesWritten: Object.keys(limited).length,
    });
    expect(Object.keys(limited).some((path) => path.includes("/attachments/"))).toBe(false);
  });

  it("keeps a failed binary online and reports a completed partial issue without a phantom file", async () => {
    const originalFetch = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === `${BASE}/attachment/lorem.txt`)
          return new Response("", { status: 503 });
        return originalFetch(input, init);
      }),
    );
    const result = await collectExport(
      produceJiraExport,
      prepareExport(
        source,
        { kind: "extract-jira-issue", host: BASE, issueKey: "LOREM-1" },
        settingsFor("md-attachments"),
      ),
    );
    const entries = await entriesFor(result);
    expect(Object.keys(entries)).toEqual(["LOREM-1/index.md", "LOREM-1/issue.json"]);
    expect(JSON.parse(strFromU8(entries["LOREM-1/issue.json"])).attachments[0].contentUrl).toBe(
      `${BASE}/attachment/lorem.txt`,
    );
    expect(result.outcome).toEqual({
      partial: true,
      successfulPages: 1,
      failedPages: 0,
      successfulResources: 0,
      failedResources: 1,
      entriesWritten: 2,
    });
  });

  it("does not turn a writer failure into a partial resource omission", async () => {
    const writerError = new Error("Synthetic Jira destination failure");
    const emit = vi.fn(async () => {
      if (emit.mock.calls.length === 3) throw writerError;
    });
    await expect(
      produceJiraExport(
        prepareExport(
          source,
          { kind: "extract-jira-issue", host: BASE, issueKey: "LOREM-1" },
          settingsFor("md-attachments"),
        ),
        { signal: new AbortController().signal, onPackage: vi.fn() },
        emit,
      ),
    ).rejects.toBe(writerError);
    expect(emit).toHaveBeenCalledTimes(3);
  });

  it("aborts sibling reads on a fatal parallel load and preserves the original failure after cleanup", async () => {
    const settings = settingsFor("md-attachments");
    settings.exportDefaults.package.comments = true;
    const description = { requests: 0, aborted: false };
    const cleanupTail = Promise.withResolvers<void>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.origin !== new URL(BASE).origin) throw new Error(`Wrong frozen origin: ${url}`);
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
        if (url.pathname === "/jira/rest/api/2/issue/LOREM-1") return jsonResponse(issue);
        if (url.pathname === "/jira/rest/api/2/issue/LOREM-1/comment")
          return new Response("", { status: 500, statusText: "Server Error" });
        throw new Error(`Unexpected Jira request: ${url}`);
      }),
    );
    const observed = { settled: false, error: undefined as unknown };
    const run = produceJiraExport(
      prepareExport(
        source,
        { kind: "extract-jira-issue", host: BASE, issueKey: "LOREM-1" },
        settings,
      ),
      { signal: new AbortController().signal, onPackage: vi.fn() },
      vi.fn(async () => {}),
    ).then(
      () => {
        observed.settled = true;
      },
      (error: unknown) => {
        observed.error = error;
        observed.settled = true;
      },
    );
    await drain();
    expect(description.requests).toBe(1);
    expect(description.aborted).toBe(true);
    expect(observed.settled).toBe(false);
    cleanupTail.resolve();
    await run;
    expect(observed.error).toMatchObject({ name: "ApiError", status: 500 });
    await drain();
    expect(description.requests).toBe(1);
  });

  it("stops before further entries or attachment reads when cancellation arrives after a write", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Synthetic cancellation", "AbortError");
    const emit = vi.fn(async () => {
      controller.abort(reason);
    });
    await expect(
      produceJiraExport(
        prepareExport(
          source,
          { kind: "extract-jira-issue", host: BASE, issueKey: "LOREM-1" },
          settingsFor("md-attachments"),
        ),
        { signal: controller.signal, onPackage: vi.fn() },
        emit,
      ),
    ).rejects.toBe(reason);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/attachment/")),
    ).toBe(false);
  });

  it("keeps the canonical source issue key as the human package name", async () => {
    const originalFetch = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (new URL(String(input)).pathname === "/jira/rest/api/2/issue/lorem-1")
          return jsonResponse(issue);
        return originalFetch(input, init);
      }),
    );
    const settings = settingsFor("md-attachments");
    settings.exportDefaults.package.comments = false;
    const result = await collectExport(
      produceJiraExport,
      prepareExport(
        source,
        { kind: "extract-jira-issue", host: BASE, issueKey: "lorem-1" },
        settings,
      ),
    );
    expect(result.fileName).toBe("LOREM-1.zip");
    expect(result.rootName).toBe("LOREM-1");
    expect(Object.keys(await entriesFor(result)).every((path) => path.startsWith("LOREM-1/"))).toBe(
      true,
    );
  });

  it.each(["issue", "search"])(
    "%s tables-only writes CSV before its honest service index and nothing else",
    async (mode) => {
      const settings = settingsFor("tables-only");
      settings.exportDefaults.package = {
        editable: true,
        images: true,
        attachments: true,
        plantUmlAssets: true,
        comments: true,
        history: true,
      };
      const result =
        mode === "issue"
          ? await collectExport(
              produceJiraExport,
              prepareExport(
                source,
                { kind: "extract-jira-issue", host: BASE, issueKey: "LOREM-1" },
                settings,
              ),
            )
          : await collectExport(
              produceJiraExport,
              prepareExport(
                source,
                { kind: "extract-jira-search", host: BASE, jql: "project = LOREM" },
                settings,
              ),
            );
      const entries = await entriesFor(result);
      const paths = Object.keys(entries);
      expect(paths).toHaveLength(2);
      expect(paths[0]).toMatch(/\.csv$/);
      expect(paths[1]).toMatch(/\/index\.md$/);
      expect(strFromU8(entries[paths[0]])).toContain("LOREM-1,LOREM,Task,Open");
      const index = strFromU8(entries[paths[1]]);
      const target = index.match(/\]\(([^)]+\.csv)\)/)?.[1];
      expect(target).toBeDefined();
      expect(paths[1].replace(/index\.md$/, "") + target).toBe(paths[0]);
      expect(index).not.toContain("Lorem issue description");
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(([input]) =>
            /\/(comment|attachment)\b|fields=description/.test(String(input)),
          ),
      ).toBe(false);
      expect(chrome.storage.sync.get).not.toHaveBeenCalled();
    },
  );
});
