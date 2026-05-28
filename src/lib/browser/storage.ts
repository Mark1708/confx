/// <reference types="chrome" />

export const storage = {
  sync: {
    get: async (keys: string | string[]): Promise<Record<string, unknown>> =>
      chrome.storage.sync.get(keys) as Promise<Record<string, unknown>>,
    set: async (items: Record<string, unknown>): Promise<void> =>
      chrome.storage.sync.set(items),
  },
  local: {
    get: async (keys: string | string[] | null): Promise<Record<string, unknown>> =>
      chrome.storage.local.get(keys) as Promise<Record<string, unknown>>,
    set: async (items: Record<string, unknown>): Promise<void> =>
      chrome.storage.local.set(items),
    remove: async (keys: string | string[]): Promise<void> =>
      chrome.storage.local.remove(keys),
  },
  session: {
    get: async (keys: string | string[] | null): Promise<Record<string, unknown>> =>
      chrome.storage.session.get(keys) as Promise<Record<string, unknown>>,
    set: async (items: Record<string, unknown>): Promise<void> =>
      chrome.storage.session.set(items),
    remove: async (keys: string | string[]): Promise<void> =>
      chrome.storage.session.remove(keys),
  },
};
