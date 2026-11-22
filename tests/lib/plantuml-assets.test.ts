import { deflateSync, strToU8 } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyPlantUmlUrl,
  decodePlantUmlSource,
  fetchPlantUmlAssetsFromHtml,
} from "../../src/lib/plantuml-assets";

const STANDARD_SAMPLE = "SyfFKj2rKt3CoKnELR1Io4ZDoSa70000";
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function encode6(value: number): string {
  if (value < 10) return String.fromCharCode(48 + value);
  if (value < 36) return String.fromCharCode(65 + value - 10);
  if (value < 62) return String.fromCharCode(97 + value - 36);
  return value === 62 ? "-" : "_";
}

function encodePlantUmlSource(source: string): string {
  const bytes = deflateSync(strToU8(source));
  let encoded = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : undefined;
    const third = index + 2 < bytes.length ? bytes[index + 2] : undefined;
    encoded += encode6(first >> 2);
    encoded += encode6(((first & 0x03) << 4) | ((second ?? 0) >> 4));
    if (second === undefined) continue;
    encoded += encode6(((second & 0x0f) << 2) | ((third ?? 0) >> 6));
    if (third === undefined) continue;
    encoded += encode6(third & 0x3f);
  }

  return encoded;
}

function pngResponse(headers: HeadersInit = {}): Response {
  return new Response(PNG_BYTES, {
    status: 200,
    headers: { "Content-Type": "image/png", ...headers },
  });
}

