import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserApi } from "@/lib/browser/browser-api";
import type { UiSurfaceBinding } from "@/lib/browser/ui-surface";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import type { SourceContext } from "@/lib/source-context";
import type { Subscription, SubscriptionDiff } from "@/lib/subscriptions";
import type { HostCache } from "@/lib/tree-cache";
import { ExportComposer } from "@/sidepanel/components/ExportComposer";
import { JiraPanel } from "@/sidepanel/components/JiraPanel";
import { SpacePanel } from "@/sidepanel/components/SpacePanel";
import { SubtreePanel } from "@/sidepanel/components/SubtreePanel";
import { WatchPanel } from "@/sidepanel/components/WatchPanel";
import type { CurrentTabInfo } from "@/sidepanel/hooks/useCurrentTab";
import type { WorkspaceDraft } from "@/sidepanel/workspace/contracts";

interface FormContext {
  tab: CurrentTabInfo;
  source: SourceContext;
  sourceKey: string;
  draft: WorkspaceDraft;
  patchDraft: (patch: Partial<WorkspaceDraft>) => void;
  binding: UiSurfaceBinding | null;
}

const hooks = vi.hoisted(() => ({
  workspace: null as FormContext | null,
  cache: {} as HostCache,
  subscriptions: [] as Subscription[],
  diff: null as SubscriptionDiff | null,
  binding: null as UiSurfaceBinding | null,
  ensureChildren: vi.fn().mockResolvedValue(undefined),
  ensurePathWithChildren: vi.fn().mockResolvedValue(undefined),
  search: vi.fn().mockResolvedValue([]),
  busy: false,
  draftLocked: false,
  run: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/sidepanel/workspace/WorkspaceProvider", () => ({
  useWorkspace: () => hooks.workspace!,
}));
vi.mock("@/sidepanel/hooks/useI18n", () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values?.title ? `${key}:${values.title}` : key,
  }),
}));
vi.mock("@/sidepanel/hooks/usePageInfo", () => ({
  usePageInfo: (_host: string, pageId: string) => ({
    data: {
      ok: true,
      meta: {
        id: pageId,
        title: hooks.cache[pageId]?.title,
        spaceKey: "LOREM",
        ancestors: pageId === "100" ? [] : [{ id: "100" }],
      },
    },
    isLoading: false,
    error: null,
  }),
}));
vi.mock("@/sidepanel/hooks/useTreeStore", () => ({
  useTreeStore: () => ({
    cache: hooks.cache,
    loadingIds: new Set<string>(),
    ensureChildren: hooks.ensureChildren,
    ensurePathWithChildren: hooks.ensurePathWithChildren,
    reset: vi.fn(),
    search: hooks.search,
  }),
}));
vi.mock("@/sidepanel/hooks/useSubscriptions", () => ({
  useSubscriptions: () => ({
    subscriptions: hooks.subscriptions,
    loading: false,
    subscribing: false,
    error: null,
    subscribe: vi.fn(),
    remove: vi.fn(),
  }),
  useCheckSubscription: () => ({
    state: { running: false, diff: hooks.diff, error: null },
    run: vi.fn(),
    accept: vi.fn(),
    reset: vi.fn(),
  }),
}));
vi.mock("@/sidepanel/hooks/useSettings", () => {
  return {
    useSettings: () => ({ data: DEFAULT_SETTINGS }),
  };
});
vi.mock("@/sidepanel/hooks/useExtractJob", () => {
  return {
    useExtractJob: () => ({
      state: null,
      run: hooks.run,
      cancel: vi.fn(),
      busy: hooks.busy,
      ownsJob: false,
      draftLocked: hooks.draftLocked,
      defaults: hooks.workspace?.draft.defaults ?? DEFAULT_SETTINGS.exportDefaults,
      setDefaults: vi.fn(),
      saveDefaults: vi.fn().mockResolvedValue(undefined),
      savingDefaults: false,
      defaultsError: null,
    }),
  };
});
vi.mock("@/lib/export/confluence", () => ({
  fetchSpacePageEstimate: vi.fn().mockResolvedValue(3),
}));

const tab: CurrentTabInfo = {
  tabId: 7,
  windowId: 1,
  url: "https://wiki.example.test/wiki/pages/viewpage.action?pageId=100",
  host: "https://wiki.example.test/wiki",
  pageId: "100",
  accessState: "available",
  grantStatus: "idle",
  retry: async () => {},
  grantAccess: async () => {},
};

