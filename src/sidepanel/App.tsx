import {
  Bell,
  CircleDot,
  Crosshair,
  FileText,
  FolderTree,
  Globe,
  Settings,
  Upload,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { storage } from "@/lib/browser/storage";
import type { OpenConfxRequest, PickerResult } from "@/types";
import { ImportPanel } from "./components/ImportPanel";
import { JiraPanel } from "./components/JiraPanel";
import { PagePanel } from "./components/PagePanel";
import { PickerPanel } from "./components/PickerPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { SpacePanel } from "./components/SpacePanel";
import { SubtreePanel } from "./components/SubtreePanel";
import { ThemeSelect } from "./components/ThemeSelect";
import { WatchPanel } from "./components/WatchPanel";
import { useCurrentTab } from "./hooks/useCurrentTab";
import { useFontSize } from "./hooks/useFontSize";
import { useI18n } from "./hooks/useI18n";
import { useSubscriptions } from "./hooks/useSubscriptions";
import { useTheme } from "./hooks/useTheme";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { SegmentControl, type SegmentControlItem } from "./ui/segment-control";

type PrimaryGroup = "extract" | "tools";
type PanelId = "page" | "space" | "jira" | "subtree" | "picker" | "import" | "watch" | "settings";

type PanelNavItem = SegmentControlItem<PanelId>;

const defaultPanelByGroup: Record<PrimaryGroup, PanelId> = {
  extract: "page",
  tools: "picker",
};

const PICKER_RESULT_KEY = "cx:pickerResult";
const OPEN_CONFX_INTENT_KEY = "cx:openConfxIntent";

function isGroupPanel(panel: PanelId, items: readonly PanelNavItem[]): boolean {
  return items.some((item) => item.value === panel);
}

function PanelScroll({ children }: { children: ReactNode }) {
  return (
    <ScrollArea className="h-full">
      <div className="min-w-0 p-2 wide-panel:p-3">{children}</div>
    </ScrollArea>
  );
}

export function App() {
  const tab = useCurrentTab();
  useFontSize();
  useTheme();
  const { locale, t } = useI18n();
  const { subscriptions } = useSubscriptions();
  const [activeGroup, setActiveGroup] = useState<PrimaryGroup>("extract");
  const [activePanel, setActivePanel] = useState<PanelId>("page");
  const [autoContextKey, setAutoContextKey] = useState("");

  const pendingChanges = subscriptions.reduce((acc, s) => {
    const d = s.lastDiffSummary;
    if (!d) return acc;
    return acc + d.added + d.removed + d.changed + d.moved;
  }, 0);
  const headerSubtitle = tab.isJira
    ? (tab.issueKey ?? tab.host ?? t("sidepanel.header.openJiraTicket"))
    : (tab.host ?? t("sidepanel.header.openConfluencePage"));

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = t("common.appName");
  }, [locale, t]);

  const primaryItems = useMemo<readonly SegmentControlItem<PrimaryGroup>[]>(
    () => [
      { value: "extract", label: t("sidepanel.groups.extract") },
      { value: "tools", label: t("sidepanel.groups.tools") },
    ],
    [t],
  );

  const extractItems = useMemo<readonly PanelNavItem[]>(
    () => [
      { value: "page", label: t("sidepanel.tabs.page"), icon: <FileText className="h-3 w-3" /> },
      { value: "space", label: t("sidepanel.tabs.space"), icon: <Globe className="h-3 w-3" /> },
      ...(tab.isJira
        ? [
            {
              value: "jira" as const,
              label: t("sidepanel.tabs.jira"),
              icon: <CircleDot className="h-3 w-3" />,
            },
          ]
        : []),
      {
        value: "subtree",
        label: t("sidepanel.tabs.subtree"),
        icon: <FolderTree className="h-3 w-3" />,
      },
    ],
    [t, tab.isJira],
  );

  const toolsItems = useMemo<readonly PanelNavItem[]>(
    () => [
      {
        value: "picker",
        label: t("sidepanel.tabs.picker"),
        icon: <Crosshair className="h-3 w-3" />,
      },
      {
        value: "import",
        label: t("sidepanel.tabs.import"),
        icon: <Upload className="h-3 w-3" />,
      },
      {
        value: "watch",
        label: t("sidepanel.tabs.watch"),
        icon: <Bell className="h-3 w-3" />,
        badge:
          pendingChanges > 0 ? (
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold leading-none text-primary-foreground">
              {pendingChanges > 99 ? "99+" : pendingChanges}
            </span>
          ) : null,
      },
    ],
    [pendingChanges, t],
  );

  const visibleItems = activeGroup === "extract" ? extractItems : toolsItems;

  useEffect(() => {
    if (activePanel === "settings" || isGroupPanel(activePanel, visibleItems)) return;
    setActivePanel(defaultPanelByGroup[activeGroup]);
  }, [activeGroup, activePanel, visibleItems]);

  useEffect(() => {
    const applyOpenIntent = (intent: OpenConfxRequest): void => {
      setActiveGroup("extract");
      setActivePanel(intent.source === "jira" ? "jira" : "page");
      void storage.session.remove(OPEN_CONFX_INTENT_KEY);
    };

    const applyPickerResult = (_result: PickerResult): void => {
      setActiveGroup("tools");
      setActivePanel("picker");
    };

    const handleStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ): void => {
      if (areaName !== "session") return;

      const result = changes[PICKER_RESULT_KEY]?.newValue;
      if (isPickerResult(result)) {
        applyPickerResult(result);
        return;
      }

      const intent = changes[OPEN_CONFX_INTENT_KEY]?.newValue;
      if (isOpenConfxRequest(intent)) {
        applyOpenIntent(intent);
      }
    };

    storage.session
      .get([PICKER_RESULT_KEY, OPEN_CONFX_INTENT_KEY])
      .then((stored) => {
        const result = stored[PICKER_RESULT_KEY];
        const intent = stored[OPEN_CONFX_INTENT_KEY];

        if (isPickerResult(result)) {
          applyPickerResult(result);
          return;
        }

        if (isOpenConfxRequest(intent)) {
          applyOpenIntent(intent);
        }
      })
      .catch((error) => console.warn("[cx] startup intent recovery failed", error));

    chrome.storage.onChanged.addListener(handleStorageChanged);
    return () => chrome.storage.onChanged.removeListener(handleStorageChanged);
  }, []);

  useEffect(() => {
    const nextContextKey = `${tab.url ?? ""}:${tab.isJira ? (tab.issueKey ?? "jira") : (tab.pageId ?? "")}`;
    if (!nextContextKey || nextContextKey === autoContextKey) return;

    setAutoContextKey(nextContextKey);

    if (tab.isJira) {
      setActiveGroup("extract");
      setActivePanel("jira");
    } else if (tab.pageId) {
      setActiveGroup("extract");
      setActivePanel("page");
    }
  }, [autoContextKey, tab.isJira, tab.issueKey, tab.pageId, tab.url]);

  const handleGroupChange = (nextGroup: PrimaryGroup) => {
    const nextItems = nextGroup === "extract" ? extractItems : toolsItems;
    setActiveGroup(nextGroup);
    setActivePanel((currentPanel) =>
      isGroupPanel(currentPanel, nextItems) ? currentPanel : defaultPanelByGroup[nextGroup],
    );
  };

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="shrink-0 flex min-w-0 items-center gap-1.5 border-b bg-surface px-2 py-2 panel:gap-2 wide-panel:px-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary text-xs font-black tracking-tight text-primary-foreground shadow-[0_0_18px_hsl(var(--accent-glow))]">
          CX
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold leading-tight">ConfX</div>
          <div className="truncate text-[10px] text-muted-foreground">{headerSubtitle}</div>
        </div>
        <ThemeSelect />
        <Button
          type="button"
          variant={activePanel === "settings" ? "secondary" : "ghost"}
          size="icon"
          className="h-7 w-7 shrink-0"
          aria-label={t("sidepanel.header.settings")}
          onClick={() => setActivePanel("settings")}
        >
          <Settings className="h-3.5 w-3.5" />
        </Button>
      </header>

      <div className="shrink-0 min-w-0 space-y-2 border-b bg-background px-2 py-2 wide-panel:px-3">
        <SegmentControl
          ariaLabel={t("sidepanel.header.primarySection")}
          items={primaryItems}
          value={activeGroup}
          onValueChange={handleGroupChange}
          size="default"
        />
        <SegmentControl
          ariaLabel={t("sidepanel.header.sectionPanel")}
          items={visibleItems}
          value={activePanel === "settings" ? defaultPanelByGroup[activeGroup] : activePanel}
          onValueChange={setActivePanel}
          size="sm"
        />
      </div>

      <main className="min-h-0 flex-1 overflow-hidden">{renderPanel(activePanel, tab)}</main>
    </div>
  );
}

