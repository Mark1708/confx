import type { RuDictionary } from "@/i18n/ru";
import type { DictionaryShape } from "@/i18n/types";

export const en = {
  common: {
    appName: "ConfX",
    language: "Language",
  },
  sourceBase: {
    invalidUrl:
      "The configured Confluence URL is not a valid HTTP(S) URL. The detected source is used.",
    crossOrigin:
      "The configured Confluence URL belongs to another origin. The detected source is used.",
    pathMismatch:
      "The configured Confluence URL does not match this page's path. The detected source is used.",
    sourceUnavailable:
      "The source tab is unavailable. Open an accessible source page before exporting.",
  },
  sidepanel: {
    sections: {
      export: "Export",
      edit: "Update page",
      watch: "Watch",
    },
    scopes: {
      page: "Page",
      subtree: "Subtree",
      space: "Space",
      fragment: "Fragment",
      issue: "Issue",
      search: "Search",
    },
    destination: {
      label: "Destination",
      downloadZip: "Download ZIP",
      directory: "New folder",
      streamedZip: "ZIP to disk",
      workspaceNote:
        "Folder and disk exports continue in a normal workspace tab. Choose the destination here, then continue there.",
      reasons: {
        insecureContext: "The browser blocks file system access on this page.",
        apiUnavailable: "This browser does not provide the File System Access API.",
        surfaceRestricted: "Open the workspace tab to use this destination.",
      },
    },
    header: {
      openJiraTicket: "Open a Jira issue",
      openConfluencePage: "Open a Confluence page",
      settings: "Settings",
      openWorkspace: "Open workspace tab",
      primarySection: "Primary section",
      sectionPanel: "Section panel",
    },
    tree: {
      loadingRoot: "Loading root…",
      noLoadedChildren: "No loaded child pages",
      expand: "Expand “{{title}}”",
      collapse: "Collapse “{{title}}”",
      filterExpanded:
        "Expanded to show matching pages. Clear the filter to restore manual expansion.",
    },
  },
  composer: {
    what: "What to export",
    scope: "Export scope",
    package: "Package contents",
    where: "Where to save",
    summary: "Export summary",
    source: "Source",
    conversion: "Conversion and rules",
    start: "Start export",
    continueWorkspace: "Continue in workspace tab",
    choosingDestination: "Choosing destination…",
    workspaceHelp:
      "Multipage and disk exports run in a normal tab pinned to this source. Continue there, review the restored draft, and start the export. No live job is transferred.",
    snapshotHelp: "Starting captures the source, package, rules and network options for this run.",
    selectionRequired: "Choose an available source selection before starting.",
    locked:
      "This source's export root, package and destination are locked for the live job. You can browse other scopes without changing the running export.",
    scopeUnavailable:
      "This scope is unavailable for the current source. Your selection is retained; choose another scope explicitly.",
    selectedRoot: "Export root: {{title}}",
    rootHelp:
      "Selecting a node changes the export root, not the source tab. Use its separate Open button to navigate. Export discovers all descendants; this search filters the tree view only.",
    loadedPages:
      "{{count}} pages currently loaded. The complete subtree is discovered when export starts.",
    discoveredPages:
      "{{count}} pages in the cached subtree. The source is checked again when export starts.",
    noSources: "No HTTP(S) source tabs found. Open a source page, then list tabs again.",
    tablesSummary: "CSV + per-page index.md listing the written CSV files",
    jiraTablesSummary:
      "Issue metadata CSV + a service Markdown index; no descriptions or resources",
    editableHelp:
      "editable.md belongs to one full Confluence page. Each file can update only its matching open editor, never publish a batch.",
    filteredEditable:
      "Editable sidecars are unavailable while active rules remove content. The original source must not disclose excluded content.",
    rulesSummary:
      "{{base}} base rules + {{custom}} custom rules. The rules editor and JSON import/export are in Settings.",
    fragmentHelp: "Exports the selected HTML, without an editable sidecar or reversible import.",
    fragmentPackage:
      "HTML fragments use the available images and conversion rules, without page attachments, comments or history. Links to other pages stay online.",
    jiraPackage:
      "Jira supports description, comments and attachments. Editable sidecars, image extraction, PlantUML companions and version history are unavailable. Issue links stay online; HTML rules do not change Jira fields.",
    jiraLimit:
      "Jira export is read-only. Search exports at most 50 issues in the current release; issue-body import is not supported.",
    changePackage: "Change package and destination in Export",
    watchWorkspaceHelp:
      "Continue in a workspace tab, open Watch and export the retained selection there. Package and destination are shared with Export.",
    pinnedSource: "Pinned source · workspace tab",
    currentSource: "Current source · panel",
    htmlSource: "HTML page",
    accessReady: "Read access available",
    accessUnavailable: "Source access unavailable",
    sourceMoved:
      "The source tab navigated. Its page card is refreshed; saved scopes and roots are not replaced. Loaded editor files are cleared when page identity changes.",
    chooseSourceHelp:
      "This workspace has no accessible pinned source. Choose a source explicitly; switching the active browser tab never binds it automatically.",
    listSources: "List open source tabs",
    chooseSource: "Choose a source tab",
    useSource: "Open workspace for this source",
    destinations: {
      downloadDescription:
        "The browser Save dialog opens after packing. Ready means the browser download completed. Compressed output remains in memory until handoff.",
      directoryDescription:
        "Choose a parent before exporting. Writes a fresh named folder with a job UUID; existing export folders are never overwritten.",
      streamedDescription:
        "Choose a parent folder before exporting. Creates a new <safe-actual-package-root>-<job-UUID>.zip; existing files are never overwritten. Ready only after the file closes. Cancellation may leave the new ZIP incomplete.",
    },
  },
  launcher: {
    title: "Page launcher",
    description:
      "Choose where the page launcher appears. The toolbar and workspace tab remain available when it is hidden.",
    help: "Drag to move. Enter opens ConfX; Shift+F10 opens the menu; Esc closes it.",
    menuLabel: "Launcher menu",
    hideUntilReload: "Hide until tab reload",
    hideOnSite: "Hide on this site",
    resetPosition: "Reset position",
    siteOverrides: "Local site overrides",
    localOnly:
      "Site visibility and positions stay on this device, outside sync. A tab-only hide lasts until that tab reloads.",
    noSites: "No site overrides saved.",
    hidden: "Hidden on this site",
    visible: "Visible when enabled above",
    restoreSite: "Restore launcher",
    resetSite: "Reset site settings",
    loading: "Loading site settings…",
    loadFailed: "Could not load launcher settings.",
    saveFailed: "Could not save launcher settings. Your previous settings are unchanged.",
  },
  editorRoundtrip: {
    title: "Edit locally in Markdown",
    help: "Edit editable.md from a page, tree or space export, or export the open editor below. Load the edited file here and keep the hidden Confx comments.",
    export: "Export editable MD",
    file: "Edited MD file",
    dropHelp:
      "Drop one MD file here or choose it below. Drag and drop does not need a system file dialog.",
    apply: "Apply to editor",
    changes: "Changed blocks: {{count}} — show changes",
    confirm:
      "Apply this file's changes to the open editor for “{{title}}”? Confluence may autosave the draft. The page will not be published automatically.",
    confirmTitle: "Confirm applying changes",
    confirmApply: "Confirm changes",
    cancel: "Cancel",
    exported: "MD exported. Edit this file in your IDE and load it here when ready.",
    unchanged: "No new changes to apply. The editor was not modified.",
    updated:
      "Changes applied to the editor. Use the page's normal Save / Update button to publish them.",
    saveHelp:
      "Loading a file never changes the page. Applying changes uses one undo step; Confluence may autosave the draft. Publication stays under your control.",
    openEditor: "Open this page in edit mode first, then try again.",
    targetRequired:
      "You can choose a file now. To apply it, open the matching page's editor and grant the extension access to the site.",
    wrongPage: "This file belongs to another page or site. Open the page it was exported from.",
    conflict:
      "The page version or open editor changed since export. Nothing was applied. Export the current content again to avoid overwriting newer changes.",
    unavailable:
      "The page editor is unavailable or still loading. Wait for the editor and try again.",
    failed:
      "The editor could not confirm the update. Inspect its current content before trying again.",
    unsupported: "These edits cannot be applied safely. Nothing was applied.",
    conversionLoss:
      "Confluence could not preserve the complete source when converting it for the editor. Nothing was applied. Export directly from the open editor instead.",
    tooLarge: "The MD file exceeds the 35 MiB limit.",
    chooseInTab: "Choose file in workspace tab",
    singleEditor: "One already open Confluence editor · no automatic publication",
    fileTabHelp:
      "If a Web Panel cannot open the file dialog, choose the workspace tab and select the file there. The file, diff and apply operation stay in that tab; no file is transferred through storage.",
    inWorkspace:
      "Choose or drop the file here. This normal tab keeps the workflow pinned to the source editor; opening the tab does not automatically open a file dialog.",
  },
  viewer: {
    defaultTitle: "Markdown preview",
    missingParams: "The URL does not include the host and pageId parameters.",
    kicker: "Markdown preview",
    displayMode: "Display mode",
    formatted: "Formatted",
    raw: "Source",
    copyTitle: "Copy markdown to clipboard",
    copy: "Copy",
    downloadTitle: "Download as .md",
    download: "Download",
    loading: "Loading page…",
    loadError: "Could not load the page: {{message}}",
    copied: "Copied to clipboard",
    copyFailed: "Could not copy",
    downloading: "File download started",
  },
  content: {
    openInConfx: "Open in ConfX",
  },
  tabAccess: {
    unsupportedTitle: "Unsupported browser page",
    unsupportedDescription:
      "ConfX can inspect only HTTP and HTTPS pages. Open a Confluence or Jira page and retry.",
    hostMissingTitle: "Access required",
    hostMissingDescription: "Grant ConfX access to {{origin}} and retry the page check.",
    grant: "Grant access and retry",
    grantDeclined: "Access was not granted. The current tab remains unchanged.",
    grantFailed: "Could not request access. Retry from this tab.",
    probeFailedTitle: "Could not inspect this page",
    probeFailedDescription: "The browser rejected the page check for a non-permission reason.",
    retry: "Retry",
  },
  settings: {
    title: "Settings",
    theme: {
      label: "Theme",
      dark: "Dark",
      light: "Light",
      system: "System",
    },
    palette: {
      label: "Color palette",
      violet: "Violet",
      blue: "Blue",
      forest: "Forest",
      graphite: "Graphite",
      amber: "Amber",
    },
    appearance: {
      saveError: "Could not save your appearance choice. Please try again.",
    },
    language: {
      label: "Language",
      auto: "Auto",
      ru: "Русский",
      en: "English",
    },
    fontSize: {
      label: "Font size",
      description: "Scales the whole interface. {{min}}–{{max}}px.",
      decrease: "Decrease font size",
      increase: "Increase font size",
      reset: "Reset",
      resetTitle: "Reset to default value",
    },
    toggles: {
      frontMatter: {
        label: "Front-matter YAML",
        description: "Adds metadata (title, id, url, labels) to the beginning of each .md file",
      },
      rewriteInternalLinks: {
        label: "Rewrite internal links",
        description: "Links to pages from the same export become relative paths",
      },
      deduplicateImages: {
        label: "Deduplicate images and attachments",
        description: "Identical images and file attachments (by SHA-256) are saved once",
      },
      showConfluenceButton: {
        label: "Show button on Confluence pages",
        description: "Adds the floating “Open in ConfX” button when a Confluence page is detected.",
      },
      showJiraButton: {
        label: "Show button on Jira pages",
        description: "Adds the floating “Open in ConfX” button when a Jira issue is detected.",
      },
    },
    diagnostics: {
      title: "Current tab diagnostics",
      description: "Privacy-safe detection details for the active tab.",
      empty: "Open a Confluence or Jira page to see diagnostics.",
      kind: "Detected kind",
      host: "Host",
      pageId: "Page ID",
      issueKey: "Issue key",
      source: "Detection source",
      reason: "Detection reason",
      confluenceButton: "Confluence button",
      jiraButton: "Jira button",
      enabled: "enabled",
      disabled: "disabled",
      visible: "visible",
      hidden: "hidden",
      none: "—",
      access: "Page access",
      accessOrigin: "Current origin",
      accessStates: {
        available: "Available",
        unsupportedUrl: "Unsupported URL",
        hostAccessMissing: "Host access missing",
        injectionFailed: "Page check failed",
      },
      kinds: {
        confluence: "Confluence",
        jira: "Jira",
        unknown: "Unknown",
      },
      sources: {
        meta: "Metadata",
        url: "URL",
        none: "None",
      },
    },
    concurrency: "Tree discovery concurrency",
    ruleEditor: "Rule editor",
  },
  page: {
    title: "Current page",
    available: "available",
    extract: "Extract page",
    subscriptionActive: "Subscription active",
    subscribeChanges: "Subscribe to changes",
    card: {
      loading: "Getting page information…",
      readError: "Could not read the page",
      emptyTitle: "Open a Confluence page",
      emptyDescription: "ConfX enables export when the current tab contains a Confluence page.",
      childrenCount: "{{count}} children",
      attachmentsCount: "{{count}} attachments",
    },
  },
  space: {
    title: "Space",
    estimateError: "Could not determine the space for export estimation",
    detecting: "Detecting space…",
    key: "Space key",
    openPageHint: "Open a Confluence page to detect the space",
    labelFilter: "Label filter",
    labelPlaceholder: "for example: public",
    prefixFilter: "Title prefix",
    prefixPlaceholder: "for example: API",
    estimating: "Estimating export size…",
    estimateUnavailable: "Export size is not available.",
    pagesCount: "Pages to export: {{count}}",
    export: "Export space",
  },
  subtree: {
    title: "Page tree",
    resetCacheTitle: "Reset tree cache for this host",
    filterPlaceholder: "Filter by title…",
    clearFilterTitle: "Clear filter",
    searchingServer: "Searching on server…",
    noResults: "Nothing found",
    unavailableTitle: "Tree unavailable",
    unavailableDescription:
      "Open a Confluence page to build the subtree and choose the export root.",
    preset: "Preset",
    extractNamed: "Extract section “{{title}}” with all nested pages",
    extractDefault: "Extract section with all nested pages",
    subscriptionActive: "Subscription active",
    subscribeNamed: "Subscribe to “{{title}}”",
    subscribeDefault: "Subscribe to subtree",
    openPage: "Open “{{title}}” in the source tab",
  },
  picker: {
    title: "Block picker",
    helpStart: "Click “Start picker”, then choose a block on the page. Use",
    helpLevels: "to change the selection level,",
    helpCancel: "— cancel.",
    launch: "Start picker on page",
    emptyTitle: "No block selected yet",
    emptyDescription:
      "Start the picker and click the desired page area. After selection, a preview and export button will appear here.",
    noActiveTab: "No active tab to start the picker.",
    selectedTitle: "Selected block",
    ready: "ready",
    selectedDescription: "Only the selected fragment can be exported.",
    extract: "Extract block",
    clearSelection: "Clear selected fragment",
    overlay: {
      tablesShort: "{{count}} tables",
      imagesShort: "{{count}} images",
      wordsApprox: "~{{count}} words",
      empty: "empty",
      hint: "[ / ] level · Esc cancel · click — select",
    },
  },
  jira: {
    title: "Jira issue",
    searchTitle: "Jira search",
    jql: "JQL query",
    currentIssue: "Current issue",
    jqlPlaceholder: "JQL query",
    extractIssue: "Extract issue",
    extractJql: "Extract by JQL",
    openIssue: "Open a Jira issue",
  },
  watch: {
    title: "Subscriptions",
    loading: "Loading subscriptions…",
    emptyTitle: "No active subscriptions",
    emptyDescriptionStart: "In Export, choose",
    emptyDescriptionMiddle: "or",
    emptyDescriptionEnd: "and click “Subscribe” to track changes.",
    hasChanges: "There are changes since the last check",
    noPendingChanges: "No pending changes",
    scopeSubtree: "subtree",
    scopePage: "page",
    pagesShort: "{{count}} pages",
    changesCount: "+{{count}} changes",
    upToDate: "up to date",
    never: "never",
    check: "Check",
    deleteTitle: "Delete subscription",
    created: "Created: {{date}}",
    lastCheck: "Last check: +{{added}} / −{{removed}} / ~{{changed}} / ⇄{{moved}}",
    noChanges: "No changes.",
    diffTitle: "What changed",
    accept: "Accept",
    close: "Close",
    added: "Added",
    changed: "Changed",
    moved: "Moved",
    removed: "Removed",
    exportChanged: "Export changed pages ({{count}})",
    historyTitle: "Check history",
    historyEmpty: "No checks yet.",
    historyEntry: "{{date}}: +{{added}} / −{{removed}} / ~{{changed}} / ⇄{{moved}}",
    sourceMismatch:
      "To check or export this subscription, switch to a Confluence source at {{host}}. The subscription has not been retargeted to the current source.",
    recheckToAccept: "Check this subscription again before accepting the saved changes.",
  },
  jobs: {
    pendingTitle: "Export is preparing",
    runningTitle: "Export is running",
    completedTitle: "Export ready",
    partialTitle: "Export is incomplete",
    partialDescription:
      "Some content could not be exported. Review the failures before relying on the result.",
    failedTitle: "Export did not finish",
    cancelledTitle: "Export cancelled",
    cancelledDescription: "You can start the export again.",
    interruptedTitle: "Export interrupted",
    interruptedDescription:
      "No live owner was found. This export cannot be resumed. Start a new export.",
    foreignOwner: "This export is controlled in {{surface}}. Cancel it there.",
    focusOwner: "Go to job",
    cancel: "Cancel",
    cancelRequested: "Cancellation requested. Waiting for the current operation to stop.",
    cancelSaveDialog:
      "If a Save dialog is still open in the owning view, close it to finish cancelling. The browser does not let ConfX close it automatically.",
    progress: "Export progress",
    step: "Processed: {{current}} / {{total}}",
    successfulPages: "Successful pages",
    failedPages: "Failed pages",
    successfulResources: "Successful resources",
    failedResources: "Failed resources",
    entriesWritten: "Files written",
    bytesWritten: "Bytes written",
    savedBadge: "saved",
    file: "File:",
    directory: "Folder:",
    reasons: {
      permissionDenied:
        "Access to the selected folder or file was denied. Choose a different destination.",
      writerFailure:
        "Writing to the destination failed. The unfinished result was left in place and is not a complete export.",
      zipLimitExceeded:
        "The export exceeds the conservative ZIP32 limits (65,534 entries or 0xfffffffe bytes). Export fewer pages or use the folder destination.",
      destinationCollision:
        "A file or folder with this export name already exists. Nothing was written, reused or overwritten; choose another parent folder.",
    },
    ownerSurfaces: {
      panel: "the side panel",
      popup: "the popup",
      workspace: "the workspace tab",
      unknown: "another view",
    },
    phases: {
      discovering: "Discovering pages",
      reading: "Reading content",
      writing: "Writing files",
      finalizing: "Finalizing the archive",
      downloading: "Saving the download",
    },
  },
  presets: {
    label: "Template",
    runOptions: "Options for this export",
    runOptionsDescription:
      "These changes affect only this draft. Save as defaults only when you want to use them for future exports.",
    saveDefaults: "Save as defaults",
    savingDefaults: "Saving defaults…",
    names: {
      mdAttachments: "Markdown + attachments",
      mdOnly: "Markdown only",
      tablesOnly: "CSV tables only",
    },
    descriptions: {
      mdAttachments:
        "Creates Markdown pages, keeps tables in Markdown and permits the selected local images, attachments and companions.",
      mdOnly:
        "Creates Markdown pages with tables kept in Markdown. Images and files are not downloaded.",
      tablesOnly:
        "Creates CSV files for user tables and a per-page index listing the CSV files. Editable files, resources, comments, and history are omitted.",
    },
    ruleNames: {
      allTablesCsv: "Tables → CSV",
      navigationChromeSkip: "Navigation UI → exclude",
      tablesOnlyAllCsv: "Tables → CSV",
      tablesOnlyContentSkip: "Non-table content → exclude",
      apiEndpointTablesCsv: "Endpoint tables → CSV",
      apiCodeBlocksKeepHtml: "Code blocks → keep HTML",
    },
  },
  export: {
    progress: {
      fetchingPage: "Fetching page…",
      processingBlock: "Processing block…",
      walkingTree: "Walking page tree…",
      foundPage: "Found: {{title}} (level {{depth}})",
      extractingPage: "Extracting: {{title}}",
      buildingArchive: "Building archive…",
      fetchingSpaceInfo: "Fetching space information…",
      fetchingIssue: "Fetching issue {{issueKey}}",
      fetchingJiraIssue: "Fetching issue…",
      searchingJiraIssues: "Searching issues…",
      extractingJiraIssue: "Extracting issue: {{issueKey}}",
    },
    readme: {
      generatedBy: "Exported by ConfX.",
    },
  },
  watchProgress: {
    walking: "Walking…",
    checking: "Checking: {{title}}",
    done: "Done",
  },
  errors: {
    unknown: "Unknown error",
    missingTranslation: "Missing translation: {{key}}",
  },
  options: {
    sections: {
      defaults: "Export defaults",
      appearance: "Appearance and language",
      appearanceDescription: "These preferences update all open ConfX surfaces.",
      advanced: "Advanced: network and rules",
      advancedDescription:
        "Network limits, same-origin Confluence base override, executable rules and rules JSON. Existing export runs keep their captured settings.",
      diagnostics: "Diagnostics",
      loading: "Loading settings…",
    },
    diagnostics: {
      description:
        "Export a local support report only when you choose to. Review its visible composition below.",
      includes:
        "Includes extension and manifest versions, the options surface, secure-context and browser API capabilities, and the last export's status, phase and allowlisted reason code.",
      excludes:
        "Excludes page bodies, source URLs and IDs, titles, filenames, files, rules, settings payloads, headers, credentials and raw error messages.",
      export: "Export safe diagnostics",
      preview: "View the exported report",
      failed: "Could not collect or export diagnostics. No report was downloaded.",
    },
    nav: {
      preset: "Preset",
      presetDescription: "Base strategy",
      rules: "Rules",
      rulesDescription: "Custom layer",
      general: "General",
      generalDescription: "Export behavior",
      export: "Export",
      exportDescription: "API and limits",
    },
    importErrors: {
      invalidFormat: "Invalid rules file format",
      missingPreset: "Rules file does not specify a preset",
      unknownPreset: "Unknown preset: {{presetId}}",
      invalidCustomRules: "File contains invalid custom rules",
      textJsonRequired: "Rules file must be a text JSON file",
      importFailed: "Could not import rules",
      readFailed: "Could not read rules file",
    },
    feedback: {
      ready: "Ready to import or export rules JSON.",
      exportStarted: "Rules export started. The JSON will be saved to browser downloads.",
      imported: "Imported rules: {{count}}. Active preset: {{preset}}.",
    },
    sidebar: {
      aria: "Settings navigation",
      kicker: "ConfX console",
      title: "Export rules",
      customRulesSummary: "custom rules on top of the preset",
    },
    hero: {
      eyebrow: "ConfX rules panel",
      title: "ConfX — extraction settings",
      description:
        "Rules are applied to page HTML before Markdown conversion. This page saves defaults for future exports; one-off export options do not change them.",
      statusAria: "Current configuration",
      preset: "Preset",
      customRulesCount: "{{count}} custom rules",
    },
    preset: {
      title: "Default template",
      description:
        "Choosing a template here saves its rules and package defaults for future exports.",
      noRules: "The preset does not add rules automatically.",
    },
    rules: {
      type: "Rule type",
      action: "Rule action",
      title: "Custom rules",
      description: "Applied on top of the preset. Order: top rules run earlier.",
      empty: "No rules yet. Add a matcher below.",
      newRule: "New rule",
      newRuleDescription: "Matcher can be a CSS selector or a section title regex.",
      matcherPlaceholder: "matcher (CSS / regex)",
      add: "Add",
      importExport: "Import and export rules",
      importExportDescription: "JSON contains the active preset and all custom rules.",
      export: "Export rules",
      import: "Import rules",
      enabled: "On",
      disabled: "Off",
      namePlaceholder: "Name",
      sectionMatcherPlaceholder: "section title regex (for example: API\\s+component)",
      cssMatcherPlaceholder: "CSS selector (for example: table.confluenceTable)",
      deleteAria: "Delete rule",
      defaultName: "New rule",
    },
    package: {
      editable: "Editable Markdown sidecar",
      images: "Images",
      attachments: "File attachments",
      plantUmlAssets: "PlantUML assets",
      comments: "Page comments",
      history: "Version history",
      resourcesDisabled:
        "This template omits images, attachments, and PlantUML assets. Inactive preferences are retained.",
      tablesOnlyDisabled:
        "CSV-only exports omit page Markdown, editable files, resources, comments, and history. Each page still receives an index of its CSV files. Inactive preferences are retained.",
      editableUnavailable:
        "Editable sidecars are available only for complete Confluence pages, not Jira issues or selected fragments.",
    },
    general: {
      title: "General settings",
      description: "What to include in the archive and Markdown",
      frontMatter: "Front-matter YAML in each .md",
      rewriteInternalLinks: "Rewrite internal links",
      deduplicateImages: "Deduplicate images and attachments",
      concurrency: "Tree discovery concurrency",
      maxDepth: "Subtree depth limit (0 — root only)",
      unlimitedDepth: "Unlimited",
      advanced: "Advanced source URL",
      confluenceBaseUrl: "Confluence base URL override",
      confluenceBaseUrlDescription:
        "Optional same-origin context path, such as /wiki or /confluence. An invalid, different-origin, or mismatched path is ignored with a warning. Running exports keep their prepared source.",
    },
    exportSettings: {
      title: "Export settings",
      description: "Limits for Confluence API requests",
      maxRetries: "Maximum retries",
      requestTimeout: "Request timeout (sec.)",
      maxConcurrency: "HTTP request concurrency",
    },
  },
} as const satisfies DictionaryShape<RuDictionary>;
