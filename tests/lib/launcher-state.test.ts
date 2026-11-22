import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLauncherPosition,
  getLauncherSites,
  launcherSiteKey,
  LAUNCHER_STORAGE_KEY,
  loadLauncherState,
  resetLauncherSite,
  snapLauncherPosition,
  updateLauncherSite,
  watchLauncherState,
} from "@/lib/launcher-state";
import { installLauncherStorage, type LauncherTestStorage } from "../helpers/launcher-storage";

const origin = "https://wiki.example.com";

describe("local launcher state", () => {
  let memory: LauncherTestStorage;

  beforeEach(() => {
    memory = installLauncherStorage();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps product overrides independent, restores visibility without moving, and resets one site", async () => {
    await updateLauncherSite(origin, "confluence", { hidden: true, edge: "left", yRatio: 0.25 });
    await updateLauncherSite(origin, "jira", { hidden: true, yRatio: 0.8 });
    await updateLauncherSite(origin, "confluence", { hidden: false });

    const restored = await loadLauncherState();
    expect(restored[launcherSiteKey(origin, "confluence")]).toMatchObject({
      hidden: false,
      edge: "left",
      yRatio: 0.25,
    });
    expect(restored[launcherSiteKey(origin, "jira")].hidden).toBe(true);
    await resetLauncherSite(origin, "confluence");
    expect(getLauncherSites(await loadLauncherState())).toEqual([
      { origin, product: "jira", override: restored[launcherSiteKey(origin, "jira")] },
    ]);
    expect(memory.syncSet).not.toHaveBeenCalled();
  });

  it("merges queued changes against fresh state rather than losing visibility or another site's position", async () => {
    await Promise.all([
      updateLauncherSite(origin, "confluence", { hidden: true }),
      updateLauncherSite(origin, "confluence", { edge: "left", yRatio: 0.4 }),
      updateLauncherSite("https://jira.example.com", "jira", { hidden: true }),
    ]);
    const saved = await loadLauncherState();
    expect(saved[launcherSiteKey(origin, "confluence")]).toMatchObject({
      hidden: true,
      edge: "left",
      yRatio: 0.4,
    });
    expect(getLauncherSites(saved)).toHaveLength(2);
  });

  it("ignores malformed or non-web site records and clamps a stored position before use", async () => {
    memory.local[LAUNCHER_STORAGE_KEY] = {
      [launcherSiteKey(origin, "confluence")]: { hidden: true, edge: "right", yRatio: 9 },
      "javascript:alert(1)|confluence": { hidden: true, edge: "left", yRatio: 0.5 },
      "https://jira.example.com|jira": { hidden: "false", edge: "left", yRatio: 0.5 },
      "https://other.example.com|other": { hidden: false, edge: "left", yRatio: 0.5 },
    };
    const sites = getLauncherSites(await loadLauncherState());
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ origin, product: "confluence", override: { yRatio: 1 } });
    expect(() => launcherSiteKey("file:///tmp/lorem", "confluence")).toThrow();
  });

  it("delivers local changes until unsubscribed, and a rejected write leaves previous state usable", async () => {
    const changed = vi.fn();
    const stop = watchLauncherState(changed);
    await updateLauncherSite(origin, "confluence", { hidden: true });
    expect(changed).toHaveBeenCalledTimes(1);
    stop();
    memory.localSet.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(updateLauncherSite(origin, "confluence", { hidden: false })).rejects.toThrow();
    expect((await loadLauncherState())[launcherSiteKey(origin, "confluence")].hidden).toBe(true);
    await updateLauncherSite(origin, "confluence", { hidden: false });
    expect(changed).toHaveBeenCalledTimes(1);
    expect((await loadLauncherState())[launcherSiteKey(origin, "confluence")].hidden).toBe(false);
  });
});

describe("launcher viewport positioning", () => {
  it("snaps to the nearest edge and retains the vertical ratio through viewport changes", () => {
    const viewport = { width: 1000, height: 800, offsetLeft: 0, offsetTop: 0 };
    const snapped = snapLauncherPosition({ left: 50, top: 390 }, viewport);
    const first = getLauncherPosition(snapped, viewport);
    expect(first.left).toBe(12);
    expect(first.top).toBeCloseTo(390);
    const zoomed = getLauncherPosition(snapped, {
      width: 300,
      height: 200,
      offsetLeft: 80,
      offsetTop: 120,
    });
    expect(zoomed.left).toBe(92);
    expect(zoomed.top).toBeGreaterThanOrEqual(132);
    expect(zoomed.top + 40).toBeLessThanOrEqual(308);
    expect(snapLauncherPosition({ left: 900, top: 9999 }, viewport)).toEqual({
      edge: "right",
      yRatio: 1,
    });
  });

  it("clamps both axes even when a viewport is smaller than the normal insets", () => {
    const position = getLauncherPosition(
      { edge: "right", yRatio: -4 },
      { width: 50, height: 45, offsetLeft: 5, offsetTop: 10 },
    );
    expect(position.left).toBeGreaterThanOrEqual(5);
    expect(position.left + 40).toBeLessThanOrEqual(55);
    expect(position.top).toBeGreaterThanOrEqual(10);
    expect(position.top + 40).toBeLessThanOrEqual(55);
  });
});
