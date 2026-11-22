import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserApi } from "@/lib/browser/browser-api";
import { grantCurrentTabAccess, resolveTabContext } from "@/sidepanel/hooks/useCurrentTab";

const visibility = { showConfluenceButton: true, showJiraButton: true };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveTabContext", () => {
  it("uses injected metadata and reports available access", async () => {
    vi.spyOn(BrowserApi, "executeScript").mockResolvedValue([
      {
        frameId: 0,
        result: {
          url: "https://wiki.example.com/wiki/spaces/DOC/pages/123/Page",
          title: "Page",
          meta: { confluencePageId: "123", confluenceTitle: "Page", jiraIssueKey: null },
        },
      },
    ]);
    const contains = vi.spyOn(BrowserApi, "containsOriginPermission");

    const result = await resolveTabContext(
      {
        id: 7,
        url: "https://wiki.example.com/wiki/spaces/DOC/pages/123/Page",
        title: "Page",
      },
      visibility,
    );

    expect(result.context).toMatchObject({ kind: "confluence", pageId: "123" });
    expect(result.access).toEqual({
      state: "available",
      origin: "https://wiki.example.com",
      originPattern: "https://wiki.example.com/*",
    });
    expect(contains).not.toHaveBeenCalled();
  });

  it("skips injection for browser-internal URLs", async () => {
    const execute = vi.spyOn(BrowserApi, "executeScript");
    const contains = vi.spyOn(BrowserApi, "containsOriginPermission");

    const result = await resolveTabContext(
      { id: 7, url: "chrome://extensions", title: "Extensions" },
      visibility,
    );

    expect(result.access).toEqual({ state: "unsupported-url" });
    expect(execute).not.toHaveBeenCalled();
    expect(contains).not.toHaveBeenCalled();
  });

  it("never treats the extension viewer's pageId query as an HTTP Confluence source", async () => {
    const execute = vi.spyOn(BrowserApi, "executeScript");
    const result = await resolveTabContext(
      {
        id: 8,
        url: "chrome-extension://lorem/src/viewer/index.html?host=https%3A%2F%2Fwiki.example.com&pageId=1700",
        title: "Lorem viewer",
      },
      visibility,
    );
    expect(result.access).toEqual({ state: "unsupported-url" });
    expect(result.context.kind).toBe("unknown");
    expect(result.context.host).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });
  it("retains URL fallback and exposes narrow recovery when host access is missing", async () => {
    vi.spyOn(BrowserApi, "executeScript").mockRejectedValue(new Error("Cannot access contents"));
    vi.spyOn(BrowserApi, "containsOriginPermission").mockResolvedValue(false);

    const result = await resolveTabContext(
      {
        id: 7,
        url: "https://wiki.example.com/wiki/pages/viewpage.action?pageId=123",
        title: "Fallback Page",
      },
      visibility,
    );

    expect(result.context).toMatchObject({ kind: "confluence", pageId: "123" });
    expect(result.access).toEqual({
      state: "host-access-missing",
      origin: "https://wiki.example.com",
      originPattern: "https://wiki.example.com/*",
    });
    expect(result).not.toHaveProperty("error");
  });

  it("reports a safe generic failure when injection fails despite permission", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(BrowserApi, "executeScript").mockRejectedValue(new Error("sensitive raw message"));
    vi.spyOn(BrowserApi, "containsOriginPermission").mockResolvedValue(true);

    const result = await resolveTabContext(
      { id: 7, url: "https://wiki.example.com/wiki/pages/123", title: "Page" },
      visibility,
    );

    expect(result.access).toEqual({
      state: "injection-failed",
      origin: "https://wiki.example.com",
      originPattern: "https://wiki.example.com/*",
    });
    expect(JSON.stringify(result)).not.toContain("sensitive raw message");
  });
});

describe("grantCurrentTabAccess", () => {
  it("distinguishes granted, declined, and failed requests", async () => {
    const request = vi.spyOn(BrowserApi, "requestOriginPermission");
    request
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("raw"));

    await expect(grantCurrentTabAccess("https://wiki.example.com/*")).resolves.toBe("granted");
    await expect(grantCurrentTabAccess("https://wiki.example.com/*")).resolves.toBe("declined");
    await expect(grantCurrentTabAccess("https://wiki.example.com/*")).resolves.toBe("failed");
  });
});
