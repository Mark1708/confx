import { ExportComposer } from "./components/ExportComposer";
import { WatchPanel } from "./components/WatchPanel";
import { WorkspaceShell } from "./components/WorkspaceShell";
import { useI18n } from "./hooks/useI18n";
import { useWorkspaceShell } from "./workspace/WorkspaceProvider";

export function App() {
  const { draft, sourceKey, controller, settings } = useWorkspaceShell();
  const { t } = useI18n();
  const ready = Boolean(draft && sourceKey && controller && settings.data);
  return (
    <WorkspaceShell>
      {ready ? (
        draft?.section === "watch" ? (
          <WatchPanel />
        ) : (
          <ExportComposer />
        )
      ) : (
        <p role="status" className="p-3 text-xs text-muted-foreground">
          {t("sourceBase.sourceUnavailable")}
        </p>
      )}
    </WorkspaceShell>
  );
}
