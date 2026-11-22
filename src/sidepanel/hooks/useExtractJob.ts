import { useCallback, useState } from "react";
import type { I18nKey } from "@/i18n";
import { isExtractRequest, type PreparedExport } from "@/lib/export/contracts";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import type { ExportDefaults, ExtensionRequest } from "@/types";
import {
  destinationCapability,
  notifyDestinationPrepared,
  openDestinationDirectory,
  type DestinationCapabilityReason,
} from "../workspace/destinations";
import { openWorkspaceTab } from "../workspace/open-workspace";
import { useWorkspace } from "../workspace/WorkspaceProvider";
import { useI18n } from "./useI18n";

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const DESTINATION_REASON_KEYS: Readonly<Record<DestinationCapabilityReason, I18nKey>> = {
  "insecure-context": "sidepanel.destination.reasons.insecureContext",
  "api-unavailable": "sidepanel.destination.reasons.apiUnavailable",
  "surface-restricted": "sidepanel.destination.reasons.surfaceRestricted",
};

export function useExtractJob() {
  const { source, sourceKey, draft, patchDraft, controller, exportView, settings, store, binding } =
    useWorkspace();
  const { t } = useI18n();
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const defaults =
    draft.defaults ?? settings.data?.exportDefaults ?? DEFAULT_SETTINGS.exportDefaults;
  const draftLocked =
    exportView.selecting || (exportView.busy && exportView.state?.sourceKey === sourceKey);

  const setDefaults = useCallback(
    (next: ExportDefaults) => {
      patchDraft({ defaults: next });
      setDefaultsError(null);
    },
    [patchDraft],
  );
  const saveDefaults = useCallback(async () => {
    const override = draft.defaults;
    setDefaultsError(null);
    try {
      await settings.updateAsync({ exportDefaults: structuredClone(defaults) });
      if (
        override &&
        JSON.stringify(store.getSnapshot().drafts.get(sourceKey)?.defaults) ===
          JSON.stringify(override)
      ) {
        store.update(sourceKey, { defaults: null });
      }
    } catch (error) {
      setDefaultsError(message(error));
    }
  }, [draft.defaults, defaults, settings.updateAsync, sourceKey, store]);
  const run = useCallback(
    async (request: ExtensionRequest) => {
      if (!isExtractRequest(request) || exportView.busy || exportView.selecting) return;
      setDefaultsError(null);
      const destination = draft.destination;
      const multiplePages =
        request.kind === "extract-subtree" ||
        request.kind === "extract-space" ||
        request.kind === "extract-jira-search" ||
        request.kind === "extract-watch-changed";
      if (
        binding?.owner.surface !== "workspace" &&
        (multiplePages || destination !== "download-zip")
      ) {
        try {
          if (!source) throw new Error(t("sourceBase.sourceUnavailable"));
          await store.flush();
          await openWorkspaceTab(source.tabId, "export");
        } catch (error) {
          setDefaultsError(message(error));
        }
        return;
      }
      const capability = destinationCapability(destination, binding?.owner.surface);
      if (!capability.supported && capability.reason) {
        // An unusable mode surfaces its reason; the user picks another destination explicitly.
        setDefaultsError(t(DESTINATION_REASON_KEYS[capability.reason]));
        return;
      }
      let prepared: PreparedExport;
      try {
        if (!source) throw new Error(t("sourceBase.sourceUnavailable"));
        if (!settings.data) throw new Error("Export settings have not loaded");
        prepared = controller.prepare(
          source,
          {
            request,
            defaults,
            destination,
          },
          settings.data,
        );
      } catch (error) {
        setDefaultsError(message(error));
        return;
      }
      // The native picker is the first promise of this click: user activation does
      // not survive earlier awaits, and the handle promise goes straight to the
      // controller, which resolves it before acquiring the export lock.
      try {
        if (destination !== "download-zip") {
          notifyDestinationPrepared({ id: prepared.id, rootName: prepared.rootName, destination });
          await controller.start(prepared, openDestinationDirectory());
        } else {
          await controller.start(prepared, "download-zip");
        }
      } catch (error) {
        setDefaultsError(message(error));
      }
    },
    [
      source,
      settings.data,
      defaults,
      draft.destination,
      controller,
      exportView.busy,
      exportView.selecting,
      binding,
      store,
      t,
    ],
  );
  const cancel = useCallback(() => {
    controller.cancel();
  }, [controller]);

  return {
    run,
    cancel,
    busy: exportView.busy,
    ownsJob: exportView.ownsJob,
    selecting: exportView.selecting,
    draftLocked,
    defaults,
    setDefaults,
    saveDefaults,
    savingDefaults: settings.saving,
    defaultsError,
  };
}
