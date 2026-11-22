import { Download, Loader2, PanelsTopLeft, Upload } from "lucide-react";
import { useState } from "react";
import type { CurrentTabInfo } from "../hooks/useCurrentTab";
import { useEditorRoundtrip, type LoadedEdit } from "../hooks/useEditorRoundtrip";
import { useI18n } from "../hooks/useI18n";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";

export function EditorRoundtripPanel({
  tab,
  inWorkspace = false,
  onChooseInTab,
}: {
  tab: CurrentTabInfo;
  inWorkspace?: boolean;
  onChooseInTab?: () => Promise<void>;
}) {
  const { t } = useI18n();
  const workflow = useEditorRoundtrip(tab);
  const changes = workflow.edit?.result.changes ?? [];
  const busy = workflow.operation !== null;
  const [confirmingEdit, setConfirmingEdit] = useState<LoadedEdit | null>(null);
  const confirming = workflow.canApply && confirmingEdit === workflow.edit;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{t("editorRoundtrip.title")}</CardTitle>
      </CardHeader>
      <CardContent className="min-w-0 space-y-3">
        <p className="text-xs text-muted-foreground">{t("editorRoundtrip.help")}</p>
        <p className="text-xs font-medium">{t("editorRoundtrip.singleEditor")}</p>
        <Button
          type="button"
          className="w-full"
          variant="outline"
          disabled={!workflow.available || busy}
          onClick={() => void workflow.exportMarkdown()}
        >
          {workflow.operation === "exporting" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          {t("editorRoundtrip.export")}
        </Button>
        <div
          role="region"
          aria-label={t("editorRoundtrip.file")}
          className="space-y-2 rounded-md border border-dashed border-input p-3"
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = workflow.operation === "applying" ? "none" : "copy";
          }}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (workflow.operation === "applying") return;
            const file = event.dataTransfer.files[0];
            if (file) {
              setConfirmingEdit(null);
              void workflow.loadMarkdown(file);
            }
          }}
        >
          <label htmlFor="editor-markdown" className="text-xs font-medium">
            {t("editorRoundtrip.file")}
          </label>
          <p className="text-xs text-muted-foreground">{t("editorRoundtrip.dropHelp")}</p>
          <Input
            id="editor-markdown"
            type="file"
            accept=".md,.markdown,text/markdown"
            disabled={workflow.operation === "applying"}
            className="file:cursor-pointer file:text-foreground"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              setConfirmingEdit(null);
              if (file) void workflow.loadMarkdown(file);
            }}
          />
          {!inWorkspace && (
            <Button
              type="button"
              variant="outline"
              className="w-full whitespace-normal"
              disabled={!onChooseInTab || busy}
              onClick={() => void onChooseInTab?.()}
            >
              <PanelsTopLeft className="h-4 w-4 shrink-0" />
              {t("editorRoundtrip.chooseInTab")}
            </Button>
          )}
          <p className="text-[11px] text-muted-foreground">
            {t(inWorkspace ? "editorRoundtrip.inWorkspace" : "editorRoundtrip.fileTabHelp")}
          </p>
        </div>
        {workflow.edit && (
          <div className="min-w-0 space-y-1 text-xs">
            <p className="break-words font-medium">{workflow.edit.fileName}</p>
            {workflow.edit.result.status === "ready" && (
              <details>
                <summary className="cursor-pointer text-muted-foreground">
                  {t("editorRoundtrip.changes", { count: changes.length })}
                </summary>
                <div className="mt-2 space-y-2">
                  {changes.map((change) => (
                    <div key={change.blockId} className="min-w-0 rounded border p-2">
                      <div className="text-muted-foreground">{change.blockId}</div>
                      <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words text-destructive">
                        <del>{change.before}</del>
                      </pre>
                      <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words">
                        <ins>{change.after}</ins>
                      </pre>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
        <Button
          type="button"
          variant="accent"
          className="w-full"
          disabled={!workflow.canApply || confirming}
          onClick={() => setConfirmingEdit(workflow.edit)}
        >
          {workflow.operation === "applying" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Upload className="h-4 w-4" />
          )}
          {t("editorRoundtrip.apply")}
        </Button>
        {confirming && confirmingEdit && (
          <div
            role="group"
            aria-label={t("editorRoundtrip.confirmTitle")}
            className="space-y-3 rounded-md border border-primary/40 bg-primary/5 p-3"
          >
            <p className="text-xs">
              {t("editorRoundtrip.confirm", { title: confirmingEdit.package.snapshot.title })}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="accent"
                onClick={() => {
                  setConfirmingEdit(null);
                  void workflow.apply();
                }}
              >
                {t("editorRoundtrip.confirmApply")}
              </Button>
              <Button type="button" variant="outline" onClick={() => setConfirmingEdit(null)}>
                {t("editorRoundtrip.cancel")}
              </Button>
            </div>
          </div>
        )}
        {workflow.notice && (
          <p role="status" className="break-words text-xs">
            {t(`editorRoundtrip.${workflow.notice}`)}
          </p>
        )}
        {workflow.error && (
          <p role="alert" className="break-words text-xs text-destructive">
            {workflow.error}
          </p>
        )}
        {!workflow.available && (
          <p className="text-xs text-muted-foreground">{t("editorRoundtrip.targetRequired")}</p>
        )}
        <p className="text-[11px] text-muted-foreground">{t("editorRoundtrip.saveHelp")}</p>
      </CardContent>
    </Card>
  );
}
