import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserApi } from "@/lib/browser/browser-api";
import {
  classifyTabAccess,
  type SupportedTabAccessInfo,
  type SupportedTabAccessState,
  type TabAccessInfo,
  type TabAccessState,
} from "@/lib/browser/tab-access";
import {
  detectPageContextWithDiagnostics,
  type PageContextAnalysis,
  type PageContextDiagnostics,
} from "@/lib/page-context";
import type { UiSurfaceBinding } from "@/lib/browser/ui-surface";
import { resolveSourceBase, type BaseOverrideDiagnostic } from "@/lib/source-context";

export type CurrentTabGrantStatus = "idle" | "requesting" | "declined" | "failed";
export type GrantAccessResult = "granted" | "declined" | "failed";

export interface CurrentTabInfo {
  tabId?: number;
  windowId?: number;
  url?: string;
  title?: string;
  host?: string;
  detectedHost?: string;
  baseOverrideDiagnostic?: BaseOverrideDiagnostic;
  pageId?: string | null;
  isJira?: boolean;
  issueKey?: string | null;
  diagnostics?: PageContextDiagnostics;
  accessState?: TabAccessState;
  accessOrigin?: string;
  originPattern?: string;
  grantStatus: CurrentTabGrantStatus;
  retry: () => Promise<void>;
  grantAccess: () => Promise<void>;
}

interface CurrentTabSnapshot extends Omit<
  CurrentTabInfo,
  "grantStatus" | "retry" | "grantAccess"
> {}

export interface PageContextVisibility {
  showConfluenceButton: boolean;
  showJiraButton: boolean;
}

export interface ResolvedTabContext extends PageContextAnalysis {
  access: TabAccessInfo;
  sourceUrl: string;
}

export function useCurrentTab(
  binding?: UiSurfaceBinding,
  configuredBase?: string,
  buttonVisibility: PageContextVisibility = {
    showConfluenceButton: true,
    showJiraButton: true,
  },
): CurrentTabInfo {
  const [info, setInfo] = useState<CurrentTabSnapshot>({});
  const [grantStatus, setGrantStatus] = useState<CurrentTabGrantStatus>("idle");
  const generation = useRef(0);
  const currentInfo = useRef(info);
  currentInfo.current = info;
  const { showConfluenceButton, showJiraButton } = buttonVisibility;

  const refresh = useCallback(async () => {
    const requestGeneration = ++generation.current;
    // Retain the visible card/draft, but never run against a source being resolved.
    setInfo((current) =>
      current.accessState === undefined ? current : { ...current, accessState: undefined },
    );
    try {
      const next = await loadCurrentTab(
        binding,
        { showConfluenceButton, showJiraButton },
        configuredBase,
      );
      if (requestGeneration === generation.current) setInfo(next);
    } catch {
      if (requestGeneration === generation.current) setInfo({});
    }
  }, [binding, configuredBase, showConfluenceButton, showJiraButton]);

  const grantAccess = useCallback(async () => {
    const requested = currentInfo.current;
    if (requested.accessState !== "host-access-missing" || !requested.originPattern) return;
    setGrantStatus("requesting");
    const result = await grantCurrentTabAccess(requested.originPattern);
    if (
      currentInfo.current.tabId !== requested.tabId ||
      currentInfo.current.originPattern !== requested.originPattern
    )
      return;
    setGrantStatus(result === "granted" ? "idle" : result);
    if (result === "granted") await refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const unsubActivated = BrowserApi.onTabActivated((active) => {
      if (binding?.mode === "active" && active.windowId === binding.owner.windowId) {
        void refresh();
      }
    });
    const unsubUpdated = BrowserApi.onTabUpdated((id, change) => {
      const sourceId = binding?.mode === "pinned" ? binding.sourceTabId : currentInfo.current.tabId;
      if (id === sourceId && (change.url || change.status === "complete")) void refresh();
    });
    const unsubRemoved = BrowserApi.onTabRemoved((id) => {
      const sourceId = binding?.mode === "pinned" ? binding.sourceTabId : currentInfo.current.tabId;
      if (id === sourceId) void refresh();
    });
    return () => {
      ++generation.current;
      unsubActivated();
      unsubUpdated();
      unsubRemoved();
    };
  }, [binding, refresh]);

  useEffect(() => setGrantStatus("idle"), [info.tabId, info.accessOrigin]);
  return { ...info, grantStatus, retry: refresh, grantAccess };
}

