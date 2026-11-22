import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  clearSourceIntent,
  ensureTrustedSession,
  readSourceIntents,
  watchSourceIntents,
  type SourceIntentRecord,
} from "@/lib/browser/source-intents";
import { resolveUiSurface, type UiSurfaceBinding } from "@/lib/browser/ui-surface";
import { sourceKey as makeSourceKey, type SourceContext } from "@/lib/source-context";
import type { PickerResult } from "@/types";
import { useCurrentTab, type CurrentTabInfo } from "../hooks/useCurrentTab";
import { useSettings } from "../hooks/useSettings";
import type { WorkspaceDraft, WorkspaceDraftPatch, WorkspaceSnapshot } from "./contracts";
import { ExportController, type ExportControllerView } from "./export-controller";
import { WorkspaceStore } from "./workspace-store";

interface WorkspaceShellContext {
  tab: CurrentTabInfo;
  source: SourceContext | null;
  sourceKey: string | null;
  draft: WorkspaceDraft | null;
  patchDraft(patch: WorkspaceDraftPatch): void;
  controller: ExportController | null;
  exportView: ExportControllerView;
  pickedBlock: PickerResult | null;
  clearPickedBlock(): void;
  store: WorkspaceStore;
  workspace: WorkspaceSnapshot;
  settings: ReturnType<typeof useSettings>;
  binding: UiSurfaceBinding | null;
  error: string | null;
}
export interface WorkspaceContextValue extends Omit<
  WorkspaceShellContext,
  "sourceKey" | "draft" | "controller"
