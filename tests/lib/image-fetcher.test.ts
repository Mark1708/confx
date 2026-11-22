import { webcrypto } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { fetchImagesFromHtml } from "@/lib/image-fetcher";
import type { ConfluenceApi } from "@/lib/confluence-api";

describe("image fetch failure logging", () => {
  beforeAll(() => {
    vi.stubGlobal("crypto", webcrypto);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("does not log the image URL, query string or raw error when a download fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const api = {
      fetchBlob: vi.fn().mockRejectedValue(new Error("TEST_ONLY_RAW_ERROR")),
    } as unknown as ConfluenceApi;
    const src = "https://wiki.example.test/download/secret.png?signature=TEST_ONLY_SENTINEL";

    const result = await fetchImagesFromHtml(`<img src="${src}">`, api, "images");

    expect(result.images).toEqual([]);
    expect(result.failures).toEqual([{ scope: "attachment", href: src, reason: "fetch-failed" }]);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("TEST_ONLY_SENTINEL");
    expect(logged).not.toContain("secret.png");
    expect(logged).not.toContain("TEST_ONLY_RAW_ERROR");
    expect(logged).toContain("fetch-failed");
  });
});
