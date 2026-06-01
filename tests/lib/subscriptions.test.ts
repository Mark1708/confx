import { describe, expect, it } from "vitest";
import type {
  PageSnapshot,
  Subscription,
  SubscriptionDiff,
} from "@/lib/subscriptions";
import {
  appendCheckHistory,
  diffSnapshots,
  MAX_CHECK_HISTORY_ENTRIES,
  summarizeDiff,
} from "@/lib/subscriptions";

describe("subscription check history", () => {
  it("summarizes snapshot diffs", () => {
    const diff = makeDiff();

    expect(summarizeDiff(diff)).toEqual({
      added: 1,
      removed: 1,
      changed: 1,
      moved: 1,
    });
  });

  it("appends a bounded check history entry without mutating subscription", () => {
    const subscription = makeSubscription();
    const diff = makeDiff("2026-05-30T10:00:00.000Z");

    const updated = appendCheckHistory(subscription, diff);

    expect(subscription.checkHistory).toBeUndefined();
    expect(updated.checkHistory).toHaveLength(1);
    expect(updated.checkHistory?.[0]).toEqual({
      checkedAt: diff.checkedAt,
      summary: summarizeDiff(diff),
      diff,
    });
  });

  it("keeps only latest history entries", () => {
    const subscription = Array.from({ length: MAX_CHECK_HISTORY_ENTRIES + 2 }).reduce(
      (current, _, index) =>
        appendCheckHistory(current, makeDiff(`2026-05-30T10:${String(index).padStart(2, "0")}:00.000Z`)),
      makeSubscription(),
    );

    expect(subscription.checkHistory).toHaveLength(MAX_CHECK_HISTORY_ENTRIES);
    expect(subscription.checkHistory?.[0].checkedAt).toBe("2026-05-30T10:02:00.000Z");
  });
});

describe("diffSnapshots", () => {
  it("reports added, removed, changed, and moved pages", () => {
    const prev: PageSnapshot = {
      unchanged: makeEntry("Unchanged", 1, "root"),
      changed: makeEntry("Changed", 1, "root"),
      moved: makeEntry("Moved", 1, "old-parent"),
      removed: makeEntry("Removed", 1, "root"),
    };
    const next: PageSnapshot = {
      unchanged: makeEntry("Unchanged", 1, "root"),
      changed: makeEntry("Changed", 2, "root"),
      moved: makeEntry("Moved", 1, "new-parent"),
      added: makeEntry("Added", 1, "root"),
    };

    const diff = diffSnapshots(prev, next, "2026-05-30T10:00:00.000Z");

    expect(diff.added.map((entry) => entry.pageId)).toEqual(["added"]);
    expect(diff.removed.map((entry) => entry.pageId)).toEqual(["removed"]);
    expect(diff.changed.map((entry) => entry.pageId)).toEqual(["changed"]);
    expect(diff.moved.map((entry) => entry.pageId)).toEqual(["moved"]);
  });
});

function makeSubscription(): Subscription {
  return {
    id: "page:wiki.example.com:root",
    scope: "page",
    host: "https://wiki.example.com",
    rootId: "root",
    rootTitle: "Root",
    createdAt: "2026-05-30T09:00:00.000Z",
    snapshot: { root: makeEntry("Root", 1) },
  };
}

function makeDiff(checkedAt = "2026-05-30T10:00:00.000Z"): SubscriptionDiff {
  return {
    checkedAt,
    added: [{ pageId: "added", title: "Added", kind: "added", toVersion: 1 }],
    removed: [{ pageId: "removed", title: "Removed", kind: "removed", fromVersion: 1 }],
    changed: [{ pageId: "changed", title: "Changed", kind: "changed", fromVersion: 1, toVersion: 2 }],
    moved: [{ pageId: "moved", title: "Moved", kind: "moved", fromParentId: "old", toParentId: "new" }],
  };
}

function makeEntry(title: string, version: number, parentId?: string) {
  return {
    title,
    version,
    updatedAt: "2026-05-30T09:00:00.000Z",
    updatedBy: "Tester",
    parentId,
  };
}
