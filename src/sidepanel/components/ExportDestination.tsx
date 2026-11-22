import { useId } from "react";
import type { I18nKey } from "@/i18n";
import type { DestinationKind } from "@/lib/export/contracts";
import { useI18n } from "../hooks/useI18n";
import { destinationCapability, type DestinationCapabilityReason } from "../workspace/destinations";
import { useWorkspace } from "../workspace/WorkspaceProvider";

export const DESTINATION_LABEL_KEYS = {
  "download-zip": "sidepanel.destination.downloadZip",
  directory: "sidepanel.destination.directory",
  "streamed-zip": "sidepanel.destination.streamedZip",
} as const;
const DESCRIPTION_KEYS = {
  "download-zip": "composer.destinations.downloadDescription",
  directory: "composer.destinations.directoryDescription",
  "streamed-zip": "composer.destinations.streamedDescription",
} as const;
export const DESTINATION_REASON_KEYS: Readonly<Record<DestinationCapabilityReason, I18nKey>> = {
  "insecure-context": "sidepanel.destination.reasons.insecureContext",
  "api-unavailable": "sidepanel.destination.reasons.apiUnavailable",
  "surface-restricted": "sidepanel.destination.reasons.surfaceRestricted",
};
const DESTINATIONS: readonly DestinationKind[] = ["download-zip", "directory", "streamed-zip"];

export function ExportDestination({ disabled = false }: { disabled?: boolean }) {
  const { t } = useI18n();
  const { draft, patchDraft, binding } = useWorkspace();
  const id = useId();
  const inWorkspace = binding?.owner.surface === "workspace";
  const selected = destinationCapability(draft.destination, binding?.owner.surface);
  return (
    <fieldset className="min-w-0 space-y-2" disabled={disabled}>
      <legend className="sr-only">{t("sidepanel.destination.label")}</legend>
      {DESTINATIONS.map((destination) => {
        const capability = destinationCapability(destination, binding?.owner.surface);
        // A panel can choose a disk destination for the new workspace. Only that
        // normal tab decides its actual API capability; no picker runs in the panel.
        const unavailable = inWorkspace && !capability.supported;
        const note = `${id}-${destination}-note`;
        return (
          <label key={destination} className="cx-destination-choice">
            <input
              type="radio"
              name={`${id}-destination`}
              value={destination}
              checked={draft.destination === destination}
              disabled={disabled || unavailable}
              aria-label={t(DESTINATION_LABEL_KEYS[destination])}
              aria-describedby={note}
              onChange={() => patchDraft({ destination })}
            />
            <span className="min-w-0">
              <strong className="block text-xs font-medium">
                {t(DESTINATION_LABEL_KEYS[destination])}
              </strong>
              <span id={note} className="block text-[11px] text-muted-foreground">
                {unavailable && capability.reason
                  ? t(DESTINATION_REASON_KEYS[capability.reason])
                  : t(DESCRIPTION_KEYS[destination])}
              </span>
            </span>
          </label>
        );
      })}
      {!inWorkspace && (
        <p className="text-xs text-muted-foreground">{t("sidepanel.destination.workspaceNote")}</p>
      )}
      {inWorkspace && !selected.supported && selected.reason && (
        <p role="note" className="text-xs text-warning">
          {t(DESTINATION_REASON_KEYS[selected.reason])}
        </p>
      )}
    </fieldset>
  );
}
