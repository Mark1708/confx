import { describe, expect, it } from "vitest";
import { canonicalBaseUrl, resolveSourceBase, sourceKey } from "@/lib/source-context";

const base = "https://wiki.example.com/wiki";

describe("source base resolution", () => {
  it.each(["/wiki", "/confluence", "/custom/wiki"])(
    "uses a matching same-origin context %s without redetecting it as the origin",
    (path) => {
      expect(
        resolveSourceBase(
          `https://wiki.example.com${path}/pages/viewpage.action?pageId=1000`,
          "https://wiki.example.com",
          `https://wiki.example.com${path}/`,
        ),
      ).toEqual({ baseUrl: `https://wiki.example.com${path}` });
    },
  );

  it("never redirects a source to another origin, including a different port", () => {
    for (const override of [
      "https://other.example.com/wiki",
      "https://wiki.example.com:8443/wiki",
    ]) {
      expect(
        resolveSourceBase(`${base}/pages/viewpage.action?pageId=1000`, base, override),
      ).toEqual({ baseUrl: base, overrideDiagnostic: "cross-origin" });
    }
  });

  it("matches context path segments, not lexical prefixes or another same-origin application", () => {
    expect(
      resolveSourceBase(
        "https://wiki.example.com/wiki-two/pages/1000",
        "https://wiki.example.com",
        base,
      ),
    ).toEqual({ baseUrl: "https://wiki.example.com", overrideDiagnostic: "path-mismatch" });
    expect(
      resolveSourceBase(`${base}/pages/1000`, base, "https://wiki.example.com/confluence"),
    ).toEqual({ baseUrl: base, overrideDiagnostic: "path-mismatch" });
  });

  it("reports an unusable override rather than replacing a valid detected base", () => {
    for (const override of [
      "not a URL",
      "file:///wiki",
      "https://user:sample@wiki.example.com/wiki",
    ]) {
      expect(resolveSourceBase(`${base}/pages/1000`, base, override)).toEqual({
        baseUrl: base,
        overrideDiagnostic: "invalid-url",
      });
    }
  });

  it("uses canonical origin/context for draft identity, not current page identity", () => {
    const source = {
      tabId: 7,
      windowId: 3,
      product: "confluence" as const,
      baseUrl: `${base}/`,
      pageUrl: `${base}/pages/1000`,
      pageId: "1000",
    };
    const original = sourceKey(source);
    expect(
      sourceKey({ ...source, baseUrl: base, pageUrl: `${base}/pages/1100`, pageId: "1100" }),
    ).toBe(original);
    expect(sourceKey({ ...source, tabId: 8 })).not.toBe(original);
    expect(sourceKey({ ...source, product: "jira" })).not.toBe(original);
    expect(sourceKey({ ...source, baseUrl: "https://other.example.com/wiki" })).not.toBe(original);
    expect(canonicalBaseUrl(`${base}/?unused=value#section`)).toBe(base);
  });
});
