import { createFloatingButton } from "./floating-button";

const { init: initJiraButton } = createFloatingButton({
  btnId: "cx-jira-export-btn",
  pageKind: "jira",
  settingsKey: "showJiraButton",
  buildPayload: (context) => ({
    kind: "open-confx",
    source: "jira",
    host: context.host,
    issueKey: context.issueKey,
    title: context.title,
  }),
  logPrefix: "[cx] failed to load settings for Jira button",
});

export { initJiraButton };
