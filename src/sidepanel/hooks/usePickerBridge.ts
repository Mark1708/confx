import { useEffect, useState } from "react";
import { MessageBus } from "@/lib/browser/message-bus";
import { storage } from "@/lib/browser/storage";
import type { PickerResult } from "@/types";

const PICKER_RESULT_KEY = "cx:pickerResult";

/**
 * Listens for picker-result messages from content script.
 * In popup mode, also reads stored result from session storage on mount
 * (popup closes during picking — service worker stores result).
 */
export function usePickerBridge() {
  const [pickedBlock, setPickedBlock] = useState<PickerResult | null>(null);

  useEffect(() => {
    const applyPickerResult = (result: PickerResult): void => {
      setPickedBlock(result);
    };

    const handleStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ): void => {
      if (areaName !== "session") return;
      const result = changes[PICKER_RESULT_KEY]?.newValue;
      if (isPickerResult(result)) {
        applyPickerResult(result);
      }
    };

    // Check for stored result from previous picker session (popup reopen case)
    storage.session
      .get(PICKER_RESULT_KEY)
      .then((stored) => {
        const result = stored[PICKER_RESULT_KEY];
        if (isPickerResult(result)) {
          applyPickerResult(result);
        }
      })
      .catch((error) => console.error("[cx] Cannot restore picker result", error));

    // Live listener for Chrome sidePanel (stays open during picking)
    const unsub = MessageBus.on("picker-result", (msg) => {
      applyPickerResult(msg);
    });

    chrome.storage.onChanged.addListener(handleStorageChanged);

    return () => {
      unsub();
      chrome.storage.onChanged.removeListener(handleStorageChanged);
    };
  }, []);

  const clear = () => {
    setPickedBlock(null);
    void storage.session.remove(PICKER_RESULT_KEY);
  };

  return { pickedBlock, clear };
}

function isPickerResult(value: unknown): value is PickerResult {
  if (!value || typeof value !== "object") return false;
  return (value as { kind?: unknown }).kind === "picker-result";
}
