import { createConfluenceApi, toFetchOptions } from "@/lib/create-api";
import { loadSettings } from "@/lib/settings";
import { canonicalBaseUrl, resolveSourceBase } from "@/lib/source-context";
import { buildPageSnapshot, buildSubtreeSnapshot } from "@/lib/snapshot-walker";
import type { PageSnapshot, Subscription, SubscriptionDiff } from "@/lib/subscriptions";
import {
  appendCheckHistory,
  deleteSubscription,
  diffSnapshots,
  makeSubscriptionId,
  migrateSubscriptionSources,
  summarizeDiff,
  upsertSubscription,
} from "@/lib/subscriptions";
import type { AppSettings, SubscriptionScope } from "@/types";

export interface SubscribeOptions {
  host: string;
  rootId: string;
  scope: SubscriptionScope;
  maxDepth?: number;
  onProgress?: (visited: number, title: string) => void;
}

function resolveSubscriptionBase(host: string, override?: string): string {
  const baseUrl = canonicalBaseUrl(host);
  const known = new URL(baseUrl);
  if (known.pathname !== "/") {
    return resolveSourceBase(baseUrl, baseUrl).baseUrl;
  }
  let sourceUrl = baseUrl;
  if (override) {
    try {
      const candidate = canonicalBaseUrl(override);
      if (new URL(candidate).origin === known.origin) sourceUrl = candidate;
    } catch {
      // An invalid override cannot replace a subscription's canonical source.
    }
  }
  return resolveSourceBase(sourceUrl, baseUrl, override).baseUrl;
}

function readSubscriptions(settings: AppSettings): Promise<Subscription[]> {
  return migrateSubscriptionSources((sub) =>
    sub.sourceBaseVersion === 1
      ? resolveSourceBase(sub.host, sub.host).baseUrl
      : resolveSubscriptionBase(sub.host, settings.confluenceBaseUrl),
  );
}

export async function listSubscriptions(): Promise<Subscription[]> {
  return readSubscriptions(await loadSettings());
}

export async function getSubscription(id: string): Promise<Subscription | null> {
  return (await listSubscriptions()).find((sub) => sub.id === id) ?? null;
}

export async function subscribe(opts: SubscribeOptions): Promise<Subscription> {
  const settings = await loadSettings();
  const host = resolveSourceBase(opts.host, opts.host).baseUrl;
  const api = createConfluenceApi(host, toFetchOptions(settings));
  const { snapshot, root } =
    opts.scope === "page"
      ? await buildPageSnapshot(api, opts.rootId)
      : await buildSubtreeSnapshot(api, opts.rootId, {
          maxDepth: opts.maxDepth,
          onProgress: (p) => opts.onProgress?.(p.visited, p.currentTitle),
        });

  const sub: Subscription = {
    id: makeSubscriptionId(host, opts.rootId, opts.scope),
    scope: opts.scope,
    host,
    sourceBaseVersion: 1,
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
  const settings = await loadSettings();
  const sub = (await readSubscriptions(settings)).find((item) => item.id === id);
  if (!sub) throw new Error(`Подписка ${id} не найдена`);

  const api = createConfluenceApi(sub.host, toFetchOptions(settings));
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

export { deleteSubscription, makeSubscriptionId };
