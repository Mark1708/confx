import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfluenceApi } from "@/lib/create-api";

const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalChrome === undefined) Reflect.deleteProperty(globalThis, "chrome");
  else Object.defineProperty(globalThis, "chrome", { configurable: true, value: originalChrome });
  vi.restoreAllMocks();
});

describe("explicit API preparation", () => {
  it("reads from the resolved context even when global defaults point at another site", async () => {
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        storage: {
          sync: {
            get: async () => ({
              "cx.settings.v1": {
                version: 4,
                confluenceBaseUrl: "https://other.example.com/wiki",
                maxRetries: 0,
              },
            }),
          },
        },
      },
    });
    const requested: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      requested.push(url);
      if (!url.startsWith("https://wiki.example.com/custom/wiki/rest/api/content/1000?")) {
        return new Response("wrong source", { status: 404 });
      }
      return new Response(
        JSON.stringify({ id: "1000", title: "Lorem source", type: "page", status: "current" }),
        { headers: { "Content-Type": "application/json" } },
      );
    });
    const api = await createConfluenceApi("https://wiki.example.com/custom/wiki", {
      timeout: 1000,
      maxRetries: 0,
      maxConcurrency: 1,
    });
    const page = await api.getPage("1000", ["space"]);
    expect(page.title).toBe("Lorem source");
    expect(requested).toEqual([
      "https://wiki.example.com/custom/wiki/rest/api/content/1000?expand=space",
    ]);
  });
});
