import { useEffect, useState } from "react";
import { BrowserApi } from "@/lib/browser/browser-api";
import {
  detectPageContextWithDiagnostics,
  type PageContextAnalysis,
  type PageContextDiagnostics,
} from "@/lib/page-context";
import { useSettings } from "./useSettings";

export interface CurrentTabInfo {
  tabId?: number;
  url?: string;
  title?: string;
  host?: string;
  pageId?: string | null;
  isJira?: boolean;
  issueKey?: string | null;
  diagnostics?: PageContextDiagnostics;
}

export function useCurrentTab(): CurrentTabInfo {
  const [info, setInfo] = useState<CurrentTabInfo>({});
  const { data: settings } = useSettings();

  useEffect(() => {
    let cancelled = false;
    const buttonVisibility = {
      showConfluenceButton: settings?.showConfluenceButton ?? true,
      showJiraButton: settings?.showJiraButton ?? true,
    };

    const update = async () => {
      const [tab] = await BrowserApi.queryTabs({ active: true, currentWindow: true });
      if (cancelled || !tab) return;
      const context = await resolveTabContext(tab, buttonVisibility);
      setInfo({
        tabId: tab.id,
        url: tab.url ?? "",
        title: tab.title,
        host: context.context.host,
        pageId: context.context.kind === "confluence" ? context.context.pageId : null,
        isJira: context.context.kind === "jira",
        issueKey: context.context.kind === "jira" ? context.context.issueKey : null,
        diagnostics: context.diagnostics,
      });
    };
    void update();

    const unsubActivated = BrowserApi.onTabActivated(() => void update());
    const unsubUpdated = BrowserApi.onTabUpdated((_id, change) => {
      if (change.url || change.status === "complete") void update();
    });
    return () => {
      cancelled = true;
      unsubActivated();
      unsubUpdated();
    };
  }, [settings?.showConfluenceButton, settings?.showJiraButton]);

  return info;
}

async function resolveTabContext(
  tab: chrome.tabs.Tab,
  buttonVisibility: {
    showConfluenceButton: boolean;
    showJiraButton: boolean;
  },
): Promise<PageContextDiagnosticsResult> {
  const url = tab.url ?? "";
  const fallback = detectPageContextWithDiagnostics({ url, title: tab.title }, buttonVisibility);

  if (typeof tab.id !== "number") return fallback;

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
    if (!payload || typeof payload !== "object") return fallback;

    const input = payload as Parameters<typeof detectPageContextWithDiagnostics>[0];
    return detectPageContextWithDiagnostics(input, buttonVisibility);
  } catch (error) {
    console.warn("[cx] content context detection failed, using URL fallback", error);
    return fallback;
  }
}

type PageContextDiagnosticsResult = PageContextAnalysis;