function initialDraft(source: SourceContext): WorkspaceDraft {
  return {
    source: {
      tabId: source.tabId,
      windowId: source.windowId,
      product: source.product,
      baseUrl: source.baseUrl,
    },
    section: "export",
    scope:
      source.product === "jira"
        ? "search"
        : source.product === "confluence"
          ? "subtree"
          : "fragment",
    defaults: null,
    destination: "download-zip",
    subtree: {
      filter: "",
      expandedIds: [],
      serverSearch: { status: "idle", query: "", count: 0 },
    },
    space: { label: "", prefix: "" },
    jira: { jql: "" },
    watch: { expandedId: null, selectedPageIds: {} },
    lastIntentIds: {},
  };
}

function FormHost({
  currentTab = tab,
  form = "tree",
}: {
  currentTab?: CurrentTabInfo;
  form?: "tree" | "space" | "jira" | "watch" | "hidden" | "composer";
}) {
  const source: SourceContext = {
    tabId: currentTab.tabId!,
    windowId: 1,
    product: currentTab.isJira ? "jira" : currentTab.pageId ? "confluence" : "other",
    baseUrl: currentTab.host!,
    pageUrl: currentTab.url!,
    pageId: currentTab.pageId ?? undefined,
  };
  const key = `${source.tabId}:${source.product}:${source.baseUrl}`;
  const [drafts, setDrafts] = useState<Record<string, WorkspaceDraft>>({});
  const draft = drafts[key] ?? initialDraft(source);
  hooks.workspace = {
    tab: currentTab,
    source,
    sourceKey: key,
    draft,
    patchDraft: (patch) =>
      setDrafts((previous) => ({
        ...previous,
        [key]: { ...(previous[key] ?? draft), ...patch },
      })),
    binding: hooks.binding,
  };
  return (
    <>
      {form === "tree" && <SubtreePanel tab={currentTab} />}
      {form === "space" && <SpacePanel tab={currentTab} />}
      {form === "jira" && <JiraPanel tab={currentTab} />}
      {form === "watch" && <WatchPanel />}
      {form === "composer" && <ExportComposer />}
    </>
  );
}

