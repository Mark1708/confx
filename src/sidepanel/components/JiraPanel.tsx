import { Download, Search } from "lucide-react";
import { useState } from "react";
import type { CurrentTabInfo } from "../hooks/useCurrentTab";
import { useExtractJob } from "../hooks/useExtractJob";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { JobStatus } from "./JobStatus";

export function JiraPanel({ tab }: { tab: CurrentTabInfo }) {
  const { state, run, cancel } = useExtractJob();
  const [jqlValue, setJqlValue] = useState("");

  const isRunning = state?.status === "running";
  const canExtractIssue = Boolean(tab.isJira && tab.issueKey && tab.host && !isRunning);
  const jql = jqlValue.trim();
  const canExtractSearch = Boolean(jql && tab.host && !isRunning);

  const handleExtractIssue = () => {
    if (!tab.issueKey || !tab.host) return;
    run({ kind: "extract-jira-issue", issueKey: tab.issueKey, host: tab.host });
  };

  const handleExtractSearch = () => {
    if (!jql || !tab.host) return;
    run({ kind: "extract-jira-search", jql, host: tab.host });
  };

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Jira-тикет</h2>
      </div>

      {tab.isJira && tab.issueKey ? (
        <>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium">Текущий тикет</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="min-w-0 space-y-1 text-sm">
                <div className="break-all font-mono font-medium">{tab.issueKey}</div>
                {tab.host && (
                  <div className="break-all text-xs text-muted-foreground">{tab.host}</div>
                )}
              </div>
            </CardContent>
          </Card>

          <Input
            value={jqlValue}
            onChange={(event) => setJqlValue(event.target.value)}
            placeholder="JQL-запрос (необязательно)"
          />

          <Button className="w-full" disabled={!canExtractIssue} onClick={handleExtractIssue}>
            <Download className="h-4 w-4" />
            Извлечь тикет
          </Button>

          {jql && (
            <Button
              variant="outline"
              className="w-full"
              disabled={!canExtractSearch}
              onClick={handleExtractSearch}
            >
              <Search className="h-4 w-4" />
              Извлечь по JQL
            </Button>
          )}
        </>
      ) : (
        <Card>
          <CardContent className="p-3 text-xs text-muted-foreground">
            Откройте Jira-тикет
          </CardContent>
        </Card>
      )}

      <JobStatus state={state} onCancel={cancel} />
    </div>
  );
}