function htmlFor(...hrefs: string[]): string {
  return hrefs.map((href, index) => `<a href="${href}">Diagram ${index + 1}</a>`).join("");
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("decodePlantUmlSource", () => {
  it("round-trips raw-DEFLATE PlantUML text with strict UTF-8", () => {
    const source = "@startuml\nAlice -> Bob: Привет\n@enduml";
    expect(decodePlantUmlSource(encodePlantUmlSource(source), 1024)).toBe(source);
  });

  it("decodes the standard PlantUML sample", () => {
    expect(decodePlantUmlSource(STANDARD_SAMPLE, 1024)).toBe("Bob -> Alice : hello");
  });

  it("rejects invalid alphabet, malformed DEFLATE, invalid UTF-8, and oversized source", () => {
    expect(() => decodePlantUmlSource("not.valid", 1024)).toThrow();
    expect(() => decodePlantUmlSource("0000", 1024)).toThrow();
    expect(() => decodePlantUmlSource(encodePlantUmlSource("123456"), 5)).toThrow();

    const invalidUtf8 = deflateSync(new Uint8Array([0xff]));
    let encoded = "";
    for (let index = 0; index < invalidUtf8.length; index += 3) {
      const first = invalidUtf8[index];
      const second = invalidUtf8[index + 1];
      const third = invalidUtf8[index + 2];
      encoded += encode6(first >> 2);
      encoded += encode6(((first & 3) << 4) | ((second ?? 0) >> 4));
      if (second === undefined) break;
      encoded += encode6(((second & 15) << 2) | ((third ?? 0) >> 6));
      if (third === undefined) break;
      encoded += encode6(third & 63);
    }
    expect(() => decodePlantUmlSource(encoded, 1024)).toThrow();
  });
});

describe("classifyPlantUmlUrl", () => {
  it("accepts exact official HTTPS UML links and canonicalizes the bare host", () => {
    const bare = `https://plantuml.com/plantuml/uml/${STANDARD_SAMPLE}`;
    const www = `https://www.plantuml.com/plantuml/uml/${STANDARD_SAMPLE}`;

    expect(classifyPlantUmlUrl(bare)).toEqual({
      kind: "accepted",
      rawHref: bare,
      canonicalUrl: www,
      encoded: STANDARD_SAMPLE,
    });
    expect(classifyPlantUmlUrl(www)).toEqual({
      kind: "accepted",
      rawHref: www,
      canonicalUrl: www,
      encoded: STANDARD_SAMPLE,
    });
  });

  it.each([
    `http://www.plantuml.com/plantuml/uml/${STANDARD_SAMPLE}`,
    `https://www.plantuml.com:444/plantuml/uml/${STANDARD_SAMPLE}`,
    `https://www.plantuml.com:443/plantuml/uml/${STANDARD_SAMPLE}`,
    `https://user:pass@www.plantuml.com/plantuml/uml/${STANDARD_SAMPLE}`,
    `https://www.plantuml.com/plantuml/uml/${STANDARD_SAMPLE}?x=1`,
    `https://www.plantuml.com/plantuml/uml/${STANDARD_SAMPLE}#x`,
    `https://www.plantuml.com/plantuml/uml/${STANDARD_SAMPLE}/extra`,
    "https://www.plantuml.com/plantuml/proxy?src=https://example.com/a.puml",
    "https://www.plantuml.com/plantuml/uml/not.valid",
  ])("classifies an official but unsupported link: %s", (href) => {
    expect(classifyPlantUmlUrl(href)).toEqual({ kind: "unsupported", rawHref: href });
  });

  it("ignores generic external and self-hosted links", () => {
    const href = `https://diagrams.example.com/plantuml/uml/${STANDARD_SAMPLE}`;
    expect(classifyPlantUmlUrl(href)).toEqual({ kind: "ignored", rawHref: href });
  });
});

describe("fetchPlantUmlAssetsFromHtml", () => {
  it("fetches one canonical PNG pair for aliases and maps every accepted raw href", async () => {
    const bare = `https://plantuml.com/plantuml/uml/${STANDARD_SAMPLE}`;
    const www = `https://www.plantuml.com/plantuml/uml/${STANDARD_SAMPLE}`;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(pngResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchPlantUmlAssetsFromHtml(htmlFor(bare, www, bare), {
      pageId: "page-1",
      maxAssetBytes: 1024,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      `https://www.plantuml.com/plantuml/png/${STANDARD_SAMPLE}`,
      expect.objectContaining({
        credentials: "omit",
        redirect: "error",
        headers: { Accept: "image/png" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].png.archivePath).toMatch(
      /^attachments\/linked\/plantuml\/plantuml-[a-f0-9]{64}\.png$/,
    );
    expect(result.assets[0].source.archivePath).toBe(
      result.assets[0].png.archivePath.replace(/\.png$/, ".puml"),
    );
    expect(await result.assets[0].source.blob.text()).toBe("Bob -> Alice : hello");
    expect(result.hrefToPng.get(bare)).toBe(result.assets[0].png.archivePath);
    expect(result.hrefToPng.get(www)).toBe(result.assets[0].png.archivePath);
    expect(result.outcome).toEqual({
      discovered: 1,
      archived: 1,
      skippedLimit: 0,
      failedDownloads: 0,
      unsupported: 0,
    });
    expect(result.failures).toEqual([]);
  });

  it("caps unique diagrams at 20 without inflating counts for duplicate aliases", async () => {
    const links = Array.from({ length: 21 }, (_, index) => {
      const encoded = encodePlantUmlSource(`@startuml\nAlice -> Bob: ${index}\n@enduml`);
      return `https://www.plantuml.com/plantuml/uml/${encoded}`;
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(pngResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchPlantUmlAssetsFromHtml(htmlFor(...links, links[0]), {
      pageId: "page-1",
      maxAssetBytes: 1024,
    });

    expect(fetchMock).toHaveBeenCalledTimes(20);
    expect(result.assets).toHaveLength(20);
    expect(result.outcome).toEqual({
      discovered: 21,
      archived: 20,
      skippedLimit: 1,
      failedDownloads: 0,
      unsupported: 0,
    });
    expect(result.failures).toEqual([
      { scope: "linked-asset", page_id: "page-1", reason: "linked-asset-limit" },
    ]);
  });

  it("never fetches rejected official links or generic external links", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const invalid = `https://www.plantuml.com/plantuml/uml/${STANDARD_SAMPLE}?query=1`;

    const result = await fetchPlantUmlAssetsFromHtml(
      htmlFor(invalid, invalid, "https://example.com/plantuml/uml/abc"),
      { pageId: "page-1", maxAssetBytes: 1024 },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.outcome.unsupported).toBe(1);
    expect(result.failures).toEqual([
      { scope: "linked-asset", page_id: "page-1", reason: "unsupported-link" },
    ]);
    expect(JSON.stringify(result.failures)).not.toContain(STANDARD_SAMPLE);
  });

  it("treats invalid source data as unsupported without requesting PNG", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const href = "https://www.plantuml.com/plantuml/uml/0000";

    const result = await fetchPlantUmlAssetsFromHtml(htmlFor(href), {
      pageId: "page-1",
      maxAssetBytes: 1024,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.outcome.unsupported).toBe(1);
    expect(result.failures[0]).toEqual({
      scope: "linked-asset",
      page_id: "page-1",
      reason: "unsupported-link",
    });
    expect(result.hrefToPng).toEqual(new Map());
  });

  it.each([
    ["non-PNG response", () => new Response("text", { headers: { "Content-Type": "text/plain" } })],
    ["failed response", () => new Response(null, { status: 503 })],
    [
      "redirected response",
      () => {
        const response = pngResponse();
        Object.defineProperty(response, "redirected", { value: true });
        return response;
      },
    ],
    [
      "missing body",
      () =>
        ({ ...pngResponse(), ok: true, status: 200, redirected: false, body: null }) as Response,
    ],
    ["oversized declared response", () => pngResponse({ "Content-Length": "33" })],
    [
      "oversized streamed response",
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(20));
              controller.enqueue(new Uint8Array(20));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "image/png" } },
        ),
    ],
  ])("preserves the link and reports a redacted fetch failure for %s", async (_name, response) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetchMock);
    const href = `https://www.plantuml.com/plantuml/uml/${STANDARD_SAMPLE}`;

    const result = await fetchPlantUmlAssetsFromHtml(htmlFor(href), {
      pageId: "page-1",
      maxAssetBytes: 32,
    });

    expect(result.assets).toEqual([]);
    expect(result.hrefToPng).toEqual(new Map());
    expect(result.outcome.failedDownloads).toBe(1);
    expect(result.failures[0]).toMatchObject({
      scope: "linked-asset",
      page_id: "page-1",
      reason: "fetch-failed",
    });
    expect(result.failures[0]).not.toHaveProperty("href");
    expect(JSON.stringify(result.failures)).not.toContain(STANDARD_SAMPLE);
  });

  it.each([Number.POSITIVE_INFINITY, -1, 0, Number.NaN])(
    "uses the safe provider limit for invalid maxAssetBytes=%s",
    async (maxAssetBytes) => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(pngResponse());
      vi.stubGlobal("fetch", fetchMock);
      const href = `https://www.plantuml.com/plantuml/uml/${STANDARD_SAMPLE}`;

      const result = await fetchPlantUmlAssetsFromHtml(htmlFor(href), {
        pageId: "page-1",
        maxAssetBytes,
      });

      expect(result.outcome.archived).toBe(1);
    },
  );

  it("reports a timer-fired timeout but continues with other diagrams", async () => {
    vi.useFakeTimers();
    const second = encodePlantUmlSource("@startuml\nA -> B: second\n@enduml");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce((_url, init) => {
        const { promise, reject } = Promise.withResolvers<Response>();
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
        return promise;
      })
      .mockResolvedValueOnce(pngResponse());
    vi.stubGlobal("fetch", fetchMock);

    const pending = fetchPlantUmlAssetsFromHtml(
      htmlFor(
        `https://www.plantuml.com/plantuml/uml/${STANDARD_SAMPLE}`,
        `https://www.plantuml.com/plantuml/uml/${second}`,
      ),
      { pageId: "page-1", maxAssetBytes: 1024 },
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.outcome).toMatchObject({ archived: 1, failedDownloads: 1 });
  });

  it("rejects caller cancellation rather than returning an empty success", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError")),
      );
      return promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    const href = `https://www.plantuml.com/plantuml/uml/${STANDARD_SAMPLE}`;

    const pending = fetchPlantUmlAssetsFromHtml(htmlFor(href), {
      pageId: "page-1",
      maxAssetBytes: 1024,
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("cancels a pending PNG body read and rejects when the caller aborts", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) { bodyController = streamController; },
      cancel,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(body, { headers: { "Content-Type": "image/png" } }),
    ));
    const settled = fetchPlantUmlAssetsFromHtml(
      htmlFor(`https://www.plantuml.com/plantuml/uml/${STANDARD_SAMPLE}`),
      { pageId: "page-1", maxAssetBytes: 1024, signal: controller.signal },
    ).then((value) => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
    try {
      await vi.waitFor(() => expect(body.locked).toBe(true), { timeout: 500 });
      controller.abort();
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce(), { timeout: 500 });
      expect((await settled).error).toMatchObject({ name: "AbortError" });
    } finally {
      if (!cancel.mock.calls.length) bodyController.close();
      await settled;
    }
  });
});
