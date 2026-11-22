import { describe, expect, it } from "vitest";
import { prepareExport } from "@/lib/export/prepare";
import { applyRules } from "@/lib/rule-engine";
import { migrateSettings } from "@/lib/settings";

describe("prepared export rule isolation", () => {
  it("keeps extraction policy fixed when a settings editor changes its live rule objects", () => {
    const settings = migrateSettings({
      version: 4,
      activePresetId: "md-only",
      customRules: [
        {
          id: "lorem-private",
          name: "Private section",
          type: "selector",
          matcher: ".private",
          action: "skip",
          enabled: true,
        },
      ],
    });
    const source = {
      tabId: 7,
      windowId: 3,
      product: "confluence" as const,
      baseUrl: "https://wiki.example.com/wiki",
      pageUrl: "https://wiki.example.com/wiki/pages/1000",
      pageId: "1000",
    };
    const prepared = prepareExport(
      source,
      {
        kind: "extract-page",
        pageId: "1000",
        host: source.baseUrl,
        presetId: "md-only",
      },
      settings,
    );
    settings.customRules[0].matcher = ".public";
    settings.customRules.splice(0);
    const result = applyRules(
      '<p class="private">Lorem hidden</p><p class="public">Lorem public</p>',
      prepared.effectiveRules,
    );
    expect(result.mainHtml).toContain("Lorem public");
    expect(result.mainHtml).not.toContain("Lorem hidden");
  });
});
