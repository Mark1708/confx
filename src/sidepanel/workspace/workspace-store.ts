import { BrowserApi } from "@/lib/browser/browser-api";
import { storage } from "@/lib/browser/storage";
import { CURRENT_SETTINGS_VERSION, migrateSettings } from "@/lib/settings";
import { canonicalBaseUrl, sourceKey, type SourceContext } from "@/lib/source-context";
import type { ExportDefaults } from "@/types";
import type {
  WorkspaceDraft,
  WorkspaceDraftPatch,
  WorkspaceSnapshot,
  WorkspaceSource,
} from "./contracts";

const KEY = "cx.workspace.v1";
export type WorkspaceLock = <T>(task: () => Promise<T>) => Promise<T>;
const nativeWorkspaceLock: WorkspaceLock = async (task) => {
  if (!navigator.locks)
    throw new Error("Web Locks are unavailable; workspace changes cannot be saved safely");
  return navigator.locks.request(KEY, task);
};
const DRAFT_FIELDS = [
  "section",
  "scope",
  "defaults",
  "destination",
  "subtree",
  "space",
  "jira",
  "watch",
  "lastIntentIds",
] as const;
interface SessionArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function copyDefaults(value: unknown): ExportDefaults | null {
  if (value == null) return null;
  const normalized = migrateSettings({
    version: CURRENT_SETTINGS_VERSION,
    exportDefaults: value,
  }).exportDefaults;
  return {
    presetId: normalized.presetId,
    package: {
      editable: normalized.package.editable,
      images: normalized.package.images,
      attachments: normalized.package.attachments,
      plantUmlAssets: normalized.package.plantUmlAssets,
      comments: normalized.package.comments,
      history: normalized.package.history,
    },
    conversion: {
      includeFrontMatter: normalized.conversion.includeFrontMatter,
      rewriteInternalLinks: normalized.conversion.rewriteInternalLinks,
      deduplicateAssets: normalized.conversion.deduplicateAssets,
      presetRules: normalized.conversion.presetRules.map((rule) => ({
        id: rule.id,
        name: rule.name,
        type: rule.type,
        matcher: rule.matcher,
        action: rule.action,
        enabled: rule.enabled,
        ...(rule.options
          ? {
              options: Object.fromEntries(
                Object.entries(rule.options).filter(
                  ([, option]) =>
                    typeof option === "string" ||
                    typeof option === "boolean" ||
                    (typeof option === "number" && Number.isFinite(option)),
                ),
              ),
            }
          : {}),
      })),
    },
    maxDepth: normalized.maxDepth,
  };
}
function initialDraft(source: WorkspaceSource, pageId?: string, spaceKey?: string): WorkspaceDraft {
  return {
    source,
    section: "export",
    scope:
      source.product === "jira" ? "issue" : source.product === "confluence" ? "page" : "fragment",
    defaults: null,
    destination: "download-zip",
    subtree: {
      rootId: pageId,
      filter: "",
      expandedIds: pageId ? [pageId] : [],
      serverSearch: { status: "idle", query: "", count: 0 },
    },
    space: { spaceKey, label: "", prefix: "" },
    jira: { jql: "" },
    watch: { expandedId: null, selectedPageIds: {} },
    lastIntentIds: {},
  };
}
/** Explicit projection: unknown fields are never cloned, enumerated recursively, or stored. */
function projectDraft(value: unknown, current: WorkspaceDraft): WorkspaceDraft {
  const raw = record(value);
  const subtree = record(raw.subtree ?? current.subtree);
  const search = record(subtree.serverSearch);
  const space = record(raw.space ?? current.space);
  const jira = record(raw.jira ?? current.jira);
  const watch = record(raw.watch ?? current.watch);
  const intents = record(raw.lastIntentIds ?? current.lastIntentIds);
  const section = raw.section ?? current.section;
  const scope = raw.scope ?? current.scope;
  const destination = raw.destination ?? current.destination;
  const status = search.status;
  return freeze({
    source: current.source,
    section:
      section === "export" || section === "edit" || section === "watch" ? section : current.section,
    scope:
      scope === "page" ||
      scope === "subtree" ||
      scope === "space" ||
      scope === "fragment" ||
      scope === "issue" ||
      scope === "search"
        ? scope
        : current.scope,
    defaults: "defaults" in raw ? copyDefaults(raw.defaults) : current.defaults,
    destination:
      destination === "download-zip" ||
      destination === "directory" ||
      destination === "streamed-zip"
        ? destination
        : current.destination,
    subtree:
      "subtree" in raw
        ? {
            ...(typeof subtree.rootId === "string" ? { rootId: subtree.rootId } : {}),
            ...(typeof subtree.treeRootId === "string" ? { treeRootId: subtree.treeRootId } : {}),
            filter: text(subtree.filter),
            expandedIds: strings(subtree.expandedIds),
            serverSearch: {
              status:
                status === "searching" || status === "done" || status === "error" ? status : "idle",
              query: text(search.query),
              count:
                typeof search.count === "number" &&
                Number.isFinite(search.count) &&
                search.count >= 0
                  ? search.count
                  : 0,
              ...(typeof search.error === "string" ? { error: search.error } : {}),
            },
          }
        : current.subtree,
    space:
      "space" in raw
        ? {
            ...(typeof space.spaceKey === "string" ? { spaceKey: space.spaceKey } : {}),
            label: text(space.label),
            prefix: text(space.prefix),
          }
        : current.space,
    jira: "jira" in raw ? { jql: text(jira.jql) } : current.jira,
    watch:
      "watch" in raw
        ? {
            expandedId: typeof watch.expandedId === "string" ? watch.expandedId : null,
            selectedPageIds: Object.fromEntries(
              Object.entries(record(watch.selectedPageIds)).map(([id, ids]) => [id, strings(ids)]),
            ),
          }
        : current.watch,
    lastIntentIds:
      "lastIntentIds" in raw
        ? {
            ...(typeof intents.open === "string" ? { open: intents.open } : {}),
            ...(typeof intents.picker === "string" ? { picker: intents.picker } : {}),
          }
        : current.lastIntentIds,
  });
}
function parseSource(value: unknown): WorkspaceSource | null {
  const raw = record(value);
  if (
    !Number.isInteger(raw.tabId) ||
    Number(raw.tabId) < 0 ||
    !Number.isInteger(raw.windowId) ||
    Number(raw.windowId) < 0 ||
    (raw.product !== "confluence" && raw.product !== "jira" && raw.product !== "other") ||
    typeof raw.baseUrl !== "string"
  )
    return null;
  try {
    return {
      tabId: Number(raw.tabId),
      windowId: Number(raw.windowId),
      product: raw.product,
      baseUrl: canonicalBaseUrl(raw.baseUrl),
    };
  } catch {
    return null;
  }
}