> {
  sourceKey: string;
  draft: WorkspaceDraft;
  controller: ExportController;
}
const Context = createContext<WorkspaceShellContext | null>(null);
const EMPTY_VIEW: ExportControllerView = {
  ready: false,
  state: null,
  busy: false,
  ownsJob: false,
  selecting: false,
  error: null,
  errorCode: null,
};
const noSubscribe = () => () => {};
const emptyView = () => EMPTY_VIEW;
type PickedIntent = Extract<SourceIntentRecord, { kind: "picker" }>;

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new WorkspaceStore());
  const [picked] = useState(() => new Map<string, PickedIntent>());
  const [, changedPicked] = useState(0);
  const [runtime, setRuntime] = useState<{
    binding: UiSurfaceBinding;
    controller: ExportController;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const explicitToolApplied = useRef(false);
  const settings = useSettings();
  const workspace = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const tab = useCurrentTab(runtime?.binding, settings.data?.confluenceBaseUrl, {
    showConfluenceButton: settings.data?.showConfluenceButton ?? true,
    showJiraButton: settings.data?.showJiraButton ?? true,
  });
  const { accessState, tabId, windowId, url, host, isJira, pageId, issueKey } = tab;
  const source = useMemo<SourceContext | null>(() => {
    if (
      accessState !== "available" ||
      typeof tabId !== "number" ||
      typeof windowId !== "number" ||
      !url ||
      !host
    )
      return null;
    return {
      tabId,
      windowId,
      product: isJira ? "jira" : pageId ? "confluence" : "other",
      baseUrl: host,
      pageUrl: url,
      pageId: pageId ?? undefined,
      issueKey: issueKey ?? undefined,
    };
  }, [accessState, tabId, windowId, url, host, isJira, pageId, issueKey]);
  const sourceKey = source ? makeSourceKey(source) : workspace.activeKey;
  const draft = sourceKey ? (workspace.drafts.get(sourceKey) ?? null) : null;
  const draftReady = draft !== null;
  const controller = runtime?.controller ?? null;
  const exportView = useSyncExternalStore(
    controller?.subscribe ?? noSubscribe,
    controller?.getSnapshot ?? emptyView,
    controller?.getSnapshot ?? emptyView,
  );

  useEffect(() => {
    let cancelled = false;
    let owned: ExportController | null = null;
    let stopWorkspace: (() => void) | null = null;
    const close = () => {
      cancelled = true;
      stopWorkspace?.();
      owned?.dispose();
    };
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) location.reload();
    };
    window.addEventListener("pagehide", close);
    window.addEventListener("pageshow", restore);
    const initialize = async () => {
      try {
        await ensureTrustedSession();
        if (cancelled) return;
        stopWorkspace = store.observe();
        await store.hydrate();
        if (cancelled) return;
        const binding = await resolveUiSurface();
        if (cancelled) return;
        // A disposed instance is never reused by StrictMode's next effect lifetime.
        owned = new ExportController({
          owner: { ...binding.owner, instanceId: crypto.randomUUID() },
        });
        await owned.initialize();
        if (cancelled) {
          owned.dispose();
          return;
        }
        setRuntime({ binding, controller: owned });
      } catch (failure) {
        owned?.dispose();
        if (!cancelled) setError(message(failure));
      }
    };
    void initialize();
    return () => {
      window.removeEventListener("pagehide", close);
      window.removeEventListener("pageshow", restore);
      close();
    };
  }, [store]);

  useEffect(() => {
    if (workspace.hydrated) store.activate(source);
  }, [store, workspace.hydrated, source]);

  useEffect(() => {
    if (!source || !draft || !sourceKey || explicitToolApplied.current) return;
    explicitToolApplied.current = true;
    const url = new URL(location.href);
    const tool = url.searchParams.get("tool");
    if (tool === "export" || tool === "edit") {
      store.update(sourceKey, { section: tool });
      url.searchParams.delete("tool");
      history.replaceState(history.state, "", url);
    }
  }, [source, draft, sourceKey, store]);

  useEffect(() => {
    if (!source || !sourceKey || !draftReady || !workspace.hydrated) return;
    const key = sourceKey;
    let cancelled = false;
    let eventGeneration = 0;
    const apply = (records: SourceIntentRecord[]) => {
      if (cancelled) return;
      const picker = records.find((entry): entry is PickedIntent => entry.kind === "picker");
      if (picked.get(key)?.id !== picker?.id) {
        if (picker) picked.set(key, picker);
        else picked.delete(key);
        changedPicked((value) => value + 1);
      }
      for (const intent of records) {
        const current = store.getSnapshot().drafts.get(key);
        if (!current || current.lastIntentIds[intent.kind] === intent.id) continue;
        store.update(key, {
          ...(intent.kind === "picker" ? { section: "export", scope: "fragment" } : {}),
          lastIntentIds: { ...current.lastIntentIds, [intent.kind]: intent.id },
        });
      }
    };
    const unsubscribe = watchSourceIntents(source, (records) => {
      ++eventGeneration;
      apply(records);
    });
    const initialGeneration = eventGeneration;
    void readSourceIntents(source)
      .then((records) => {
        if (eventGeneration === initialGeneration) apply(records);
      })
      .catch((failure) => {
        if (!cancelled) setError(message(failure));
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // Draft changes must not restart a source listener or replay initial handoffs.
  }, [source, sourceKey, draftReady, workspace.hydrated, store, picked]);

  const patchDraft = useCallback(
    (patch: WorkspaceDraftPatch) => {
      if (!sourceKey) throw new Error("No workspace source has been selected");
      store.update(sourceKey, patch);
    },
    [sourceKey, store],
  );
  const clearPickedBlock = useCallback(() => {
    if (!sourceKey) return;
    const old = picked.get(sourceKey);
    if (!old) return;
    picked.delete(sourceKey);
    changedPicked((value) => value + 1);
    void clearSourceIntent(old).catch((failure) => setError(message(failure)));
  }, [sourceKey, picked]);

  return (
    <Context.Provider
      value={{
        tab,
        source,
        sourceKey,
        draft,
        patchDraft,
        controller,
        exportView,
        pickedBlock: sourceKey ? (picked.get(sourceKey)?.payload ?? null) : null,
        clearPickedBlock,
        store,
        workspace,
        settings,
        binding: runtime?.binding ?? null,
        error: error ?? workspace.error,
      }}
    >
      {children}
    </Context.Provider>
  );
}

export function useWorkspaceShell(): WorkspaceShellContext {
  const value = useContext(Context);
  if (!value) throw new Error("WorkspaceProvider is missing");
  return value;
}
export function useWorkspace(): WorkspaceContextValue {
  const value = useWorkspaceShell();
  if (!value.draft || !value.sourceKey || !value.controller) {
    throw new Error("Workspace source draft is not ready");
  }
  return value as WorkspaceContextValue;
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
