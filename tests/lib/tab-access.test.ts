import { afterEach, describe, expect, it, type Mock, vi } from "vitest";

import { BrowserApi } from "../../src/lib/browser/browser-api";
import {
  classifyTabAccess,
  currentOriginPattern,
  isCurrentOriginPattern,
} from "../../src/lib/browser/tab-access";

const originalChrome = globalThis.chrome;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalChrome === undefined) {
    Reflect.deleteProperty(globalThis, "chrome");
  } else {
    Object.defineProperty(globalThis, "chrome", { configurable: true, value: originalChrome });
  }
});

describe("tab access classification", () => {
  it.each([
    "chrome://extensions",
    "chrome-extension://extension-id/options.html",
    "about:blank",
    "file:///tmp/page.html",
    "view-source:https://example.com",
    "",
  ])("classifies %s as unsupported without exposing it as an origin", (url) => {
    expect(classifyTabAccess(url)).toEqual({ state: "unsupported-url" });
  });

  it.each([
    [
      "https://wiki.example.com/wiki/pages/1",
      "https://wiki.example.com",
      "https://wiki.example.com/*",
    ],
    ["http://localhost:8090/confluence", "http://localhost:8090", "http://localhost:8090/*"],
  ])("classifies %s as an injectable origin", (url, origin, originPattern) => {
    expect(classifyTabAccess(url)).toEqual({ state: "available", origin, originPattern });
    expect(currentOriginPattern(url)).toBe(originPattern);
  });

  it("accepts only exact http(s) current-origin patterns", () => {
    expect(isCurrentOriginPattern("https://wiki.example.com/*")).toBe(true);
    expect(isCurrentOriginPattern("http://localhost:8090/*")).toBe(true);
    expect(isCurrentOriginPattern("https://*.example.com/*")).toBe(false);
    expect(isCurrentOriginPattern("https://wiki.example.com/wiki/*")).toBe(false);
    expect(isCurrentOriginPattern("chrome://extensions/*")).toBe(false);
    expect(isCurrentOriginPattern("https://user:pass@example.com/*")).toBe(false);
  });
});

describe("BrowserApi origin permission wrappers", () => {
  it("checks and requests exactly one validated current origin", async () => {
    const contains = vi.fn().mockResolvedValue(false);
    const request = vi.fn().mockResolvedValue(true);
    installPermissions({ contains, request });

    await expect(BrowserApi.containsOriginPermission("https://wiki.example.com/*")).resolves.toBe(
      false,
    );
    await expect(BrowserApi.requestOriginPermission("https://wiki.example.com/*")).resolves.toBe(
      true,
    );
    expect(contains).toHaveBeenCalledWith({ origins: ["https://wiki.example.com/*"] });
    expect(request).toHaveBeenCalledWith({ origins: ["https://wiki.example.com/*"] });
  });

  it("rejects wildcard and path-scoped patterns before calling Chrome", async () => {
    const contains = vi.fn();
    const request = vi.fn();
    installPermissions({ contains, request });

    await expect(BrowserApi.containsOriginPermission("https://*/*")).rejects.toThrow(
      "Invalid current-origin permission pattern",
    );
    await expect(
      BrowserApi.requestOriginPermission("https://wiki.example.com/wiki/*"),
    ).rejects.toThrow("Invalid current-origin permission pattern");
    expect(contains).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});

function installPermissions(methods: { contains: Mock; request: Mock }): void {
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: { permissions: methods },
  });
}
