import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateSettings } from "@/lib/settings";
import { makeSubscriptionId, type Subscription } from "@/lib/subscriptions";
import { checkSubscription, getSubscription, listSubscriptions } from "@/sidepanel/watch";

const memory = vi.hoisted(() => ({
  sync: {} as Record<string, unknown>,
  local: {} as Record<string, unknown>,
}));
vi.mock("@/lib/browser", () => ({
  storage: {
    sync: {
      get: async () => structuredClone(memory.sync),
      set: async (items: Record<string, unknown>) =>
        Object.assign(memory.sync, structuredClone(items)),
    },
    local: {
      get: async () => structuredClone(memory.local),
      set: async (items: Record<string, unknown>) =>
        Object.assign(memory.local, structuredClone(items)),
    },
  },
}));

const origin = "https://wiki.example.test";
const storeKey = "cx.subscriptions.v1";

function subscription(host: string, rootId = "100"): Subscription {
  return {
    id: makeSubscriptionId(host, rootId, "page"),
    host,
    scope: "page",
    rootId,
    rootTitle: "Lorem root",
    createdAt: "2026-01-01T00:00:00.000Z",
    snapshot: {
      [rootId]: { title: "Lorem root", version: 1, updatedAt: "", updatedBy: "" },
    },
    checkHistory: [
      {
        checkedAt: "2026-01-02T00:00:00.000Z",
        summary: { added: 0, removed: 0, changed: 1, moved: 0 },
        diff: {
          added: [],
          removed: [],
          moved: [],
          changed: [
            { pageId: rootId, title: "Lorem root", kind: "changed", fromVersion: 0, toVersion: 1 },
          ],
          checkedAt: "2026-01-02T00:00:00.000Z",
        },
      },
    ],
  };
}

function configure(override: string, subscriptions: Subscription[]) {
  memory.sync = {
    "cx.settings.v1": migrateSettings({ version: 4, confluenceBaseUrl: override }),
  };
  memory.local = { [storeKey]: { subscriptions: structuredClone(subscriptions) } };
}

describe("watch canonical source migration", () => {
  beforeEach(() => {
    memory.sync = {};
    memory.local = {};
  });
  afterEach(() => vi.unstubAllGlobals());

  it("moves legacy origin-only records to canonical IDs without losing their inline baselines", async () => {
    const original = subscription(origin);
    const other = subscription(origin, "101");
    configure(`${origin}/wiki`, [original, other]);

    const result = await listSubscriptions();

    expect(result).toEqual([
      {
        ...original,
        host: `${origin}/wiki`,
        id: makeSubscriptionId(`${origin}/wiki`, "100", "page"),
        sourceBaseVersion: 1,
      },
      {
        ...other,
        host: `${origin}/wiki`,
        id: makeSubscriptionId(`${origin}/wiki`, "101", "page"),
        sourceBaseVersion: 1,
      },
    ]);
    expect(memory.local[storeKey]).toEqual({ subscriptions: result });
    expect(await getSubscription(original.id)).toBeNull();
    expect(await getSubscription(result[0].id)).toEqual(result[0]);
  });

  it("pins a migrated root installation before a later same-origin override changes", async () => {
    configure("", [subscription(origin)]);
    const [first] = await listSubscriptions();
    memory.sync["cx.settings.v1"] = migrateSettings({
      version: 4,
      confluenceBaseUrl: `${origin}/wiki`,
    });

    const [next] = await listSubscriptions();

    expect(next.host).toBe(origin);
    expect(next.id).toBe(first.id);
    expect(next.snapshot).toEqual(first.snapshot);
  });

  it("rejects a canonical identity collision without overwriting either baseline", async () => {
    configure(`${origin}/wiki`, [subscription(origin), subscription(`${origin}/wiki`)]);
    const before = structuredClone(memory.local);

    await expect(listSubscriptions()).rejects.toThrow(/collision|conflict/i);

    expect(memory.local).toEqual(before);
  });

  it.each([
    [origin, "https://other.example.test/wiki", origin],
    [`${origin}/confluence`, `${origin}/wiki`, `${origin}/confluence`],
  ])(
    "checks %s at its own canonical base despite configured override %s",
    async (host, override, expectedBase) => {
      configure(override, [subscription(host)]);
      const requested: string[] = [];
      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        requested.push(String(input));
        return new Response(
          JSON.stringify({
            id: "100",
            title: "Lorem root",
            type: "page",
            status: "current",
            version: { number: 2 },
            space: { key: "LOREM" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });
      const [sub] = await listSubscriptions();

      const result = await checkSubscription(sub.id);

      expect(requested).toHaveLength(1);
      expect(requested[0].split("?")[0]).toBe(`${expectedBase}/rest/api/content/100`);
      expect(result.subscription.host).toBe(expectedBase);
      expect(result.diff.changed).toHaveLength(1);
      expect(result.subscription.snapshot).toEqual(subscription(host).snapshot);
    },
  );
});