function isPickerResult(value: unknown): value is PickerResult {
  if (!value || typeof value !== "object") return false;
  return (value as { kind?: unknown }).kind === "picker-result";
}

function isOpenConfxRequest(value: unknown): value is OpenConfxRequest {
  if (!value || typeof value !== "object") return false;
  return (value as { kind?: unknown }).kind === "open-confx";
}

function renderPanel(activePanel: PanelId, tab: ReturnType<typeof useCurrentTab>): ReactNode {
  switch (activePanel) {
    case "page":
      return (
        <PanelScroll>
          <PagePanel tab={tab} />
        </PanelScroll>
      );
    case "space":
      return (
        <PanelScroll>
          <SpacePanel tab={tab} />
        </PanelScroll>
      );
    case "jira":
      return tab.isJira ? (
        <PanelScroll>
          <JiraPanel tab={tab} />
        </PanelScroll>
      ) : null;
    case "subtree":
      return (
        <div className="flex h-full min-h-0 min-w-0 flex-col p-2 wide-panel:p-3">
          <SubtreePanel tab={tab} />
        </div>
      );
    case "picker":
      return (
        <PanelScroll>
          <PickerPanel tab={tab} />
        </PanelScroll>
      );
    case "import":
      return (
        <PanelScroll>
          <ImportPanel tab={tab} />
        </PanelScroll>
      );
    case "watch":
      return (
        <PanelScroll>
          <WatchPanel />
        </PanelScroll>
      );
    case "settings":
      return (
        <PanelScroll>
          <SettingsPanel />
        </PanelScroll>
      );
  }
}