describe("source-scoped export forms", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  const originalScrollTo = HTMLElement.prototype.scrollTo;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    HTMLElement.prototype.scrollTo = vi.fn();
    hooks.workspace = null;
    hooks.binding = {
      owner: { surface: "workspace", tabId: 31, windowId: 1 },
      mode: "pinned",
      sourceTabId: 7,
    };
    hooks.busy = false;
    hooks.draftLocked = false;
    hooks.subscriptions = [];
    hooks.diff = null;
    hooks.cache = {
      "100": {
        id: "100",
        title: "Lorem root",
        hasChildren: true,
        childrenLoaded: true,
        childrenIds: ["200", "300"],
      },
      "200": {
        id: "200",
        title: "Ipsum branch",
        parentId: "100",
        hasChildren: true,
        childrenLoaded: true,
        childrenIds: ["201"],
      },
      "201": {
        id: "201",
        title: "Ipsum leaf",
        parentId: "200",
        hasChildren: false,
        childrenLoaded: true,
        childrenIds: [],
      },
      "300": {
        id: "300",
        title: "Dolor page",
        parentId: "100",
        hasChildren: false,
        childrenLoaded: true,
        childrenIds: [],
      },
    };
    hooks.run.mockClear();
    vi.spyOn(BrowserApi, "updateTab").mockResolvedValue({
      id: 7,
      windowId: 1,
      index: 0,
      highlighted: false,
      active: true,
      pinned: false,
      incognito: false,
      selected: true,
      autoDiscardable: true,
      discarded: false,
      groupId: -1,
    });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    HTMLElement.prototype.scrollTo = originalScrollTo;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function render(
    form: "tree" | "space" | "jira" | "watch" | "hidden" | "composer",
    currentTab = tab,
  ) {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <FormHost form={form} currentTab={currentTab} />
        </QueryClientProvider>,
      ),
    );
  }

  function button(text: string) {
    return [...container.querySelectorAll("button")].find((node) => node.textContent === text)!;
  }

  async function inputValue(input: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function selectedCheckboxes() {
    return [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map(
      (input) => input.checked,
    );
  }

  it("selects a different export root without navigating, then navigates only by explicit action", async () => {
    await render("tree");
    await act(async () => button("Ipsum branch").click());
    expect(hooks.workspace?.draft.subtree.rootId).toBe("200");
    expect(BrowserApi.updateTab).not.toHaveBeenCalled();

    const open = container.querySelector<HTMLButtonElement>(
      'button[aria-label="subtree.openPage:Ipsum branch"]',
    );
    expect(open).not.toBeNull();
    await act(async () => open!.click());
    expect(BrowserApi.updateTab).toHaveBeenCalledWith(7, {
      url: "https://wiki.example.test/wiki/pages/viewpage.action?pageId=200",
    });
  });

  it("retains root, filter and manual expansion across same-source page updates and section remounts", async () => {
    await render("tree");
    const expand = container.querySelector<HTMLButtonElement>(
      'button[aria-label="sidepanel.tree.expand:Ipsum branch"]',
    );
    expect(expand).not.toBeNull();
    await act(async () => expand!.click());
    await act(async () => button("Ipsum branch").click());
    const filter = container.querySelector<HTMLInputElement>(
      'input[placeholder="subtree.filterPlaceholder"]',
    )!;
    await inputValue(filter, "Ipsum");
    await render("hidden");
    await render("tree", {
      ...tab,
      pageId: "300",
      url: "https://wiki.example.test/wiki/pages/viewpage.action?pageId=300",
    });
    expect(
      container.querySelector<HTMLInputElement>('input[placeholder="subtree.filterPlaceholder"]')!
        .value,
    ).toBe("Ipsum");
    expect(hooks.workspace?.draft.subtree.rootId).toBe("200");
    expect(container.textContent).toContain("Ipsum leaf");
    expect(BrowserApi.updateTab).not.toHaveBeenCalled();
  });

  it("restores each source's space filters instead of leaking them into another source", async () => {
    await render("space");
    await inputValue(
      container.querySelector<HTMLInputElement>("#space-label-filter")!,
      "lorem-label",
    );
    await inputValue(container.querySelector<HTMLInputElement>("#space-prefix-filter")!, "Ipsum");
    const otherTab = {
      ...tab,
      tabId: 8,
      host: "https://other.example.test/wiki",
      url: "https://other.example.test/wiki/pages/100",
    };
    await render("space", otherTab);
    expect(container.querySelector<HTMLInputElement>("#space-label-filter")!.value).toBe("");
    await inputValue(
      container.querySelector<HTMLInputElement>("#space-label-filter")!,
      "other-label",
    );
    await render("hidden");
    await render("space");
    expect(container.querySelector<HTMLInputElement>("#space-label-filter")!.value).toBe(
      "lorem-label",
    );
    expect(container.querySelector<HTMLInputElement>("#space-prefix-filter")!.value).toBe("Ipsum");
  });

  it("restores a Jira search draft across section switches and changes of the current issue", async () => {
    const jiraTab = {
      ...tab,
      tabId: 9,
      isJira: true,
      issueKey: "LOREM-1",
      host: "https://jira.example.test",
      url: "https://jira.example.test/browse/LOREM-1",
    };
    await render("jira", jiraTab);
    await inputValue(
      container.querySelector<HTMLInputElement>('input[placeholder="jira.jqlPlaceholder"]')!,
      "project = LOREM",
    );
    await render("hidden", jiraTab);
    await render("jira", { ...jiraTab, issueKey: "LOREM-2" });
    expect(
      container.querySelector<HTMLInputElement>('input[placeholder="jira.jqlPlaceholder"]')!.value,
    ).toBe("project = LOREM");
  });

  it("locks start globally without locking metadata on another source", async () => {
    hooks.busy = true;
    await render("space");
    expect(container.querySelector<HTMLInputElement>("#space-label-filter")!.disabled).toBe(false);
    await inputValue(container.querySelector<HTMLInputElement>("#space-label-filter")!, "next-run");
    expect(container.querySelector<HTMLInputElement>("#space-label-filter")!.value).toBe(
      "next-run",
    );
  });

  it("keeps Watch expansion and page selection scoped to the source across section remounts", async () => {
    hooks.subscriptions = [
      {
        id: "lorem-subscription",
        host: tab.host!,
        scope: "subtree",
        rootId: "100",
        rootTitle: "Lorem watch",
        createdAt: "2026-01-01T00:00:00Z",
        snapshot: {},
      },
    ];
    await render("watch");
    await act(async () => button("Lorem watch").click());
    expect(container.textContent).toContain("watch.historyTitle");
    await render("hidden");
    await render("watch");
    expect(container.textContent).toContain("watch.historyTitle");

    hooks.diff = {
      added: [],
      removed: [],
      moved: [],
      checkedAt: "2026-01-02T00:00:00Z",
      changed: [
        { pageId: "100", title: "Lorem root", kind: "changed", fromVersion: 1, toVersion: 2 },
        { pageId: "200", title: "Ipsum branch", kind: "changed", fromVersion: 1, toVersion: 2 },
      ],
    };
    await render("watch");
    await act(async () =>
      container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
    );
    expect(selectedCheckboxes()).toEqual([false, true]);
    await render("hidden");
    await render("watch");
    expect(selectedCheckboxes()).toEqual([false, true]);
    const otherTab = {
      ...tab,
      tabId: 8,
      host: "https://other.example.test/wiki",
      url: "https://other.example.test/wiki/pages/100",
    };
    await render("watch", otherTab);
    expect(selectedCheckboxes()).toEqual([true, true]);
    await render("watch");
    expect(selectedCheckboxes()).toEqual([false, true]);
  });

  it("restores a saved Watch diff without pretending it still has an accept-ready snapshot", async () => {
    const diff: SubscriptionDiff = {
      added: [],
      removed: [],
      moved: [],
      checkedAt: "2026-01-02T00:00:00Z",
      changed: [
        { pageId: "100", title: "Lorem root", kind: "changed", fromVersion: 1, toVersion: 2 },
      ],
    };
    hooks.subscriptions = [
      {
        id: "lorem-saved-subscription",
        host: tab.host!,
        scope: "page",
        rootId: "100",
        rootTitle: "Lorem saved watch",
        createdAt: "2026-01-01T00:00:00Z",
        snapshot: {},
        lastDiffSummary: { added: 0, removed: 0, changed: 1, moved: 0 },
        checkHistory: [
          {
            checkedAt: diff.checkedAt,
            summary: { added: 0, removed: 0, changed: 1, moved: 0 },
            diff,
          },
        ],
      },
    ];
    await render("watch");
    await act(async () => button("Lorem saved watch").click());
    expect(button("watch.exportChanged").disabled).toBe(false);
    expect(button("watch.accept")).toBeUndefined();
    expect(container.textContent).toContain("watch.recheckToAccept");
    await render("hidden");
    await render("watch");
    expect(button("watch.exportChanged").disabled).toBe(false);
    expect(button("watch.accept")).toBeUndefined();
    expect(selectedCheckboxes()).toEqual([true]);
  });

  it.each([undefined, "host-access-missing", "injection-failed"] as const)(
    "keeps space draft controls editable but cannot start while source access is %s",
    async (accessState) => {
      await render("space", { ...tab, accessState });
      expect(container.querySelector<HTMLInputElement>("#space-label-filter")!.disabled).toBe(
        false,
      );
      await inputValue(
        container.querySelector<HTMLInputElement>("#space-label-filter")!,
        "next-run",
      );
      expect(container.querySelector<HTMLInputElement>("#space-label-filter")!.value).toBe(
        "next-run",
      );
    },
  );

  it("locks the owning source's export root and package without blocking tree browsing", async () => {
    hooks.busy = true;
    hooks.draftLocked = true;
    await render("tree");
    expect(button("Ipsum branch").disabled).toBe(true);
    const filter = container.querySelector<HTMLInputElement>(
      'input[placeholder="subtree.filterPlaceholder"]',
    )!;
    expect(filter.disabled).toBe(false);
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="sidepanel.tree.expand:Ipsum branch"]',
      )!.disabled,
    ).toBe(false);
    await render("space");
    expect(container.querySelector<HTMLInputElement>("#space-label-filter")!.disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>("#space-prefix-filter")!.disabled).toBe(true);
  });

  it.each([
    ["https://other.example.test/wiki", false],
    ["https://wiki.example.test/confluence", false],
    [tab.host!, true],
  ] as const)(
    "refuses a Watch export under another canonical base or product (%s)",
    async (host, isJira) => {
      hooks.subscriptions = [
        {
          id: "foreign-subscription",
          host,
          scope: "page",
          rootId: "100",
          rootTitle: "Foreign Lorem",
          createdAt: "2026-01-01T00:00:00Z",
          snapshot: {},
        },
      ];
      hooks.diff = {
        added: [],
        removed: [],
        moved: [],
        checkedAt: "2026-01-02T00:00:00Z",
        changed: [
          { pageId: "100", title: "Foreign Lorem", kind: "changed", fromVersion: 1, toVersion: 2 },
        ],
      };
      await render("watch", { ...tab, isJira });
      const exportButton = button("watch.exportChanged");
      expect(exportButton.disabled).toBe(true);
      expect(container.textContent).toContain("watch.sourceMismatch");
      await act(async () => exportButton.click());
      expect(hooks.run).not.toHaveBeenCalled();
    },
  );

  it.each(["directory", "streamed-zip"] as const)(
    "keeps %s selected across scope switches without opening a picker",
    async (destination) => {
      hooks.binding = {
        owner: { surface: "workspace", tabId: 31, windowId: 1 },
        mode: "pinned",
        sourceTabId: 7,
      };
      const directoryPicker = vi.fn();
      vi.stubGlobal("showDirectoryPicker", directoryPicker);
      await render("composer");
      await act(async () =>
        container.querySelector<HTMLInputElement>(`input[value="${destination}"]`)!.click(),
      );
      expect(hooks.workspace?.draft.destination).toBe(destination);
      await act(async () => button("sidepanel.scopes.fragment").click());
      expect(hooks.workspace?.draft.scope).toBe("fragment");
      expect(
        container.querySelector<HTMLInputElement>(`input[value="${destination}"]`)!.checked,
      ).toBe(true);
      expect(directoryPicker).not.toHaveBeenCalled();
    },
  );

  it("keeps one package and one primary action while changing the controlled scope", async () => {
    hooks.binding = {
      owner: { surface: "workspace", tabId: 31, windowId: 1 },
      mode: "pinned",
      sourceTabId: 7,
    };
    await render("composer");
    expect(container.querySelectorAll("[data-export-start]")).toHaveLength(1);
    expect(container.querySelectorAll('button[role="combobox"]')).toHaveLength(1);
    await act(async () => button("sidepanel.scopes.space").click());
    await inputValue(container.querySelector<HTMLInputElement>("#space-label-filter")!, "guide");
    await act(async () => button("sidepanel.scopes.page").click());
    await act(async () => button("sidepanel.scopes.space").click());
    expect(container.querySelector<HTMLInputElement>("#space-label-filter")!.value).toBe("guide");
    await act(async () => button("composer.start").click());
    expect(hooks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "extract-space",
        spaceKey: "LOREM",
        options: { label: "guide" },
      }),
    );
    expect(container.querySelectorAll("[data-export-start]")).toHaveLength(1);
  });
  it.each([
    ["Confluence", tab],
    [
      "Jira",
      {
        ...tab,
        isJira: true,
        issueKey: "LOREM-1",
        host: "https://jira.example.test",
        url: "https://jira.example.test/browse/LOREM-1",
      },
    ],
    [
      "HTML",
      {
        ...tab,
        pageId: undefined,
        host: "https://example.test",
        url: "https://example.test/lorem",
      },
    ],
  ] as const)(
    "disables page companions for an HTML fragment from %s without disabling valid image export",
    async (_product, currentTab) => {
      await render("composer", currentTab);
      await act(async () => button("sidepanel.scopes.fragment").click());
      for (const field of ["editable", "attachments", "comments", "history"]) {
        const label = [...container.querySelectorAll("label")].find(
          (node) => node.textContent === `options.package.${field}`,
        )!;
        const control = document.getElementById(label.htmlFor) as HTMLButtonElement;
        expect(control.disabled).toBe(true);
        expect(control.getAttribute("aria-checked")).toBe("false");
      }
      const imageLabel = [...container.querySelectorAll("label")].find(
        (node) => node.textContent === "options.package.images",
      )!;
      expect((document.getElementById(imageLabel.htmlFor) as HTMLButtonElement).disabled).toBe(
        false,
      );
      expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(3);
      expect(hooks.run).not.toHaveBeenCalled();
    },
  );
});
