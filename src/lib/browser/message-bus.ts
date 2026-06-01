import type { ExtensionMessage } from "@/types";

type Handler = (msg: unknown, sender: chrome.runtime.MessageSender) => unknown;

/**
 * Typed message bus for extension runtime messages.
 * Single chrome.runtime.onMessage listener dispatches to handlers by message kind.
 * Supports async handlers — returns true to keep response channel open.
 */
export class MessageBus {
  private static handlers = new Map<string, Handler>();
  private static listenerActive = false;

  static send<T extends ExtensionMessage>(message: T): Promise<unknown> {
    return chrome.runtime.sendMessage(message);
  }

  static on<K extends ExtensionMessage["kind"]>(
    kind: K,
    handler: (
      msg: Extract<ExtensionMessage, { kind: K }>,
      sender: chrome.runtime.MessageSender,
    ) => unknown,
  ): () => void {
    if (!MessageBus.listenerActive) {
      MessageBus.listenerActive = true;
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg && typeof msg === "object") {
          const msgKind = (msg as { kind?: string }).kind;
          if (msgKind && MessageBus.handlers.has(msgKind)) {
            const result = MessageBus.handlers.get(msgKind)!(msg, sender);
            if (result instanceof Promise) {
              result.then(sendResponse).catch((err) => {
                console.error(`[MessageBus] handler for "${msgKind}" failed`, err);
                sendResponse({ ok: false, error: String(err) });
              });
              return true; // keep channel open for async response
            }
            sendResponse(result);
          }
        }
      });
    }
    MessageBus.handlers.set(kind, handler as Handler);
    return () => MessageBus.handlers.delete(kind);
  }
}
