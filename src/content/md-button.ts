import { createFloatingButton } from "./floating-button";

const { init: initMdButton } = createFloatingButton({
  btnId: "cx-open-md-btn",
  pageKind: "confluence",
  settingsKey: "showConfluenceButton",
  buildPayload: (context) => ({
    kind: "open-confx",
    source: "confluence",
    host: context.host,
    pageId: context.pageId,
    title: context.title,
  }),
  logPrefix: "[cx] failed to load settings for Confluence button",
});

export { initMdButton };
