import { expect, test } from "./fixtures.mjs";
import { expectReadOnlyConversions } from "./artifacts.mjs";
import { LOCAL_ORIGIN } from "./origin.mjs";

const MODES = ["light", "dark", "system"];
const PALETTES = ["violet", "blue", "forest", "graphite", "amber"];
const TOKEN_NAMES = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "muted",
  "muted-foreground",
  "primary",
  "primary-foreground",
  "ring",
];

class AppearanceUi {
  constructor(page) {
    this.page = page;
    this.root = page.locator("html");
    this.section = page.locator("#appearance");
  }

  radio(name, value) {
    return this.section.locator(`input[type="radio"][name="${name}"][value="${value}"]`);
  }

  card(name, value) {
    return this.radio(name, value).locator("..");
  }

  preview(name, value) {
    return this.card(name, value).locator("[data-confx-appearance]");
  }

  async settings() {
    return this.page.evaluate(
      async () => (await chrome.storage.sync.get("cx.settings.v1"))["cx.settings.v1"],
    );
  }

  async expectChoice(name, value) {
    const key = name === "cx-theme" ? "theme" : "palette";
    await expect(this.radio(name, value)).toBeChecked();
    await expect(this.section.locator(`input[name="${name}"]:checked`)).toHaveCount(1);
    await expect.poll(() => this.settings()).toMatchObject({ [key]: value });
    // A completed storage write alone does not mean the mutation has settled.
    await expect(this.radio("cx-theme", value === "system" ? "system" : "light")).toBeEnabled();
    await expect(this.radio("cx-palette", "violet")).toBeEnabled();
    if (key === "palette") await expect(this.root).toHaveAttribute("data-palette", value);
    if (key === "theme" && value !== "system") {
      await expect(this.root).toHaveAttribute("data-theme", value);
    }
  }

  async choose(name, value) {
    await expect(this.radio(name, value)).toBeEnabled();
    // Click the real label: the focusable native input is intentionally sr-only.
    await this.card(name, value).click();
    await this.expectChoice(name, value);
  }

  async fontSize(value) {
    const range = this.section.locator("#options-font-size");
    await range.focus();
    await range.press(value === 11 ? "Home" : "End");
    await expect(range).toHaveValue(String(value));
    await expect.poll(() => this.settings()).toMatchObject({ fontSize: value });
    await expect(this.root).toHaveCSS("font-size", `${value}px`);
    await expect(this.radio("cx-theme", "light")).toBeEnabled();
  }

  async expectPreviews(mode, palette, systemMode) {
    for (const value of MODES) {
      const preview = this.preview("cx-theme", value);
      await expect(preview).toHaveCount(1);
      await expect(preview).toHaveAttribute("data-theme", value === "system" ? systemMode : value);
      await expect(preview).toHaveAttribute("data-palette", palette);
      await expect(preview).toHaveAttribute("aria-hidden", "true");
    }
    for (const value of PALETTES) {
      const preview = this.preview("cx-palette", value);
      await expect(preview).toHaveCount(1);
      await expect(preview).toHaveAttribute("data-theme", mode === "system" ? systemMode : mode);
      await expect(preview).toHaveAttribute("data-palette", value);
      await expect(preview).toHaveAttribute("aria-hidden", "true");
    }
  }
}

