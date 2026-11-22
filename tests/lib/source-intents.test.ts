import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSourceIntent,
  readSourceIntents,
  storeSourceIntent,
  watchSourceIntents,
  type SourceIntentRecord,
} from "@/lib/browser/source-intents";
import type { SourceContext } from "@/lib/source-context";
import type { OpenConfxRequest, PickerResult } from "@/types";

type ChangeListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void;

const source: SourceContext = {
  tabId: 7,
  windowId: 11,
  product: "confluence",
  baseUrl: "https://wiki.example.com/wiki",
  pageUrl: "https://wiki.example.com/wiki/spaces/DOC/pages/1700/Lorem",
  pageId: "1700",
};
const anotherSource: SourceContext = { ...source, tabId: 8 };
const openPayload: OpenConfxRequest = {
  kind: "open-confx",
  source: "confluence",
  host: source.baseUrl,
  pageId: source.pageId,
  title: "Lorem",
};
const pickerPayload: PickerResult = {
  kind: "picker-result",
  html: "<p>Lorem ipsum</p>",
  meta: {
    id: "1700",
    title: "Lorem",
    spaceKey: "DOC",
    baseUrl: "https://wiki.example.com",
    url: source.pageUrl,
    version: 1,
  },
};

function senderFor(context: SourceContext): chrome.runtime.MessageSender {
  return {
    id: "lorem",
    frameId: 0,
    url: context.pageUrl,
    tab: { id: context.tabId, windowId: context.windowId, url: context.pageUrl } as chrome.tabs.Tab,
  };
}

let memory: Record<string, unknown>;
let listeners: Set<ChangeListener>;

