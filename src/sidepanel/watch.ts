import { createConfluenceApi } from "@/lib/create-api";
import { buildPageSnapshot, buildSubtreeSnapshot } from "@/lib/snapshot-walker";
import type { PageSnapshot, Subscription, SubscriptionDiff } from "@/lib/subscriptions";
import {
  appendCheckHistory,
  deleteSubscription,
  diffSnapshots,
  getSubscription,
  listSubscriptions,
  makeSubscriptionId,
  summarizeDiff,
  upsertSubscription,
} from "@/lib/subscriptions";
import type { SubscriptionScope } from "@/types";

export interface SubscribeOptions {
  host: string;
  rootId: string;
  scope: SubscriptionScope;
  maxDepth?: number;
  onProgress?: (visited: number, title: string) => void;
}

export async function subscribe(opts: SubscribeOptions): Promise<Subscription> {
  const api = await createConfluenceApi(opts.host);
  const { snapshot, root } =
    opts.scope === "page"
      ? await buildPageSnapshot(api, opts.rootId)
      : await buildSubtreeSnapshot(api, opts.rootId, {
          maxDepth: opts.maxDepth,
          onProgress: (p) => opts.onProgress?.(p.visited, p.currentTitle),
        });

  const sub: Subscription = {
    id: makeSubscriptionId(opts.host, opts.rootId, opts.scope),
    scope: opts.scope,
    host: opts.host,
    rootId: opts.rootId,
    rootTitle: root.title,
    spaceKey: root.space?.key,
    createdAt: new Date().toISOString(),
    snapshot,
  };
  await upsertSubscription(sub);
  return sub;
}

export interface CheckResult {
  subscription: Subscription;
  diff: SubscriptionDiff;
  /** Кандидат-снапшот для сохранения при принятии изменений. */
  nextSnapshot: PageSnapshot;
}

export async function checkSubscription(
  id: string,
  opts: { maxDepth?: number; onProgress?: (visited: number, title: string) => void } = {},
): Promise<CheckResult> {
  const sub = await getSubscription(id);
  if (!sub) throw new Error(`Подписка ${id} не найдена`);

  const api = await createConfluenceApi(sub.host);
  const { snapshot: nextSnapshot } =
    sub.scope === "page"
      ? await buildPageSnapshot(api, sub.rootId)
      : await buildSubtreeSnapshot(api, sub.rootId, {
          maxDepth: opts.maxDepth,
          onProgress: (p) => opts.onProgress?.(p.visited, p.currentTitle),
        });

  const checkedAt = new Date().toISOString();
  const diff = diffSnapshots(sub.snapshot, nextSnapshot, checkedAt);
  const updated = appendCheckHistory(
    {
      ...sub,
      lastCheckedAt: checkedAt,
      lastDiffSummary: summarizeDiff(diff),
    },
    diff,
  );
  await upsertSubscription(updated);
  return { subscription: updated, diff, nextSnapshot };
}

/**
 * Принять изменения: перезаписать снапшот подписки на текущий.
 * После этого следующий check покажет "нет изменений".
 */
export async function acceptChanges(id: string, nextSnapshot: PageSnapshot): Promise<void> {
  const sub = await getSubscription(id);
  if (!sub) throw new Error(`Подписка ${id} не найдена`);
  const updated: Subscription = {
    ...sub,
    snapshot: nextSnapshot,
    lastDiffSummary: { added: 0, removed: 0, changed: 0, moved: 0 },
    lastCheckedAt: new Date().toISOString(),
  };
  await upsertSubscription(updated);
}

export { deleteSubscription, getSubscription, listSubscriptions, makeSubscriptionId };