function parseDrafts(value: unknown): Map<string, WorkspaceDraft> {
  const drafts = new Map<string, WorkspaceDraft>();
  for (const [key, item] of Object.entries(record(value))) {
    const raw = record(item);
    const source = parseSource(raw.source);
    if (!source || sourceKey(source) !== key) continue;
    const restored = projectDraft(raw, initialDraft(source));
    drafts.set(
      key,
      restored.subtree.serverSearch.status === "searching"
        ? projectDraft(
            {
              subtree: {
                ...restored.subtree,
                serverSearch: { ...restored.subtree.serverSearch, status: "idle" },
              },
            },
            restored,
          )
        : restored,
    );
  }
  return drafts;
}

export class WorkspaceStore {
  private snapshot: WorkspaceSnapshot = {
    hydrated: false,
    activeKey: null,
    drafts: new Map(),
    error: null,
  };
  private readonly listeners = new Set<() => void>();
  private hydration: Promise<void> | null = null;
  private pending: Promise<void> = Promise.resolve();
  private writable = true;
  private hydrationWarning: string | null = null;
  private readonly writerId = crypto.randomUUID();
  private readonly pendingKeys = new Map<string, number>();
  private readonly revisions = new Map<string, number>();
  constructor(
    private readonly session: SessionArea = storage.session,
    private readonly lock: WorkspaceLock = nativeWorkspaceLock,
  ) {}
  getSnapshot = (): WorkspaceSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<WorkspaceSnapshot>): void {
    this.snapshot = Object.freeze({ ...this.snapshot, ...patch });
    for (const listener of this.listeners) listener();
  }
  hydrate(): Promise<void> {
    this.hydration ??= this.lock(() => this.load()).catch((error: unknown) => {
      this.writable = false;
      this.hydrationWarning =
        error instanceof Error ? error.message : "Could not restore workspace metadata.";
      this.publish({ hydrated: true, error: this.hydrationWarning });
    });
    return this.hydration;
  }
  private async load(): Promise<void> {
    try {
      const saved = (await this.session.get(KEY))[KEY];
      if (saved === undefined) {
        this.publish({ hydrated: true });
        return;
      }
      const raw = record(saved);
      if (raw.version !== 1) {
        this.writable = false;
        this.hydrationWarning =
          "Saved workspace uses an unsupported schema; it has not been overwritten.";
        this.publish({ hydrated: true, error: this.hydrationWarning });
        return;
      }
      const drafts = parseDrafts(raw.drafts);
      if (drafts.size !== Object.keys(record(raw.drafts)).length) {
        this.hydrationWarning = "Some invalid workspace metadata could not be restored.";
      }
      this.publish({
        hydrated: true,
        drafts,
        activeKey:
          typeof raw.activeKey === "string" && drafts.has(raw.activeKey) ? raw.activeKey : null,
        error: this.hydrationWarning,
      });
      this.persist();
    } catch (error) {
      // Reading failed: do not replace unseen saved data with an empty workspace.
      this.writable = false;
      this.hydrationWarning =
        error instanceof Error ? error.message : "Could not restore workspace metadata.";
      this.publish({ hydrated: true, error: this.hydrationWarning });
    }
  }
  observe(): () => void {
    return BrowserApi.onStorageChanged((changes, area) => {
      if (area !== "session" || !this.snapshot.hydrated) return;
      const change = changes[KEY];
      if (!change?.newValue) return;
      const raw = record(change.newValue);
      if (raw.writerId === this.writerId) return;
      if (raw.version !== 1) {
        this.writable = false;
        this.hydrationWarning =
          "Saved workspace uses an unsupported schema; it has not been overwritten.";
        this.publish({ error: this.hydrationWarning });
        return;
      }
      const changedKey = typeof raw.changedKey === "string" ? raw.changedKey : null;
      if (
        changedKey === this.snapshot.activeKey ||
        (changedKey && this.pendingKeys.has(changedKey))
      )
        return;
      const incoming = parseDrafts(
        changedKey ? { [changedKey]: record(raw.drafts)[changedKey] } : raw.drafts,
      );
      const drafts = new Map(this.snapshot.drafts);
      for (const [key, draft] of incoming) {
        if (key !== this.snapshot.activeKey && !this.pendingKeys.has(key)) drafts.set(key, draft);
      }
      // Remote navigation never moves the live document to another source/section.
      if (incoming.size) this.publish({ drafts });
    });
  }
  activate(source: SourceContext | null): void {
    if (!this.snapshot.hydrated) throw new Error("Workspace must be hydrated before activation");
    if (!source) return;
    const metadata: WorkspaceSource = {
      tabId: source.tabId,
      windowId: source.windowId,
      product: source.product,
      baseUrl: canonicalBaseUrl(source.baseUrl),
    };
    const key = sourceKey(metadata);
    const existing = this.snapshot.drafts.get(key);
    if (
      existing &&
      existing.source.windowId === metadata.windowId &&
      this.snapshot.activeKey === key
    )
      return;
    const drafts = new Map(this.snapshot.drafts);
    drafts.set(
      key,
      existing
        ? freeze({ ...existing, source: metadata })
        : freeze(initialDraft(metadata, source.pageId, source.spaceKey)),
    );
    this.publish({ drafts, activeKey: key });
    this.persist(key, undefined, true, !existing);
  }
  update(key: string, patch: WorkspaceDraftPatch): void {
    if (!this.snapshot.hydrated) throw new Error("Workspace must be hydrated before editing");
    const current = this.snapshot.drafts.get(key);
    if (!current) throw new Error("Workspace source is unavailable");
    const drafts = new Map(this.snapshot.drafts);
    const next = projectDraft(patch, current);
    drafts.set(key, next);
    this.publish({ drafts });
    const cleanPatch = Object.fromEntries(
      DRAFT_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(patch, field)).map(
        (field) => [field, next[field]],
      ),
    ) as WorkspaceDraftPatch;
    this.persist(key, cleanPatch);
  }
  private persist(
    key?: string,
    patch?: WorkspaceDraftPatch,
    activate = false,
    restore = false,
  ): void {
    if (!this.writable) return;
    const known = key ? this.snapshot.drafts.get(key) : undefined;
    const activeKey = this.snapshot.activeKey;
    const revision = key ? (this.revisions.get(key) ?? 0) + 1 : 0;
    if (key) {
      this.revisions.set(key, revision);
      this.pendingKeys.set(key, (this.pendingKeys.get(key) ?? 0) + 1);
    }
    this.pending = this.pending
      .catch(() => {})
      .then(async () => {
        try {
          await this.lock(async () => {
            const saved = (await this.session.get(KEY))[KEY];
            const raw = record(saved);
            if (saved !== undefined && raw.version !== 1) {
              this.writable = false;
              throw new Error(
                "Saved workspace uses an unsupported schema; it has not been overwritten.",
              );
            }
            const drafts = parseDrafts(raw.drafts);
            if (key && known) {
              const latest = drafts.get(key);
              drafts.set(
                key,
                activate
                  ? latest
                    ? freeze({ ...latest, source: known.source })
                    : known
                  : projectDraft(patch, latest ?? known),
              );
            }
            await this.session.set({
              [KEY]: {
                version: 1,
                activeKey: activeKey ?? raw.activeKey ?? null,
                writerId: this.writerId,
                changedKey: key ?? null,
                drafts: Object.fromEntries(
                  [...drafts].map(([id, draft]) => [
                    id,
                    {
                      ...draft,
                      subtree: {
                        ...draft.subtree,
                        serverSearch: {
                          ...draft.subtree.serverSearch,
                          status:
                            draft.subtree.serverSearch.status === "searching"
                              ? "idle"
                              : draft.subtree.serverSearch.status,
                        },
                      },
                    },
                  ]),
                ),
              },
            });
            if (
              key &&
              this.revisions.get(key) === revision &&
              (this.snapshot.activeKey !== key || restore)
            ) {
              const merged = drafts.get(key);
              if (merged) this.publish({ drafts: new Map(this.snapshot.drafts).set(key, merged) });
            }
            if (this.snapshot.error !== this.hydrationWarning)
              this.publish({ error: this.hydrationWarning });
          });
        } catch (error) {
          this.publish({
            error: error instanceof Error ? error.message : "Could not save workspace metadata.",
          });
          throw error;
        } finally {
          if (key) {
            const remaining = (this.pendingKeys.get(key) ?? 1) - 1;
            if (remaining) this.pendingKeys.set(key, remaining);
            else this.pendingKeys.delete(key);
          }
        }
      });
    void this.pending.catch(() => {});
  }
  async flush(): Promise<void> {
    await this.pending;
    if (!this.writable)
      throw new Error(this.hydrationWarning ?? "Workspace persistence is unavailable");
  }
}
