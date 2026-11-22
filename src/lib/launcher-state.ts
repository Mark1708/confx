import { MessageBus } from "@/lib/browser/message-bus";
import { storage } from "@/lib/browser/storage";
import { watchStorageKey } from "@/lib/browser/storage-watch";
import type { UpdateLauncherStateRequest } from "@/types";

export const LAUNCHER_STORAGE_KEY = "cx.launcher.v1";
export const LAUNCHER_SIZE = 40;
export const LAUNCHER_INSET = 12;
export const DEFAULT_LAUNCHER_POSITION: Readonly<LauncherPosition> = {
  edge: "right",
  yRatio: 0.62,
};

export type LauncherProduct = "confluence" | "jira";

export interface LauncherPosition {
  edge: "left" | "right";
  yRatio: number;
}

export interface LauncherOverride extends LauncherPosition {
  hidden: boolean;
}

export type LauncherState = Record<string, LauncherOverride>;

export interface LauncherSite {
  origin: string;
  product: LauncherProduct;
  override: LauncherOverride;
}

export interface LauncherViewport {
  width: number;
  height: number;
  offsetLeft: number;
  offsetTop: number;
}

export interface LauncherCoordinates {
  left: number;
  top: number;
}

function clampRatio(value: number): number {
  return Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : DEFAULT_LAUNCHER_POSITION.yRatio;
}

/** Site metadata never contains paths, page identities, or sync settings. */
export function launcherSiteKey(origin: string, product: LauncherProduct): string {
  const url = new URL(origin);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Launcher site must be an HTTP(S) origin");
  }
  return `${url.origin}|${product}`;
}

function parseSiteKey(key: string): Pick<LauncherSite, "origin" | "product"> | null {
  const separator = key.lastIndexOf("|");
  const origin = key.slice(0, separator);
  const product = key.slice(separator + 1);
  if (product !== "confluence" && product !== "jira") return null;
  try {
    return launcherSiteKey(origin, product) === key ? { origin, product } : null;
  } catch {
    return null;
  }
}

function normalizeState(raw: unknown): LauncherState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const state: LauncherState = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!parseSiteKey(key) || !value || typeof value !== "object") continue;
    const override = value as Record<string, unknown>;
    if (
      typeof override.hidden !== "boolean" ||
      (override.edge !== "left" && override.edge !== "right") ||
      typeof override.yRatio !== "number" ||
      !Number.isFinite(override.yRatio)
    )
      continue;
    state[key] = {
      hidden: override.hidden,
      edge: override.edge,
      yRatio: clampRatio(override.yRatio),
    };
  }
  return state;
}

export async function loadLauncherState(): Promise<LauncherState> {
  const stored = await storage.local.get(LAUNCHER_STORAGE_KEY);
  return normalizeState(stored[LAUNCHER_STORAGE_KEY]);
}

export function getLauncherSites(state: LauncherState): LauncherSite[] {
  return Object.entries(state)
    .flatMap(([key, override]) => {
      const site = parseSiteKey(key);
      return site ? [{ ...site, override }] : [];
    })
    .sort((a, b) => a.origin.localeCompare(b.origin) || a.product.localeCompare(b.product));
}

async function mutateSite(
  origin: string,
  product: LauncherProduct,
  patch: Partial<LauncherOverride> | null,
): Promise<LauncherState> {
  const request: UpdateLauncherStateRequest = {
    kind: "update-launcher-state",
    origin: new URL(origin).origin,
    product,
    patch,
  };
  const response = await MessageBus.send(request);
  if (!response || typeof response !== "object") {
    throw new Error("Invalid launcher settings response");
  }
  if (!("ok" in response) || response.ok !== true) {
    const error =
      "error" in response && typeof response.error === "string"
        ? response.error
        : "Could not update launcher settings";
    throw new Error(error);
  }
  if (
    !("state" in response) ||
    !response.state ||
    typeof response.state !== "object" ||
    Array.isArray(response.state)
  ) {
    throw new Error("Invalid launcher settings response");
  }
  return normalizeState(response.state);
}

export function updateLauncherSite(
  origin: string,
  product: LauncherProduct,
  patch: Partial<LauncherOverride>,
): Promise<LauncherState> {
  return mutateSite(origin, product, patch);
}

export function resetLauncherSite(
  origin: string,
  product: LauncherProduct,
): Promise<LauncherState> {
  return mutateSite(origin, product, null);
}

export function watchLauncherState(onChange: () => void): () => void {
  return watchStorageKey("local", LAUNCHER_STORAGE_KEY, onChange);
}

/** Coordinates are in the layout viewport, including a zoomed visual viewport's offset. */
export function getLauncherPosition(
  position: LauncherPosition,
  viewport: LauncherViewport,
): LauncherCoordinates {
  const insetX = Math.min(LAUNCHER_INSET, Math.max(0, (viewport.width - LAUNCHER_SIZE) / 2));
  const insetY = Math.min(LAUNCHER_INSET, Math.max(0, (viewport.height - LAUNCHER_SIZE) / 2));
  const availableHeight = Math.max(0, viewport.height - LAUNCHER_SIZE - 2 * insetY);
  return {
    left:
      viewport.offsetLeft +
      (position.edge === "left"
        ? insetX
        : Math.max(insetX, viewport.width - LAUNCHER_SIZE - insetX)),
    top: viewport.offsetTop + insetY + clampRatio(position.yRatio) * availableHeight,
  };
}

export function snapLauncherPosition(
  coordinates: LauncherCoordinates,
  viewport: LauncherViewport,
): LauncherPosition {
  const insetY = Math.min(LAUNCHER_INSET, Math.max(0, (viewport.height - LAUNCHER_SIZE) / 2));
  const availableHeight = Math.max(0, viewport.height - LAUNCHER_SIZE - 2 * insetY);
  return {
    edge:
      coordinates.left + LAUNCHER_SIZE / 2 < viewport.offsetLeft + viewport.width / 2
        ? "left"
        : "right",
    yRatio:
      availableHeight > 0
        ? clampRatio((coordinates.top - viewport.offsetTop - insetY) / availableHeight)
        : 0,
  };
}
