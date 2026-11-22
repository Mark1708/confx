import type { CurrentTabInfo } from "../hooks/useCurrentTab";
import { useExtractJob } from "../hooks/useExtractJob";
import { useI18n } from "../hooks/useI18n";
import { TabAccessNotice } from "./TabAccessNotice";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { useWorkspace } from "../workspace/WorkspaceProvider";

export function JiraPanel({ tab }: { tab: CurrentTabInfo }) {
  const { draft, patchDraft } = useWorkspace();
  const { draftLocked } = useExtractJob();
  const { t } = useI18n();
  const searchScope = draft.scope === "search";

  return (
    <div className="min-w-0 space-y-3">
      <h2 className="text-sm font-semibold">
        {t(searchScope ? "jira.searchTitle" : "jira.title")}
      </h2>
      <TabAccessNotice
        accessState={tab.accessState}
        accessOrigin={tab.accessOrigin}
        grantStatus={tab.grantStatus}
        onGrantAccess={tab.grantAccess}
        onRetry={tab.retry}
      />
      <p className="text-xs text-muted-foreground">{t("composer.jiraLimit")}</p>

      {searchScope ? (
        <div className="space-y-1">
          <Label htmlFor="jira-jql">{t("jira.jql")}</Label>
          <Input
            id="jira-jql"
            value={draft.jira.jql}
            disabled={draftLocked}
            onChange={(event) => patchDraft({ jira: { ...draft.jira, jql: event.target.value } })}
            placeholder={t("jira.jqlPlaceholder")}
          />
        </div>
      ) : tab.isJira && tab.issueKey ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium">{t("jira.currentIssue")}</CardTitle>
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
      ) : (
        <Card>
          <CardContent className="p-3 text-xs text-muted-foreground">
            {t("jira.openIssue")}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
