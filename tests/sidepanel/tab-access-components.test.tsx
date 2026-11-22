import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "@/lib/settings";
import { PageCard } from "@/sidepanel/components/PageCard";
import { PickerPanel } from "@/sidepanel/components/PickerPanel";
import type { CurrentTabInfo } from "@/sidepanel/hooks/useCurrentTab";

vi.mock("@/sidepanel/hooks/useI18n", () => ({
  useI18n: () => ({
    locale: "en",
    t: (key: string, values?: Record<string, string>) => {
      const messages: Record<string, string> = {
        "tabAccess.unsupportedTitle": "Unsupported browser page",
        "tabAccess.unsupportedDescription": "Open an HTTP or HTTPS page.",
        "tabAccess.hostMissingTitle": "Access required",
        "tabAccess.hostMissingDescription": `Grant access to ${values?.origin ?? "origin"}.`,
        "tabAccess.grant": "Grant access and retry",
        "tabAccess.grantDeclined": "Access was not granted.",
        "tabAccess.grantFailed": "Could not request access.",
        "tabAccess.probeFailedTitle": "Could not inspect this page",
        "tabAccess.probeFailedDescription": "Retry the safe page check.",
        "tabAccess.retry": "Retry",
        "settings.diagnostics.access": "Page access",
        "settings.diagnostics.accessStates.available": "Available",
        "settings.diagnostics.accessStates.unsupportedUrl": "Unsupported URL",
        "settings.diagnostics.accessStates.hostAccessMissing": "Host access missing",
        "settings.diagnostics.accessStates.injectionFailed": "Injection failed",
        "picker.title": "Block picker",
        "picker.helpStart": "Start help",
        "picker.helpLevels": "levels",
        "picker.helpCancel": "cancel",
        "picker.launch": "Start picker on page",
        "picker.emptyTitle": "No block selected",
        "picker.emptyDescription": "Pick a block",
        "preset.label": "Preset",
        "settings.title": "Settings",
      };
      return messages[key] ?? key;
    },
  }),
}));

vi.mock("@/sidepanel/hooks/useSettings", () => ({
  useSettings: () => ({
    data: {
      ...DEFAULT_SETTINGS,
      locale: "en",
      theme: "light",
      fontSize: 14,
      concurrency: 2,
    },
    update: vi.fn(),
  }),
}));

vi.mock("@/sidepanel/hooks/useExtractJob", () => ({
  useExtractJob: () => ({
    state: null,
    run: vi.fn(),
    cancel: vi.fn(),
    busy: false,
    ownsJob: false,
    draftLocked: false,
    defaults: DEFAULT_SETTINGS.exportDefaults,
    setDefaults: vi.fn(),
    saveDefaults: vi.fn().mockResolvedValue(undefined),
    savingDefaults: false,
    defaultsError: null,
  }),
}));

vi.mock("@/sidepanel/hooks/usePickerBridge", () => ({
  usePickerBridge: () => ({ pickedBlock: null, clear: vi.fn() }),
}));

describe("tab access recovery components", () => {
  it("PageCard distinguishes unsupported and grantable pages", () => {
    const unsupported = renderToStaticMarkup(
      <PageCard
        loading={false}
        accessState="unsupported-url"
        accessOrigin={undefined}
        grantStatus="idle"
        onGrantAccess={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    const missing = renderToStaticMarkup(
      <PageCard
        loading={false}
        accessState="host-access-missing"
        accessOrigin="https://wiki.example.com"
        grantStatus="idle"
        onGrantAccess={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(unsupported).toContain("Unsupported browser page");
    expect(unsupported).not.toContain("page.card.emptyTitle");
    expect(missing).toContain("https://wiki.example.com");
    expect(missing).toContain("Grant access and retry");
  });

  it("PickerPanel disables launch and renders the shared gate", () => {
    const tab = makeTab("host-access-missing", "https://wiki.example.com");
    const html = renderToStaticMarkup(<PickerPanel tab={tab} />);

    expect(html).toContain("Grant access and retry");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[^<]*<svg|<button[^>]*disabled/);
  });

});

function makeTab(
  accessState: CurrentTabInfo["accessState"],
  accessOrigin?: string,
): CurrentTabInfo {
  return {
    tabId: 7,
    url: accessOrigin ? `${accessOrigin}/wiki/pages/123` : "chrome://extensions",
    accessState,
    accessOrigin,
    originPattern: accessOrigin ? `${accessOrigin}/*` : undefined,
    grantStatus: "idle",
    retry: vi.fn(),
    grantAccess: vi.fn(),
  };
}
