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
    // Check for stored result from previous picker session (popup reopen case)
    storage.session
      .get(PICKER_RESULT_KEY)
      .then((stored) => {
        const result = stored[PICKER_RESULT_KEY] as PickerResult | undefined;
        if (result?.kind === "picker-result") {
          setPickedBlock(result);
          void storage.session.remove(PICKER_RESULT_KEY);
        }
      })
      .catch(() => {});

    // Live listener for Chrome sidePanel (stays open during picking)
    const unsub = MessageBus.on("picker-result", (msg) => {
      setPickedBlock(msg);
    });

    return unsub;
  }, []);

  const clear = () => setPickedBlock(null);

  return { pickedBlock, clear };
}
