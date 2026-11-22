import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusUiSurface, resolveUiSurface } from "@/lib/browser/ui-surface";

const extensionRoot = "chrome-extension://lorem/";
const sourceTab = {
  id: 7,
  windowId: 11,
  url: "https://wiki.example.com/wiki/spaces/DOC/pages/1700/Lorem",
};

function installBrowser({
  ownTab = { id: 90, windowId: 11 },
  windowType = "normal",
  popup = false,
  ownTabListed = true,
}: {
  ownTab?: { id: number; windowId: number; url?: string; pendingUrl?: string } | null;
  windowType?: "normal" | "popup";
  popup?: boolean;
  ownTabListed?: boolean;
} = {}) {
  const currentTab = () => ownTab && { url: location.href, ...ownTab };
  const tabs = {
    getCurrent: vi.fn(async () => currentTab() ?? undefined),
    get: vi.fn(async (id: number) => {
      if (id === sourceTab.id) return sourceTab;
      if (id === 90) {
        return { id: 90, windowId: 11, url: `${extensionRoot}sidepanel/index.html` };
      }
      throw new Error("Tab not found");
    }),
    query: vi.fn(async () => {
      const current = currentTab();
      return current && ownTabListed && current.id !== sourceTab.id
        ? [sourceTab, current]
        : [sourceTab];
    }),
    update: vi.fn().mockResolvedValue({}),
  };
  const windows = {
    get: vi.fn().mockResolvedValue({ id: 11, type: windowType }),
    getCurrent: vi.fn().mockResolvedValue({ id: 11, type: windowType }),
    update: vi.fn().mockResolvedValue({}),
  };
  const action = { openPopup: vi.fn().mockResolvedValue(undefined) };
  const sidePanel = {
    setPanelBehavior: vi.fn(),
    open: vi.fn().mockResolvedValue(undefined),
  };
  vi.stubGlobal("chrome", {
    runtime: {
      getURL: (path: string) => `${extensionRoot}${path}`,
      getManifest: () => ({
        manifest_version: 3,
        action: popup ? { default_popup: "sidepanel/index.html" } : {},
        side_panel: { default_path: "sidepanel/index.html" },
      }),
    },
    tabs,
    windows,
    action,
    sidePanel,
  });
  return { tabs, windows, action, sidePanel };
}

beforeEach(() => {
  vi.stubGlobal("location", new URL(`${extensionRoot}sidepanel/index.html`));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveUiSurface", () => {
  it("leaves a normal extension tab unbound instead of choosing itself or an arbitrary active tab", async () => {
    installBrowser();

    await expect(resolveUiSurface()).resolves.toEqual({
      owner: { surface: "workspace", tabId: 90, windowId: 11 },
      mode: "unbound",
    });
  });

  it("validates an explicit source pin against the physical HTTP tab", async () => {
    installBrowser();
    vi.stubGlobal(
      "location",
      new URL(`${extensionRoot}sidepanel/index.html?surface=workspace&sourceTabId=7`),
    );

    await expect(resolveUiSurface()).resolves.toEqual({
      owner: { surface: "workspace", tabId: 90, windowId: 11 },
      mode: "pinned",
      sourceTabId: 7,
    });
  });

  it.each(["90", "-7", "7.5", "7junk", "0", "999"])(
    "keeps an invalid or non-HTTP source pin %s unbound without active-tab fallback",
    async (pin) => {
      installBrowser();
      vi.stubGlobal(
        "location",
        new URL(`${extensionRoot}sidepanel/index.html?surface=panel&sourceTabId=${pin}`),
      );

      expect(await resolveUiSurface()).toMatchObject({
        owner: { surface: "workspace" },
        mode: "unbound",
      });
    },
  );

  it("does not let a viewer query turn its extension tab into a source", async () => {
    installBrowser();
    vi.stubGlobal(
      "location",
      new URL(`${extensionRoot}viewer/index.html?host=https%3A%2F%2Fwiki.example.com&pageId=1700`),
    );

    expect(await resolveUiSurface()).toMatchObject({ mode: "unbound" });
  });

  it.each([false, true])(
    "binds a native panel or action popup only to its owning browser window (popup=%s)",
    async (popup) => {
      installBrowser({ ownTab: null, popup });

      await expect(resolveUiSurface()).resolves.toEqual({
        owner: { surface: popup ? "popup" : "panel", windowId: 11 },
        mode: "active",
      });
    },
  );

  it("keeps an unlisted native panel pseudo-tab out of workspace capabilities despite a workspace query", async () => {
    installBrowser({ ownTabListed: false });
    vi.stubGlobal(
      "location",
      new URL(`${extensionRoot}sidepanel/index.html?surface=workspace&sourceTabId=7`),
    );

    await expect(resolveUiSurface()).resolves.toEqual({
      owner: { surface: "panel", windowId: 11 },
      mode: "active",
    });
  });

  it("rejects a listed HTTP tab as ownership of the executing extension document", async () => {
    installBrowser({ ownTab: sourceTab });
    await expect(resolveUiSurface()).rejects.toBeInstanceOf(Error);
  });

  it("requires a source pin for a detached popup even when native popup capability exists", async () => {
    installBrowser({ windowType: "popup", popup: true });

    expect(await resolveUiSurface()).toMatchObject({
      owner: { surface: "popup", tabId: 90, windowId: 11 },
      mode: "unbound",
    });
    vi.stubGlobal("location", new URL(`${extensionRoot}sidepanel/index.html?sourceTabId=7`));
    expect(await resolveUiSurface()).toMatchObject({ mode: "pinned", sourceTabId: 7 });
  });
});

describe("focusUiSurface", () => {
  it("focuses the existing owner without navigating or reloading its live workspace", async () => {
    const { tabs, windows } = installBrowser();

    await focusUiSurface({
      instanceId: "owner-lorem",
      surface: "workspace",
      tabId: 90,
      windowId: 11,
    });

    expect(tabs.update).toHaveBeenCalledWith(90, { active: true });
    expect(windows.update).toHaveBeenCalledWith(11, { focused: true });
  });

  it("opens a native panel in the owner window rather than the last focused window", async () => {
    const { sidePanel, windows } = installBrowser({ ownTab: null });

    await focusUiSurface({ instanceId: "owner-lorem", surface: "panel", windowId: 11 });

    expect(sidePanel.open).toHaveBeenCalledWith({ windowId: 11 });
    expect(windows.update).toHaveBeenCalledWith(11, { focused: true });
  });

  it.each(["panel", "popup"] as const)(
    "opens a native %s within the original gesture before awaiting window focus",
    async (surface) => {
      const { sidePanel, action, windows } = installBrowser({ ownTab: null, popup: true });
      const open = surface === "panel" ? sidePanel.open : action.openPopup;
      let gestureActive = true;
      open.mockImplementation(() => {
        if (!gestureActive) return Promise.reject(new Error("A user gesture is required"));
        return Promise.resolve();
      });

      const focusing = focusUiSurface({ instanceId: "owner-lorem", surface, windowId: 11 });
      gestureActive = false;

      await expect(focusing).resolves.toBeUndefined();
      expect(windows.update).toHaveBeenCalledWith(11, { focused: true });
    },
  );

  it("propagates a rejected native opening instead of claiming the owner was focused", async () => {
    const { sidePanel, windows } = installBrowser({ ownTab: null });
    sidePanel.open.mockRejectedValue(new Error("Native panel denied"));

    await expect(
      focusUiSurface({ instanceId: "owner-lorem", surface: "panel", windowId: 11 }),
    ).rejects.toThrow("Native panel denied");
    expect(windows.update).not.toHaveBeenCalled();
  });
});
