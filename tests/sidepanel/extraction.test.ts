import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConfluencePageRaw } from "@/lib/confluence-api";
import { extractSubtree } from "@/sidepanel/extraction";

const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;

const fetchMock = vi.fn<typeof fetch>();

describe("sidepanel extraction", () => {
	beforeEach(() => {
		fetchMock.mockReset();
		globalThis.fetch = fetchMock;
		installChromeStorageMock();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		restoreChrome();
		vi.restoreAllMocks();
	});

	it("extractSubtree skips inline image downloads for the md-only preset", async () => {
		fetchMock.mockImplementation(async (input) => {
			const url = new URL(String(input));
			const expand = url.searchParams.get("expand") ?? "";

			if (url.pathname === "/rest/api/content/root" && expand.includes("body.view")) {
				return jsonResponse(makePageWithImage());
			}

			if (url.pathname === "/rest/api/content/root") {
				return jsonResponse(makePage());
			}

			if (url.pathname === "/rest/api/content/root/child/page") {
				return jsonResponse({ results: [], size: 0 });
			}

			if (url.pathname === "/rest/api/content/root/comment") {
				return jsonResponse({ results: [] });
			}

			if (url.pathname === "/rest/inlinecomments/1.0/comments") {
				return jsonResponse([]);
			}

			if (url.pathname === "/rest/api/content/root/version") {
				return jsonResponse({ results: [] });
			}

			throw new Error(`Unexpected request: ${url.toString()}`);
		});

		await extractSubtree({
			kind: "extract-subtree",
			rootPageId: "root",
			host: "https://wiki.example.com",
			presetId: "md-only",
			maxDepth: 1,
		});

		const requestedUrls = fetchMock.mock.calls.map(([input]) => String(input));
		expect(requestedUrls).not.toContain("https://wiki.example.com/download/attachments/root/chart.png");
		expect(requestedUrls.some((url) => url.includes("/download/attachments/"))).toBe(false);
	});
});

function makePage(): ConfluencePageRaw {
	return {
		id: "root",
		title: "Root Page",
		type: "page",
		status: "current",
		space: { key: "DOC" },
		version: { number: 1 },
		_links: { webui: "/pages/viewpage.action?pageId=root" },
	};
}

function makePageWithImage(): ConfluencePageRaw {
	return {
		...makePage(),
		body: {
			view: {
				representation: "view",
				value: '<p>Intro</p><img src="/download/attachments/root/chart.png" alt="Chart" />',
			},
		},
	};
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function installChromeStorageMock(): void {
	const sync = {
		get: async (keys: string | string[]): Promise<Record<string, unknown>> => {
			const keyList = Array.isArray(keys) ? keys : [keys];
			return Object.fromEntries(keyList.map((key) => [key, undefined]));
		},
		set: async (): Promise<void> => {},
	};

	Object.defineProperty(globalThis, "chrome", {
		configurable: true,
		value: { storage: { sync } },
	});
}

function restoreChrome(): void {
	if (originalChrome === undefined) {
		Reflect.deleteProperty(globalThis, "chrome");
		return;
	}

	Object.defineProperty(globalThis, "chrome", {
		configurable: true,
		value: originalChrome,
	});
}
