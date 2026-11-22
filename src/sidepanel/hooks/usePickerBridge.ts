import { useWorkspace } from "../workspace/WorkspaceProvider";

export function usePickerBridge() {
  const { pickedBlock, clearPickedBlock } = useWorkspace();
  return { pickedBlock, clear: clearPickedBlock };
}