beforeEach(() => {
  memory = {};
  listeners = new Set();
  const notify = (changes: Record<string, chrome.storage.StorageChange>) => {
    for (const listener of [...listeners]) listener(changes, "session");
  };
  vi.stubGlobal("chrome", {
    runtime: { getURL: (path: string) => `chrome-extension://lorem/${path}` },
    storage: {
      session: {
        setAccessLevel: async () => {},
        get: async (keys: string | string[] | null) => {
          const requested =
            keys === null ? Object.keys(memory) : Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(requested.map((key) => [key, structuredClone(memory[key])]));
        },
        set: async (items: Record<string, unknown>) => {
          const changes: Record<string, chrome.storage.StorageChange> = {};
          for (const [key, value] of Object.entries(items)) {
            changes[key] = { oldValue: memory[key], newValue: structuredClone(value) };
            memory[key] = structuredClone(value);
          }
          notify(changes);
        },
        remove: async (keys: string | string[]) => {
          const changes: Record<string, chrome.storage.StorageChange> = {};
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            changes[key] = { oldValue: memory[key] };
            delete memory[key];
          }
          notify(changes);
        },
      },
      onChanged: {
        addListener: (listener: ChangeListener) => listeners.add(listener),
        removeListener: (listener: ChangeListener) => listeners.delete(listener),
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("authoritative source intent handoffs", () => {
  it("takes tab, window and page URL only from the runtime sender", async () => {
    const record = await storeSourceIntent(
      { ...openPayload, tabId: 8, windowId: 80 } as OpenConfxRequest,
      senderFor(source),
    );

    expect(record.source).toEqual({
      tabId: 7,
      windowId: 11,
      url: source.pageUrl,
      origin: "https://wiki.example.com",
    });
    expect(await readSourceIntents(source)).toEqual([record]);
    expect(await readSourceIntents(anotherSource)).toEqual([]);
    expect(record.payload).not.toHaveProperty("tabId");
  });

  it.each([
    { ...openPayload, host: "https://other.example.com/wiki" },
    { ...openPayload, host: "https://wiki.example.com/confluence" },
    {
      ...pickerPayload,
      meta: { ...pickerPayload.meta, url: "https://other.example.com/wiki/pages/1700" },
    },
    { ...pickerPayload, meta: { ...pickerPayload.meta, baseUrl: "https://other.example.com" } },
    {
      ...pickerPayload,
      meta: { ...pickerPayload.meta, url: source.pageUrl.replace("1700", "1701") },
    },
  ])("rejects payload URL authority that does not match the sender", async (payload) => {
    await expect(storeSourceIntent(payload, senderFor(source))).rejects.toThrow();
    expect(memory).toEqual({});
  });

  it.each([
    { ...senderFor(source), id: "another-extension" },
    { ...senderFor(source), frameId: 3 },
    { ...senderFor(source), tab: undefined },
    { ...senderFor(source), url: "https://other.example.com/wiki/pages/1700" },
  ])("rejects non-authoritative senders before recording a body", async (sender) => {
    await expect(storeSourceIntent(pickerPayload, sender)).rejects.toThrow();
    expect(memory).toEqual({});
  });

  it("isolates same-origin product and context paths as well as physical source tabs", async () => {
    await storeSourceIntent(openPayload, senderFor(source));

    expect(
      await readSourceIntents({
        ...source,
        baseUrl: "https://wiki.example.com/confluence",
        pageUrl: "https://wiki.example.com/confluence/pages/1700",
      }),
    ).toEqual([]);
    expect(
      await readSourceIntents({
        ...source,
        product: "jira",
        baseUrl: "https://wiki.example.com/jira",
        pageUrl: "https://wiki.example.com/jira/browse/DOC-1",
      }),
    ).toEqual([]);
    expect(
      await readSourceIntents({
        ...source,
        baseUrl: "https://other.example.com/wiki",
        pageUrl: "https://other.example.com/wiki/pages/1700",
      }),
    ).toEqual([]);
  });

  it("retains separate captures when one physical tab moves between product context paths", async () => {
    const confluenceSource: SourceContext = {
      ...source,
      baseUrl: "https://wiki.example.com/confluence",
      pageUrl: "https://wiki.example.com/confluence/pages/viewpage.action?pageId=1700",
    };
    const first = await storeSourceIntent(pickerPayload, senderFor(source));
    const second = await storeSourceIntent(
      { ...pickerPayload, meta: { ...pickerPayload.meta, url: confluenceSource.pageUrl } },
      senderFor(confluenceSource),
    );

    expect(await readSourceIntents(source)).toEqual([first]);
    expect(await readSourceIntents(confluenceSource)).toEqual([second]);
    await clearSourceIntent(second);
    expect(await readSourceIntents(source)).toEqual([first]);
  });

  it("publishes the newest concurrent capture without retaining a superseded document body", async () => {
    const [first, second] = await Promise.all([
      storeSourceIntent(pickerPayload, senderFor(source)),
      storeSourceIntent({ ...pickerPayload, html: "<p>Newest Lorem</p>" }, senderFor(source)),
    ]);

    expect(await readSourceIntents(source)).toEqual([second]);
    expect(
      Object.values(memory).some((value) => (value as SourceIntentRecord)?.id === first.id),
    ).toBe(false);
  });

  it("clears only an immutable old capture, leaving a newer picker and another source intact", async () => {
    const first = await storeSourceIntent(pickerPayload, senderFor(source));
    const other = await storeSourceIntent(pickerPayload, senderFor(anotherSource));
    const newest = await storeSourceIntent(
      { ...pickerPayload, html: "<p>Dolor sit amet</p>" },
      senderFor(source),
    );

    expect(newest.id).not.toBe(first.id);
    expect(
      Object.values(memory).some((value) => (value as SourceIntentRecord)?.id === first.id),
    ).toBe(false);
    await clearSourceIntent(first);

    expect(await readSourceIntents(source)).toEqual([newest]);
    expect(await readSourceIntents(anotherSource)).toEqual([other]);
    await clearSourceIntent(newest);
    expect(await readSourceIntents(source)).toEqual([]);
    expect(await readSourceIntents(anotherSource)).toEqual([other]);
  });

  it("does not allow a forged record descriptor from another source to erase a capture", async () => {
    const record = await storeSourceIntent(pickerPayload, senderFor(source));
    const forged = { ...record, source: { ...record.source, tabId: anotherSource.tabId } };

    await clearSourceIntent(forged);

    expect(await readSourceIntents(source)).toEqual([record]);
  });

  it("revalidates stored payloads instead of trusting a pointer into malformed or foreign data", async () => {
    const record = await storeSourceIntent(pickerPayload, senderFor(source));
    const key = Object.keys(memory).find(
      (key) => (memory[key] as SourceIntentRecord)?.id === record.id,
    )!;
    memory[key] = {
      ...record,
      payload: {
        ...pickerPayload,
        meta: { ...pickerPayload.meta, url: "https://other.example.com/wiki/pages/1700" },
      },
    };

    expect(await readSourceIntents(source)).toEqual([]);
  });

  it("notifies only the matching source and stops notifications after disposal", async () => {
    const onRecords = vi.fn();
    const unsubscribe = watchSourceIntents(source, onRecords);
    await storeSourceIntent(pickerPayload, senderFor(anotherSource));
    await Promise.resolve();
    expect(onRecords).not.toHaveBeenCalled();

    const record = await storeSourceIntent(pickerPayload, senderFor(source));
    await vi.waitFor(() => expect(onRecords).toHaveBeenLastCalledWith([record]));
    expect(
      onRecords.mock.calls.flat(2).every((value: SourceIntentRecord) => value.source.tabId === 7),
    ).toBe(true);
    unsubscribe();
    const count = onRecords.mock.calls.length;
    await storeSourceIntent(openPayload, senderFor(source));
    await Promise.resolve();
    expect(onRecords).toHaveBeenCalledTimes(count);
    expect(listeners.size).toBe(0);
  });
});
