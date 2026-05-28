import { useEffect, useState } from "react";
import { BrowserApi } from "@/lib/browser/browser-api";
import { detectPageContext, type PageContext } from "@/lib/page-context";

export interface CurrentTabInfo {
  tabId?: number;
  url?: string;
  title?: string;
  host?: string;
  pageId?: string | null;
  isJira?: boolean;
  issueKey?: string | null;
}

export function useCurrentTab(): CurrentTabInfo {
  const [info, setInfo] = useState<CurrentTabInfo>({});

  useEffect(() => {
    let cancelled = false;
    const update = async () => {
      const [tab] = await BrowserApi.queryTabs({ active: true, currentWindow: true });
      if (cancelled || !tab) return;
      const context = await resolveTabContext(tab);
      setInfo({
        tabId: tab.id,
        url: tab.url ?? "",
        title: tab.title,
        host: context.host,
        pageId: context.kind === "confluence" ? context.pageId : null,
        isJira: context.kind === "jira",
        issueKey: context.kind === "jira" ? context.issueKey : null,
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
  }, []);

  return info;
}

async function resolveTabContext(tab: chrome.tabs.Tab): Promise<PageContext> {
  const url = tab.url ?? "";
  const fallback = detectPageContext({ url, title: tab.title });

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

    const input = payload as Parameters<typeof detectPageContext>[0];
    return detectPageContext(input);
  } catch (error) {
    console.warn("[cx] content context detection failed, using URL fallback", error);
    return fallback;
  }
}
