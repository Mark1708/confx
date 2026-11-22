import type { DestinationKind } from "@/lib/export/contracts";
import type { ExportJobOwner } from "@/types";

export type DestinationCapabilityReason =
  | "insecure-context"
  | "api-unavailable"
  | "surface-restricted";

export interface DestinationCapability {
  supported: boolean;
  reason: DestinationCapabilityReason | null;
}

/** Disk destinations require a secure context, the File System Access API, and a workspace tab. */
export function destinationCapability(
  destination: DestinationKind,
  surface: ExportJobOwner["surface"] | undefined,
): DestinationCapability {
  if (destination === "download-zip") return { supported: true, reason: null };
  if (globalThis.isSecureContext === false) return { supported: false, reason: "insecure-context" };
  if (typeof pickerGlobals.showDirectoryPicker !== "function")
    return { supported: false, reason: "api-unavailable" };
  if (surface !== "workspace") return { supported: false, reason: "surface-restricted" };
  return { supported: true, reason: null };
}

export interface DestinationPreparedInfo {
  id: string;
  rootName: string;
  destination: "directory" | "streamed-zip";
}
/**
 * Test-only seam for E2E (sandbox/e2e/destinations.spec.mjs): real OPFS handles are
 * injected exactly at the native picker boundary. Production never defines it.
 * - `directory` replaces only showDirectoryPicker for both disk destinations;
 *   the returned promise is passed into the export controller untouched.
 * - `onPrepared` observes the job ID and a root-name hint before the picker call.
 *   The producer supplies the actual package root later; E2E derives collision
 *   names from a reference package plus this job ID, not from the hint.
 */
export interface DestinationPickerOverride {
  directory?: () => Promise<FileSystemDirectoryHandle>;
  onPrepared?: (info: DestinationPreparedInfo) => void;
}

export const DESTINATION_PICKER_SEAM = "__confxExportPickers" as const;

type DirectoryPicker = (options: { mode: "readwrite" }) => Promise<FileSystemDirectoryHandle>;

/**
 * Named unchecked cast: lib.dom does not declare the File System Access picker entry
 * points, and the E2E seam is an intentionally undeclared window property. All reads
 * below re-check the runtime shape before use.
 */
const pickerGlobals = globalThis as typeof globalThis & {
  showDirectoryPicker?: DirectoryPicker;
  [DESTINATION_PICKER_SEAM]?: DestinationPickerOverride;
};

function pickerOverride(): DestinationPickerOverride | undefined {
  const value = pickerGlobals[DESTINATION_PICKER_SEAM];
  return typeof value === "object" && value !== null ? value : undefined;
}

/** Must run as the first promise of the click handler: user activation does not survive awaits. */
export function openDestinationDirectory(): Promise<FileSystemDirectoryHandle> {
  const override = pickerOverride();
  if (override?.directory) return override.directory();
  const picker = pickerGlobals.showDirectoryPicker;
  if (typeof picker !== "function")
    return Promise.reject(new Error("This browser cannot choose an export folder"));
  return picker({ mode: "readwrite" });
}

/** Test-seam observation point right before the native picker call. */
export function notifyDestinationPrepared(info: DestinationPreparedInfo): void {
  pickerOverride()?.onPrepared?.(info);
}
