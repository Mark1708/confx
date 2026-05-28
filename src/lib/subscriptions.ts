import type { SubscriptionScope } from "@/types";
import { storage } from "@/lib/browser";

/**
 * Снимок одной страницы, достаточный для детекции изменений.
 * Хранится компактно: только то, что реально меняется у страницы в Confluence.
 */
export interface PageSnapshotEntry {
  title: string;
  version: number;
  updatedAt: string;
  updatedBy: string;
  parentId?: string;
}

export type PageSnapshot = Record<string, PageSnapshotEntry>;

export interface Subscription {
  id: string;
  scope: SubscriptionScope;
  host: string;
  rootId: string;
  rootTitle: string;
  spaceKey?: string;
  createdAt: string;
  lastCheckedAt?: string;
  /** Результат последней проверки (для бейджа/сводки). */
  lastDiffSummary?: {
    added: number;
    removed: number;
    changed: number;
    moved: number;
  };
  snapshot: PageSnapshot;
}

export interface DiffEntry {
  pageId: string;
  title: string;
  kind: "added" | "removed" | "changed" | "moved";
  fromVersion?: number;
  toVersion?: number;
  updatedAt?: string;
  updatedBy?: string;
  fromParentId?: string;
  toParentId?: string;
}

export interface SubscriptionDiff {
  added: DiffEntry[];
  removed: DiffEntry[];
  changed: DiffEntry[];
  moved: DiffEntry[];
  checkedAt: string;
}

const STORAGE_KEY = "cx.subscriptions.v1";

interface StoredShape {
  subscriptions: Subscription[];
}

async function load(): Promise<StoredShape> {
  const { [STORAGE_KEY]: stored } = await storage.local.get(STORAGE_KEY);
  if (!stored) return { subscriptions: [] };
  return stored as StoredShape;
}

async function save(state: StoredShape): Promise<void> {
  await storage.local.set({ [STORAGE_KEY]: state });
}

export async function listSubscriptions(): Promise<Subscription[]> {
  const { subscriptions } = await load();
  return [...subscriptions].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getSubscription(id: string): Promise<Subscription | null> {
  const { subscriptions } = await load();
  return subscriptions.find((s) => s.id === id) ?? null;
}

export async function upsertSubscription(sub: Subscription): Promise<void> {
  const state = await load();
  const idx = state.subscriptions.findIndex((s) => s.id === sub.id);
  if (idx >= 0) state.subscriptions[idx] = sub;
  else state.subscriptions.push(sub);
  await save(state);
}

export async function deleteSubscription(id: string): Promise<void> {
  const state = await load();
  state.subscriptions = state.subscriptions.filter((s) => s.id !== id);
  await save(state);
}

export function makeSubscriptionId(host: string, rootId: string, scope: SubscriptionScope): string {
  const hostKey = host.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `${scope}:${hostKey}:${rootId}`;
}

export function diffSnapshots(
  prev: PageSnapshot,
  next: PageSnapshot,
  checkedAt: string,
): SubscriptionDiff {
  const diff: SubscriptionDiff = {
    added: [],
    removed: [],
    changed: [],
    moved: [],
    checkedAt,
  };

  for (const [id, entry] of Object.entries(next)) {
    const before = prev[id];
    if (!before) {
      diff.added.push({
        pageId: id,
        title: entry.title,
        kind: "added",
        toVersion: entry.version,
        updatedAt: entry.updatedAt,
        updatedBy: entry.updatedBy,
        toParentId: entry.parentId,
      });
      continue;
    }
    if (before.version !== entry.version) {
      diff.changed.push({
        pageId: id,
        title: entry.title,
        kind: "changed",
        fromVersion: before.version,
        toVersion: entry.version,
        updatedAt: entry.updatedAt,
        updatedBy: entry.updatedBy,
      });
    }
    if ((before.parentId ?? "") !== (entry.parentId ?? "")) {
      diff.moved.push({
        pageId: id,
        title: entry.title,
        kind: "moved",
        fromParentId: before.parentId,
        toParentId: entry.parentId,
      });
    }
  }

  for (const [id, before] of Object.entries(prev)) {
    if (!next[id]) {
      diff.removed.push({
        pageId: id,
        title: before.title,
        kind: "removed",
        fromVersion: before.version,
      });
    }
  }

  return diff;
}

export function diffIsEmpty(d: SubscriptionDiff): boolean {
  return d.added.length + d.removed.length + d.changed.length + d.moved.length === 0;
}