export async function grantCurrentTabAccess(originPattern: string): Promise<GrantAccessResult> {
  try {
    return (await BrowserApi.requestOriginPermission(originPattern)) ? "granted" : "declined";
  } catch {
    return "failed";
  }
}

export async function resolveTabContext(
  tab: chrome.tabs.Tab,
  buttonVisibility: PageContextVisibility,
): Promise<ResolvedTabContext> {
  const url = tab.url ?? "";
  const classifiedAccess = classifyTabAccess(url);
  if (classifiedAccess.state === "unsupported-url") {
    return {
      ...detectPageContextWithDiagnostics({ title: tab.title }, buttonVisibility),
      sourceUrl: url,
      access: classifiedAccess,
    };
  }
  const fallback = {
    ...detectPageContextWithDiagnostics({ url, title: tab.title }, buttonVisibility),
    sourceUrl: url,
  };

  if (typeof tab.id !== "number") {
    return { ...fallback, access: withAccessState(classifiedAccess, "injection-failed") };
  }

  try {
    const [result] = await BrowserApi.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const readMeta = (name: string) =>
          document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? null;

        return {
          url: location.href,
          title: document.title,
          meta: {
            confluencePageId: readMeta("ajs-page-id"),
            confluenceTitle: readMeta("ajs-page-title"),
            jiraIssueKey: readMeta("ajs-issue-key"),
          },
        };
      },
    });

    const payload = result?.result;
    if (!payload || typeof payload !== "object") {
      return { ...fallback, access: withAccessState(classifiedAccess, "injection-failed") };
    }

    const input = payload as Parameters<typeof detectPageContextWithDiagnostics>[0];
    const sourceUrl = input.url ?? url;
    return {
      ...detectPageContextWithDiagnostics(input, buttonVisibility),
      sourceUrl,
      access: classifyTabAccess(sourceUrl),
    };
  } catch (error) {
    try {
      const hasAccess = await BrowserApi.containsOriginPermission(classifiedAccess.originPattern);
      if (!hasAccess) {
        return { ...fallback, access: withAccessState(classifiedAccess, "host-access-missing") };
      }
    } catch (permissionError) {
      console.warn("[cx] current-origin permission check failed", permissionError);
      return { ...fallback, access: withAccessState(classifiedAccess, "injection-failed") };
    }

    console.warn("[cx] content context detection failed, using URL fallback", error);
    return { ...fallback, access: withAccessState(classifiedAccess, "injection-failed") };
  }
}

async function loadCurrentTab(
  binding: UiSurfaceBinding | undefined,
  buttonVisibility: PageContextVisibility,
  configuredBase?: string,
): Promise<CurrentTabSnapshot> {
  if (!binding || binding.mode === "unbound") return {};
  const tab =
    binding.mode === "pinned"
      ? typeof binding.sourceTabId === "number"
        ? await BrowserApi.getTab(binding.sourceTabId)
        : undefined
      : typeof binding.owner.windowId === "number"
        ? (await BrowserApi.queryTabs({ active: true, windowId: binding.owner.windowId }))[0]
        : undefined;
  if (!tab) return {};
  const context = await resolveTabContext(tab, buttonVisibility);
  const resolved =
    context.context.kind === "confluence"
      ? resolveSourceBase(context.sourceUrl, context.context.host, configuredBase)
      : undefined;

  return {
    tabId: tab.id,
    windowId: tab.windowId,
    url: context.sourceUrl,
    title: context.context.title ?? tab.title,
    host: resolved?.baseUrl ?? context.context.host,
    detectedHost: context.context.host,
    baseOverrideDiagnostic: resolved?.overrideDiagnostic,
    pageId: context.context.kind === "confluence" ? context.context.pageId : null,
    isJira: context.context.kind === "jira",
    issueKey: context.context.kind === "jira" ? context.context.issueKey : null,
    diagnostics: context.diagnostics,
    accessState: context.access.state,
    accessOrigin: context.access.state === "unsupported-url" ? undefined : context.access.origin,
    originPattern:
      context.access.state === "unsupported-url" ? undefined : context.access.originPattern,
  };
}

function withAccessState(
  access: SupportedTabAccessInfo,
  state: SupportedTabAccessState,
): SupportedTabAccessInfo {
  return { ...access, state };
}
