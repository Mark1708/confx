import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deserializeJobState, loadLastJobState, saveJobState, serializeJobState } from "../../src/lib/export-state";
import type { ConfluencePageMeta, ExportJobConfig, ExportJobState } from "../../src/types";

const originalChrome = globalThis.chrome;

const pageMeta: ConfluencePageMeta = {
  id: "page-1",
  title: "Page title",
  spaceKey: "DOC",
  baseUrl: "https://confluence.example.com",
  url: "https://confluence.example.com/pages/page-1",
};

const configs: ExportJobConfig[] = [
  {
    kind: "extract-page",
    host: "https://confluence.example.com",
    presetId: "generic",
    pageId: "123",
  },
  {
    kind: "extract-subtree",
    host: "https://confluence.example.com",
    presetId: "generic",
    rootPageId: "root-1",
    maxDepth: 3,
  },
  {
    kind: "extract-block",
    host: "https://confluence.example.com",
    presetId: "generic",
    html: "<main>Content</main>",
    pageMeta,
  },
  {
    kind: "extract-space",
    host: "https://confluence.example.com",
    presetId: "generic",
    spaceKey: "DOC",
    spaceOptions: { label: "public", prefix: "Guide" },
    maxDepth: 2,
  },
  {
    kind: "extract-jira-issue",
    host: "https://jira.example.com",
    issueKey: "DOC-123",
  },
  {
    kind: "extract-jira-search",
    host: "https://jira.example.com",
    jql: "project = DOC ORDER BY updated DESC",
  },
];

const state: ExportJobState = {
  id: "job-1",
  status: "running",
  config: {
    kind: "extract-subtree",
    host: "https://confluence.example.com",
    presetId: "generic",
    rootPageId: "root-1",
    maxDepth: 3,
  },
  progress: {
    current: 2,
    total: 5,
    message: "Извлекаю страницу",
  },
  startedAt: "2026-05-27T12:00:00.000Z",
  resumeFromIndex: 1,
  processedPageIds: ["page-1", "page-2"],
};

describe("serialize/deserialize", () => {
  it("roundtrip: serialize -> deserialize -> deep equal", () => {
    const json = serializeJobState(state);

    expect(deserializeJobState(json)).toEqual(state);
  });

  it("deserialize invalid JSON returns null", () => {
    expect(deserializeJobState("{")).toBeNull();
  });

  it("deserialize missing version returns null", () => {
    const json = JSON.stringify(state);

    expect(deserializeJobState(json)).toBeNull();
  });

  it("deserialize with version=1 returns valid state", () => {
    const json = JSON.stringify({ version: 1, ...state });

    expect(deserializeJobState(json)).toEqual(state);
  });

  it.each(configs)("roundtrip preserves config for $kind", (config) => {
    const jobState = makeState(`job-${config.kind}`, config);

    const restored = deserializeJobState(serializeJobState(jobState));

    expect(restored).toEqual(jobState);
  });

  it("deserialize rejects invalid spaceOptions", () => {
    const json = JSON.stringify({
      version: 1,
      ...makeState("job-space", configs[3]),
      config: {
        ...configs[3],
        spaceOptions: { label: 123 },
      },
    });

    expect(deserializeJobState(json)).toBeNull();
  });
});

describe("loadLastJobState", () => {
  beforeEach(() => {
    installChromeStorageMock();
  });

  afterEach(() => {
    restoreChrome();
  });

  it("returns null when no export job state exists", async () => {
    await chrome.storage.session.set({ "other:key": serializeJobState(makeState("ignored", configs[0])) });

    await expect(loadLastJobState()).resolves.toBeNull();
  });

  it("returns the most recent saved export job state", async () => {
    const older = makeState("older", configs[0], "2026-05-27T10:00:00.000Z");
    const newer = makeState("newer", configs[5], "2026-05-27T11:00:00.000Z");

    await saveJobState(older);
    await saveJobState(newer);

    await expect(loadLastJobState()).resolves.toEqual(newer);
  });
});

function makeState(id: string, config: ExportJobConfig, startedAt = "2026-05-27T12:00:00.000Z"): ExportJobState {
  return {
    id,
    status: "running",
    config,
    progress: {
      current: 2,
      total: 5,
      message: "Извлекаю страницу",
    },
    startedAt,
    resumeFromIndex: 1,
    processedPageIds: ["page-1", "page-2"],
  };
}

function installChromeStorageMock(): void {
  let store: Record<string, unknown> = {};

  const session = {
    get: async (keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> => {
      if (keys === undefined || keys === null) return { ...store };
      if (typeof keys === "string") return { [keys]: store[keys] };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, store[key]]));
      return { ...keys, ...store };
    },
    set: async (items: Record<string, unknown>): Promise<void> => {
      store = { ...store, ...items };
    },
    remove: async (keys: string | string[]): Promise<void> => {
      const keySet = new Set(Array.isArray(keys) ? keys : [keys]);
      store = Object.fromEntries(Object.entries(store).filter(([key]) => !keySet.has(key)));
    },
  };

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: { storage: { session } },
  });
}

function restoreChrome(): void {
  if (originalChrome === undefined) {
    Reflect.deleteProperty(globalThis, "chrome");
    return;
  }

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: originalChrome,
  });
}
