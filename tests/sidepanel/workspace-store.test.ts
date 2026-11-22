import { describe, expect, it } from "vitest";
import { sourceKey, type SourceContext } from "@/lib/source-context";
import { WorkspaceStore, type WorkspaceLock } from "@/sidepanel/workspace/workspace-store";

function memorySession() {
  const values: Record<string, unknown> = {};
  let queued = Promise.resolve();
  const lock: WorkspaceLock = (task) => {
    const next = queued.then(task);
    queued = next.then(
      () => {},
      () => {},
    );
    return next;
  };
  return {
    lock,
    values,
    get: async (keys: string | string[] | null) => {
      const names = keys === null ? Object.keys(values) : typeof keys === "string" ? [keys] : keys;
      return Object.fromEntries(names.map((key) => [key, structuredClone(values[key])]));
    },
    set: async (items: Record<string, unknown>) => {
      Object.assign(values, structuredClone(items));
    },
  };
}

const source: SourceContext = {
  tabId: 7,
  windowId: 3,
  product: "confluence",
  baseUrl: "https://wiki.example.com/wiki",
  pageUrl: "https://wiki.example.com/wiki/pages/viewpage.action?pageId=1000",
  pageId: "1000",
};

describe("source-scoped workspace", () => {
  it("restores selected root, filter, expansion and section instead of following same-source page navigation", async () => {
    const session = memorySession();
    const store = new WorkspaceStore(session, session.lock);
    await store.hydrate();
    store.activate(source);
    const key = sourceKey(source);
    const initial = store.getSnapshot().drafts.get(key)!;
    store.update(key, {
      section: "watch",
      scope: "subtree",
      subtree: {
        ...initial.subtree,
        rootId: "1100",
        treeRootId: "1000",
        filter: "Lorem table",
        expandedIds: ["1000", "1100"],
      },
    });
    await store.flush();

    const restored = new WorkspaceStore(session, session.lock);
    await restored.hydrate();
    restored.activate({
      ...source,
      pageId: "1700",
      pageUrl: "https://wiki.example.com/wiki/pages/1700",
    });
    const draft = restored.getSnapshot().drafts.get(key)!;
    expect(draft.section).toBe("watch");
    expect(draft.scope).toBe("subtree");
    expect(draft.subtree).toMatchObject({
      rootId: "1100",
      treeRootId: "1000",
      filter: "Lorem table",
      expandedIds: ["1000", "1100"],
    });
    restored.activate(null);
    expect(restored.getSnapshot().activeKey).toBe(key);
    expect(restored.getSnapshot().drafts.get(key)?.scope).toBe("subtree");
  });

  it("keeps independent drafts for another tab or origin and returns to the first selection", async () => {
    const session = memorySession();
    const store = new WorkspaceStore(session, session.lock);
    await store.hydrate();
    store.activate(source);
    store.update(sourceKey(source), { scope: "subtree", section: "edit" });
    const sameSiteOtherTab = { ...source, tabId: 8 };
    store.activate(sameSiteOtherTab);
    store.update(sourceKey(sameSiteOtherTab), { scope: "space" });
    const otherSite = {
      ...source,
      baseUrl: "https://other.example.com/wiki",
      pageUrl: "https://other.example.com/wiki/pages/1000",
    };
    store.activate(otherSite);
    store.update(sourceKey(otherSite), { scope: "fragment" });
    store.activate(source);
    expect(store.getSnapshot().drafts.get(sourceKey(source))).toMatchObject({
      scope: "subtree",
      section: "edit",
    });
    expect(store.getSnapshot().drafts.get(sourceKey(sameSiteOtherTab))?.scope).toBe("space");
    expect(store.getSnapshot().drafts.get(sourceKey(otherSite))?.scope).toBe("fragment");
    await store.flush();
  });

  it("does not persist document payloads or handles smuggled alongside allowed draft metadata", async () => {
    const session = memorySession();
    const store = new WorkspaceStore(session, session.lock);
    await store.hydrate();
    store.activate(source);
    store.update(sourceKey(source), {
      scope: "subtree",
      html: "LOREM_PRIVATE_DOCUMENT_BODY",
      file: new Blob(["LOREM_PRIVATE_FILE"]),
      handle: { name: "LOREM_PRIVATE_DIRECTORY", createWritable: () => {} },
    } as Parameters<WorkspaceStore["update"]>[1]);
    await store.flush();
    const serialized = JSON.stringify(session.values["cx.workspace.v1"]);
    expect(serialized).not.toContain("LOREM_PRIVATE_");
    const restored = new WorkspaceStore(session, session.lock);
    await restored.hydrate();
    expect(restored.getSnapshot().drafts.get(sourceKey(source))?.scope).toBe("subtree");
  });
  it("does not erase another source when two already-open surfaces save their drafts", async () => {
    const session = memorySession();
    const first = new WorkspaceStore(session, session.lock);
    const second = new WorkspaceStore(session, session.lock);
    await Promise.all([first.hydrate(), second.hydrate()]);
    first.activate(source);
    first.update(sourceKey(source), { section: "watch", scope: "subtree" });
    await first.flush();
    const other = { ...source, tabId: 8 };
    second.activate(other);
    second.update(sourceKey(other), { scope: "space" });
    await second.flush();
    const restored = new WorkspaceStore(session, session.lock);
    await restored.hydrate();
    expect(restored.getSnapshot().drafts.get(sourceKey(source))).toMatchObject({
      section: "watch",
      scope: "subtree",
    });
    expect(restored.getSnapshot().drafts.get(sourceKey(other))?.scope).toBe("space");
  });

  it("merges disjoint source edits instead of writing another surface's stale fields", async () => {
    const session = memorySession();
    const first = new WorkspaceStore(session, session.lock);
    await first.hydrate();
    first.activate(source);
    await first.flush();
    const second = new WorkspaceStore(session, session.lock);
    await second.hydrate();
    first.update(sourceKey(source), { section: "watch" });
    await first.flush();
    second.update(sourceKey(source), { space: { label: "Lorem", prefix: "ipsum" } });
    await second.flush();
    const restored = new WorkspaceStore(session, session.lock);
    await restored.hydrate();
    expect(restored.getSnapshot().drafts.get(sourceKey(source))).toMatchObject({
      section: "watch",
      space: { label: "Lorem", prefix: "ipsum" },
    });
  });
});