async function openAppearance(lab, owner = lab.confx.page) {
  const opened = lab.context.waitForEvent("page");
  await owner.getByRole("button", { name: "Settings", exact: true }).click();
  const page = await opened;
  await expect(page).toHaveURL(/\/options\/index\.html(?:[?#]|$)/);
  await page.getByRole("link", { name: "Appearance and language", exact: true }).click();
  const appearance = new AppearanceUi(page);
  await expect(appearance.section).toBeVisible();
  for (const [name, values] of [
    ["cx-theme", MODES],
    ["cx-palette", PALETTES],
  ]) {
    const group = appearance.section.locator(`fieldset:has(input[name="${name}"])`);
    await expect(group).toHaveCount(1);
    await expect(group.locator("legend")).toHaveText(/\S/);
    await expect(group.getByRole("radio")).toHaveCount(values.length);
    expect(
      await group.getByRole("radio").evaluateAll((inputs) => inputs.map((input) => input.value)),
    ).toEqual(values);
    for (const value of values) {
      await expect(appearance.radio(name, value)).toHaveAccessibleName(/\S/);
      expect(await appearance.card(name, value).evaluate((node) => node.tagName)).toBe("LABEL");
    }
  }
  return appearance;
}

// The only added DOM is an invisible, immediately removed measurement probe.
// Colors are resolved by Chromium from the built stylesheet, not copied from the palette table.
async function readTokens(root) {
  return root.evaluate((node, names) => {
    const probe = node.ownerDocument.createElement("span");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = "all: initial; position: fixed; visibility: hidden; pointer-events: none";
    node.append(probe);
    const canvas = node.ownerDocument.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Color measurement requires the real browser canvas");
    try {
      return Object.fromEntries(
        names.map((name) => {
          if (!getComputedStyle(node).getPropertyValue(`--${name}`).trim()) {
            throw new Error(`Built appearance token --${name} is missing`);
          }
          probe.style.color = `hsl(var(--${name}))`;
          const css = getComputedStyle(probe).color;
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = css;
          context.fillRect(0, 0, 1, 1);
          return [name, { css, rgba: Array.from(context.getImageData(0, 0, 1, 1).data) }];
        }),
      );
    } finally {
      probe.remove();
    }
  }, TOKEN_NAMES);
}

function contrast(first, second) {
  const luminance = (rgba) => {
    const channels = rgba.slice(0, 3).map((value) => {
      const srgb = value / 255;
      return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const values = [luminance(first), luminance(second)].sort((a, b) => a - b);
  return (values[1] + 0.05) / (values[0] + 0.05);
}

function expectContrast(tokens, description) {
  for (const [name, token] of Object.entries(tokens)) {
    expect(token.rgba[3], `${description}: --${name} must resolve to an opaque color`).toBe(255);
  }
  for (const [foreground, background] of [
    ["foreground", "background"],
    ["card-foreground", "card"],
    ["muted-foreground", "muted"],
    ["primary-foreground", "primary"],
  ]) {
    expect(
      contrast(tokens[foreground].rgba, tokens[background].rgba),
      `${description}: --${foreground} on --${background}`,
    ).toBeGreaterThanOrEqual(4.5);
  }
  expect(
    contrast(tokens.ring.rgba, tokens.background.rgba),
    `${description}: focus ring on background`,
  ).toBeGreaterThanOrEqual(3);
}

async function expectFocusRing(appearance, name, value) {
  const radio = appearance.radio(name, value);
  await expect(radio).toBeFocused();
  const ring = await radio.evaluate((input) => {
    const decoration = input.nextElementSibling;
    if (!decoration) throw new Error("The native radio needs a visible card decoration");
    const style = getComputedStyle(decoration);
    let surrounding = decoration.parentElement;
    while (surrounding && getComputedStyle(surrounding).backgroundColor === "rgba(0, 0, 0, 0)") {
      surrounding = surrounding.parentElement;
    }
    return {
      focusVisible: input.matches(":focus-visible"),
      width: Number.parseFloat(style.outlineWidth),
      style: style.outlineStyle,
      color: style.outlineColor,
      background: surrounding ? getComputedStyle(surrounding).backgroundColor : null,
      visible:
        decoration.getBoundingClientRect().width >= 44 &&
        decoration.getBoundingClientRect().height >= 44,
    };
  });
  expect(ring.focusVisible, "Native keyboard focus must reach the actual radio").toBe(true);
  expect(
    ring.visible,
    "The focus indicator must surround the visible card, not the clipped input",
  ).toBe(true);
  expect(ring.width).toBeGreaterThanOrEqual(2);
  expect(ring.style).not.toBe("none");
  const tokens = await readTokens(appearance.root);
  expect(ring.color).toBe(tokens.ring.css);
  expect(
    contrast(tokens.ring.rgba, tokens.card.rgba),
    "The visible card focus ring has contrast",
  ).toBeGreaterThanOrEqual(3);
  return ring;
}

async function focusByTab(appearance, name, value) {
  const radio = appearance.radio(name, value);
  await radio.focus();
  await appearance.page.keyboard.press("Shift+Tab");
  await expect(radio).not.toBeFocused();
  await appearance.page.keyboard.press("Tab");
  await expect(radio).toBeFocused();
}

async function readHostAppearance(page) {
  return page.evaluate(
    (names) => ({
      attributes: Object.fromEntries(
        ["class", "style", "data-theme", "data-palette", "data-confx-appearance"].map((name) => [
          name,
          document.documentElement.getAttribute(name),
        ]),
      ),
      tokens: Object.fromEntries(
        [...names, "border", "accent", "surface", "appearance-hue"].map((name) => [
          name,
          getComputedStyle(document.documentElement).getPropertyValue(`--${name}`),
        ]),
      ),
      elements: ["html", "body", "main", "#main-content", "a"].map((selector) => {
        const node = document.querySelector(selector);
        if (!node) throw new Error(`Missing real host element ${selector}`);
        const style = getComputedStyle(node);
        return [
          selector,
          Object.fromEntries(
            [
              "color",
              "backgroundColor",
              "borderTopColor",
              "fontFamily",
              "fontSize",
              "padding",
              "margin",
            ].map((property) => [property, style[property]]),
          ),
        ];
      }),
    }),
    TOKEN_NAMES,
  );
}

async function readExportState(page, sourceTabId) {
  return page.evaluate(async (tabId) => {
    const session = await chrome.storage.session.get(null);
    const workspace = session["cx.workspace.v1"];
    return {
      draft:
        Object.values(workspace?.drafts ?? {}).find((draft) => draft.source.tabId === tabId) ??
        null,
      jobs: Object.fromEntries(
        Object.entries(session).filter(
          ([key]) => key === "cx.export.active.v2" || key.startsWith("cx.exportJob.v2:"),
        ),
      ),
      downloads: (await chrome.downloads.search({})).map((item) => ({
        id: item.id,
        state: item.state,
      })),
    };
  }, sourceTabId);
}

async function expectLiveAppearance(surfaces, modes, palette) {
  const results = {};
  const byMode = new Map();
  for (const surface of surfaces) {
    const mode = modes[surface.name];
    await expect(surface.root).toHaveAttribute("data-confx-appearance", "");
    await expect(surface.root).toHaveAttribute("data-theme", mode);
    await expect(surface.root).toHaveAttribute("data-palette", palette);
    const tokens = await readTokens(surface.root);
    expectContrast(tokens, `${surface.name}: ${mode}/${palette}`);
    if (byMode.has(mode)) {
      expect(
        tokens,
        `${surface.name} shares actual tokens with the other ${mode} surfaces`,
      ).toEqual(byMode.get(mode));
    } else {
      byMode.set(mode, tokens);
    }
    if (surface.name !== "viewer") {
      await expect(surface.primary).toHaveCSS("background-color", tokens.primary.css);
    }
    await expect(surface.primary).toHaveCSS("color", tokens["primary-foreground"].css);
    results[surface.name] = tokens;
  }
  return results;
}

for (const mode of ["light", "dark"]) {
  test(`all five ${mode} palettes use distinct computed colors, readable tokens and a reversible violet choice`, async ({
    lab,
  }) => {
    const appearance = await openAppearance(lab);
    await appearance.page.emulateMedia({ colorScheme: "light" });
    // The fixture's v4 payload omits theme; first make a real change from resolved dark.
    await appearance.choose("cx-theme", "light");
    if (mode === "light") await appearance.choose("cx-theme", "dark");
    await appearance.choose("cx-palette", "blue");
    const beforeModeChange = await appearance.settings();
    await appearance.choose("cx-theme", mode);
    await expect(appearance.radio("cx-palette", "blue")).toBeChecked();
    expect(await appearance.settings()).toEqual({ ...beforeModeChange, theme: mode });
    await appearance.choose("cx-palette", "violet");
    const originalSettings = await appearance.settings();
    const originalTokens = await readTokens(appearance.root);
    const colors = {};
    for (const palette of PALETTES) {
      await test.step(`${mode}/${palette}`, async () => {
        await appearance.choose("cx-palette", palette);
        await expect(appearance.radio("cx-theme", mode)).toBeChecked();
        expect(await appearance.settings()).toEqual({ ...originalSettings, palette });
        await expect(appearance.root).toHaveAttribute("data-theme", mode);
        await appearance.expectPreviews(mode, palette, "light");
        const tokens = await readTokens(appearance.root);
        expectContrast(tokens, `${mode}/${palette}`);
        expect(await readTokens(appearance.preview("cx-palette", palette))).toEqual(tokens);
        await expect(appearance.page.locator(".cx-options-logo")).toHaveCSS(
          "background-color",
          tokens.primary.css,
        );
        await expect(appearance.page.locator(".cx-options-logo")).toHaveCSS(
          "color",
          tokens["primary-foreground"].css,
        );
        colors[palette] = tokens;
      });
    }
    expect(new Set(Object.values(colors).map((tokens) => tokens.primary.css)).size).toBe(5);
    await appearance.choose("cx-palette", "violet");
    expect(await readTokens(appearance.root)).toEqual(originalTokens);
    expect(await appearance.settings()).toEqual(originalSettings);
    await lab.testInfo.attach(`computed-${mode}-palette-colors`, {
      body: JSON.stringify(colors, null, 2),
      contentType: "application/json",
    });
  });
}

test("native appearance radios retain keyboard focus and fit all supported widths at both font extremes", async ({
  lab,
}) => {
  const appearance = await openAppearance(lab);
  await appearance.page.emulateMedia({ colorScheme: "light" });
  await appearance.choose("cx-theme", "light");
  await appearance.choose("cx-palette", "violet");
  for (const [name, values] of [
    ["cx-theme", MODES],
    ["cx-palette", PALETTES],
  ]) {
    await focusByTab(appearance, name, values[0]);
    for (const value of [...values.slice(1), values[0]]) {
      await appearance.page.keyboard.press("ArrowRight");
      await appearance.expectChoice(name, value);
      await expectFocusRing(appearance, name, value);
    }
    await appearance.page.keyboard.press("ArrowLeft");
    await appearance.expectChoice(name, values.at(-1));
    await expectFocusRing(appearance, name, values.at(-1));
    await appearance.page.keyboard.press("ArrowRight");
    await appearance.expectChoice(name, values[0]);
  }

  const layouts = [];
  for (const fontSize of [11, 22]) {
    await appearance.fontSize(fontSize);
    for (const width of [320, 350, 600, 1120]) {
      await test.step(`${width}px viewport / ${fontSize}px font`, async () => {
        await appearance.page.setViewportSize({ width, height: 960 });
        const focus = {};
        for (const [name, values] of [
          ["cx-theme", MODES],
          ["cx-palette", PALETTES],
        ]) {
          const current = await appearance.section
            .locator(`input[name="${name}"]:checked`)
            .inputValue();
          await focusByTab(appearance, name, current);
          const next = values[(values.indexOf(current) + 1) % values.length];
          await appearance.page.keyboard.press("ArrowRight");
          await appearance.expectChoice(name, next);
          focus[name] = await expectFocusRing(appearance, name, next);
        }
        const geometry = await appearance.section.evaluate((section) => ({
          htmlOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
          sectionOverflow: section.scrollWidth - section.clientWidth,
          cards: Array.from(section.querySelectorAll('input[type="radio"]')).map((input) => {
            const label = input.closest("label");
            const box = label.getBoundingClientRect();
            return {
              name: input.name,
              value: input.value,
              left: box.left,
              right: box.right,
              width: box.width,
              height: box.height,
              overflow: label.scrollWidth - label.clientWidth,
            };
          }),
        }));
        for (const property of ["htmlOverflow", "bodyOverflow", "sectionOverflow"]) {
          expect(geometry[property], `${width}/${fontSize}: ${property}`).toBeLessThanOrEqual(1);
        }
        expect(geometry.cards).toHaveLength(8);
        for (const card of geometry.cards) {
          const description = `${width}/${fontSize}: ${card.name}/${card.value}`;
          expect(card.left, description).toBeGreaterThanOrEqual(0);
          expect(card.right, description).toBeLessThanOrEqual(width + 1);
          expect(card.width, description).toBeGreaterThanOrEqual(44);
          expect(card.height, description).toBeGreaterThanOrEqual(44);
          expect(card.overflow, `${description}: wrapped label`).toBeLessThanOrEqual(1);
        }
        layouts.push({ width, fontSize, geometry, focus });
        if (width === 320 && fontSize === 22) {
          await lab.testInfo.attach("appearance-narrow-large-font", {
            body: await appearance.section.screenshot(),
            contentType: "image/png",
          });
        }
      });
    }
  }
  await lab.testInfo.attach("appearance-layout-and-keyboard", {
    body: JSON.stringify(layouts, null, 2),
    contentType: "application/json",
  });
});

test("live UI preferences follow each page's OS only in system mode without restyling the host or resetting an export draft", async ({
  lab,
}) => {
  const opened = lab.context.waitForEvent("page");
  await lab.confx.page.getByRole("button", { name: "Open workspace tab", exact: true }).click();
  const workspace = await opened;
  await expect(workspace.locator("html")).toHaveAttribute("data-surface", "workspace");
  const workspaceUi = lab.confx.forPage(workspace);
  await expect(workspaceUi.startButton).toBeEnabled();
  await workspaceUi.selectSubtreeRoot("1700");
  const rootTitle = (await lab.detail("1700")).page.title;
  const filter = workspace.getByRole("textbox", { name: "Filter by title…", exact: true });
  await filter.fill(rootTitle);
  await workspaceUi.selectTemplate("Markdown only");
  const editable = workspace.getByRole("switch", {
    name: "Editable Markdown sidecar",
    exact: true,
  });
  await expect(editable).toHaveAttribute("aria-checked", "true");
  await editable.click();
  await expect(editable).toHaveAttribute("aria-checked", "false");

  const appearance = await openAppearance(lab, workspace);
  const viewer = await lab.context.newPage();
  const viewerUrl = new URL("/src/viewer/index.html", workspace.url());
  viewerUrl.searchParams.set("host", LOCAL_ORIGIN);
  viewerUrl.searchParams.set("pageId", "1700");
  await viewer.goto(viewerUrl.href);
  const image = viewer.getByRole("img", { name: "Lorem duplicate image", exact: true });
  await expect(image).toHaveAttribute("src", `${LOCAL_ORIGIN}/download/attachments/1700/lorem.png`);
  await expect
    .poll(() => image.evaluate((node) => node.complete && node.naturalWidth > 0))
    .toBe(true);
  const launcher = lab.wiki.page.locator(".cx-launcher");
  await expect(lab.wiki.page.locator("#cx-open-md-btn")).toBeVisible();
  await expect(launcher).toHaveCount(1);
  const surfaces = [
    {
      name: "options",
      page: appearance.page,
      root: appearance.root,
      primary: appearance.page.locator(".cx-options-logo"),
    },
    {
      name: "workspace",
      page: workspace,
      root: workspace.locator("html"),
      primary: workspaceUi.startButton,
    },
    {
      name: "launcher",
      page: lab.wiki.page,
      root: launcher,
      primary: lab.wiki.page.locator("#cx-open-md-btn"),
    },
    {
      name: "viewer",
      page: viewer,
      root: viewer.locator("html"),
      primary: viewer.locator(".cx-viewer-logo"),
    },
  ];
  const modes = Object.fromEntries(surfaces.map(({ name }) => [name, "light"]));
  for (const { page } of surfaces) await page.emulateMedia({ colorScheme: "light" });
  const hostBefore = await readHostAppearance(lab.wiki.page);
  expect(hostBefore.attributes["data-confx-appearance"]).toBeNull();
  const sourceUrl = lab.wiki.page.url();
  const sourceBefore = await lab.detail("1000");
  const rootBefore = await lab.detail("1700");
  await expect
    .poll(() => readExportState(workspace, lab.sourceTabId))
    .toMatchObject({
      draft: {
        scope: "subtree",
        subtree: { rootId: "1700", filter: rootTitle },
        defaults: { presetId: "md-only", package: { editable: false } },
      },
      jobs: {},
      downloads: [],
    });
  const exportBefore = await readExportState(workspace, lab.sourceTabId);
  expect(exportBefore.draft).not.toBeNull();
  expect(exportBefore.jobs).toEqual({});
  expect(exportBefore.downloads).toEqual([]);
  const navigations = [];
  for (const { name, page } of surfaces) {
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push({ name, url: frame.url() });
    });
  }
  const cursor = await lab.cursor();
  const receipts = [];
  const expectUnchangedWorkspace = async () => {
    await expect(workspaceUi.scopeTab("Subtree")).toHaveAttribute("aria-selected", "true");
    await expect(workspace.locator('[data-export-root="1700"]')).toContainText(rootTitle);
    await expect(workspace.getByRole("button", { name: rootTitle, exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(filter).toHaveValue(rootTitle);
    await expect(editable).toHaveAttribute("aria-checked", "false");
    await expect(workspaceUi.template).toContainText("Markdown only");
    await expect(workspaceUi.startButton).toBeEnabled();
    expect(await readExportState(workspace, lab.sourceTabId)).toEqual(exportBefore);
    expect(lab.wiki.page.url()).toBe(sourceUrl);
    expect(await readHostAppearance(lab.wiki.page)).toEqual(hostBefore);
    await expect(workspace.locator("html")).toHaveAttribute("data-surface", "workspace");
    await expect(appearance.root).toHaveAttribute("data-surface", "options");
    expect(
      navigations,
      "Appearance changes must update existing documents without reloads",
    ).toEqual([]);
  };

  await appearance.choose("cx-theme", "light");
  await appearance.choose("cx-palette", "blue");
  const lightTokens = await expectLiveAppearance(surfaces, modes, "blue");
  await expectUnchangedWorkspace();
  await appearance.choose("cx-theme", "system");
  const systemSettings = await appearance.settings();
  expect(systemSettings).toMatchObject({ theme: "system", palette: "blue" });
  expect(await expectLiveAppearance(surfaces, modes, "blue")).toEqual(lightTokens);

  for (const scheme of ["dark", "light"]) {
    for (const changed of surfaces) {
      await test.step(`system: only ${changed.name} resolves to ${scheme}`, async () => {
        const before = await expectLiveAppearance(surfaces, modes, "blue");
        await changed.page.emulateMedia({ colorScheme: scheme });
        modes[changed.name] = scheme;
        const after = await expectLiveAppearance(surfaces, modes, "blue");
        expect(after[changed.name].background).not.toEqual(before[changed.name].background);
        for (const untouched of surfaces.filter(({ name }) => name !== changed.name)) {
          expect(after[untouched.name], `${untouched.name} follows its own media query`).toEqual(
            before[untouched.name],
          );
        }
        expect(
          await appearance.settings(),
          "Resolving system must not overwrite the saved preference",
        ).toEqual(systemSettings);
        await expect(appearance.radio("cx-theme", "system")).toBeChecked();
        await appearance.expectPreviews("system", "blue", modes.options);
        await expectUnchangedWorkspace();
        receipts.push({
          step: `system-${changed.name}-${scheme}`,
          modes: { ...modes },
          colors: after,
        });
      });
    }
  }
  expect(await expectLiveAppearance(surfaces, modes, "blue")).toEqual(lightTokens);

  // A shared palette update must retain the independently resolved per-page OS modes.
  await appearance.page.emulateMedia({ colorScheme: "dark" });
  await lab.wiki.page.emulateMedia({ colorScheme: "dark" });
  modes.options = modes.launcher = "dark";
  for (const palette of ["forest", "amber", "violet"]) {
    await appearance.choose("cx-palette", palette);
    expect(await appearance.settings()).toEqual({ ...systemSettings, palette });
    await expect(appearance.radio("cx-theme", "system")).toBeChecked();
    const colors = await expectLiveAppearance(surfaces, modes, palette);
    await appearance.expectPreviews("system", palette, "dark");
    await expectUnchangedWorkspace();
    receipts.push({ step: `live-system-${palette}`, modes: { ...modes }, colors });
  }

  for (const mode of ["light", "dark"]) {
    for (const { page } of surfaces) await page.emulateMedia({ colorScheme: mode });
    await appearance.choose("cx-theme", mode);
    for (const { name } of surfaces) modes[name] = mode;
    const explicitSettings = await appearance.settings();
    const before = await expectLiveAppearance(surfaces, modes, "violet");
    const opposite = mode === "light" ? "dark" : "light";
    let optionsSystemMode = mode;
    for (const changed of surfaces) {
      await changed.page.emulateMedia({ colorScheme: opposite });
      if (changed.name === "options") optionsSystemMode = opposite;
      expect(
        await expectLiveAppearance(surfaces, modes, "violet"),
        `${changed.name}: explicit ${mode} ignores an actual OS change`,
      ).toEqual(before);
      expect(await appearance.settings()).toEqual(explicitSettings);
      // The system miniature still follows the OS even while explicit mode is selected.
      await appearance.expectPreviews(mode, "violet", optionsSystemMode);
      await expectUnchangedWorkspace();
    }
    await appearance.expectPreviews(mode, "violet", opposite);
    receipts.push({ step: `explicit-${mode}`, colors: before });
  }
  expect(await lab.detail("1000")).toEqual(sourceBefore);
  expect(await lab.detail("1700")).toEqual(rootBefore);
  expectReadOnlyConversions(await lab.logsAfter(cursor));
  await lab.testInfo.attach("live-appearance-and-unchanged-export-proof", {
    body: JSON.stringify(
      {
        receipts,
        draft: exportBefore.draft,
        noExportJobs: true,
        noDownloads: true,
        noReloads: true,
        hostUnchanged: true,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
});
