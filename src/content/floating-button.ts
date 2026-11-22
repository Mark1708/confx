import { createTranslator, type I18nKey, type Translator } from "@/i18n";
import { applyAppearance, watchSystemTheme } from "@/lib/appearance";
import appearanceCss from "@/lib/appearance.css?inline";
import { BrowserApi } from "@/lib/browser/browser-api";
import { watchStorageKey } from "@/lib/browser/storage-watch";
import {
  DEFAULT_LAUNCHER_POSITION,
  getLauncherPosition,
  launcherSiteKey,
  LAUNCHER_INSET,
  LAUNCHER_SIZE,
  loadLauncherState,
  type LauncherCoordinates,
  type LauncherOverride,
  type LauncherProduct,
  type LauncherViewport,
  snapLauncherPosition,
  updateLauncherSite,
  watchLauncherState,
} from "@/lib/launcher-state";
import { type PageContext, readDocumentPageContext } from "@/lib/page-context";
import { loadSettings } from "@/lib/settings";
import type { AppSettings, OpenConfxRequest } from "@/types";
import btnCss from "./confx-button.css?inline";

const STYLE_ID = "cx-confx-button-style";
const launcherCss = `${appearanceCss}\n${btnCss}`;
const DEBOUNCE_MS = 150;
const DRAG_THRESHOLD = 6;
const activeLaunchers = new Map<LauncherProduct, FloatingButton>();

type ButtonPageContext<TKind extends LauncherProduct> = Extract<PageContext, { kind: TKind }>;

export interface ButtonConfig<TKind extends LauncherProduct> {
  btnId: string;
  pageKind: TKind;
  settingsKey: keyof Pick<AppSettings, "showConfluenceButton" | "showJiraButton">;
  buildPayload: (context: ButtonPageContext<TKind>) => OpenConfxRequest;
  logPrefix: string;
}

export interface FloatingButton {
  init: () => void;
  destroy: () => void;
}

export interface DebouncedReconcile {
  (): void;
  cancel: () => void;
}

/** Leading+trailing throttle with a reentrancy guard and lifecycle cancellation. */
export function createDebouncedReconcile(
  reconcile: () => Promise<void>,
  delay: number = DEBOUNCE_MS,
): DebouncedReconcile {
  let burstTimer: number | undefined;
  let reconciling = false;
  let cancelled = false;

  const safeReconcile = async (): Promise<void> => {
    if (cancelled || reconciling) return;
    reconciling = true;
    try {
      await reconcile();
    } finally {
      reconciling = false;
    }
  };

  const schedule = (): void => {
    if (cancelled) return;
    if (burstTimer === undefined) {
      burstTimer = setTimeout(() => {
        burstTimer = undefined;
      }, delay) as unknown as number;
      void safeReconcile();
      return;
    }
    clearTimeout(burstTimer);
    burstTimer = setTimeout(() => {
      burstTimer = undefined;
      void safeReconcile();
    }, delay) as unknown as number;
  };
  schedule.cancel = () => {
    cancelled = true;
    clearTimeout(burstTimer);
    burstTimer = undefined;
  };
  return schedule;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  origin: LauncherCoordinates;
  moved: boolean;
}

export function createFloatingButton<TKind extends LauncherProduct>(
  config: ButtonConfig<TKind>,
): FloatingButton {
  let active = false;
  let settingsReady = false;
  let overridesReady = false;
  let settingsGeneration = 0;
  let overridesGeneration = 0;
  let saveGeneration = 0;
  let enabled = false;
  let sessionHidden = false;
  let saving = false;
  let saveFailed = false;
  let theme: AppSettings["theme"] = "dark";
  let palette: AppSettings["palette"] = "violet";
  let t: Translator<I18nKey> = createTranslator();
  let override: LauncherOverride = { hidden: false, ...DEFAULT_LAUNCHER_POSITION };
  let coordinates: LauncherCoordinates = { left: 0, top: 0 };
  let drag: DragState | null = null;
  let suppressClick = false;
  let root: HTMLDivElement | null = null;
  let button: HTMLButtonElement | null = null;
  let menu: HTMLDivElement | null = null;
  let feedback: HTMLParagraphElement | null = null;
  let observer: MutationObserver | null = null;
  let debounced: DebouncedReconcile | null = null;
  let unsubscribeSettings: (() => void) | null = null;
  let unsubscribeOverrides: (() => void) | null = null;
  let unsubscribeSystemTheme: (() => void) | null = null;
  let visualViewport: VisualViewport | null = null;

  function getPageContext(): ButtonPageContext<TKind> | null {
    const context = readDocumentPageContext(document, location.href, document.title);
    return context.kind === config.pageKind ? (context as ButtonPageContext<TKind>) : null;
  }

  function viewport(): LauncherViewport {
    const visible = window.visualViewport;
    return {
      width: visible?.width ?? window.innerWidth,
      height: visible?.height ?? window.innerHeight,
      offsetLeft: visible?.offsetLeft ?? 0,
      offsetTop: visible?.offsetTop ?? 0,
    };
  }

  function positionMenu(): void {
    if (!menu || menu.hidden) return;
    const visible = viewport();
    const width = Math.min(256, Math.max(0, visible.width - 2 * LAUNCHER_INSET));
    menu.style.width = `${width}px`;
    menu.style.maxHeight = `${Math.max(0, visible.height - 2 * LAUNCHER_INSET)}px`;
    const height = menu.getBoundingClientRect().height;
    const preferredLeft =
      override.edge === "right" ? coordinates.left + LAUNCHER_SIZE - width : coordinates.left;
    menu.style.left = `${Math.max(
      visible.offsetLeft + LAUNCHER_INSET,
      Math.min(visible.offsetLeft + visible.width - width - LAUNCHER_INSET, preferredLeft),
    )}px`;
    const below = coordinates.top + LAUNCHER_SIZE + 8;
    const preferredTop =
      below + height <= visible.offsetTop + visible.height - LAUNCHER_INSET
        ? below
        : coordinates.top - height - 8;
    menu.style.top = `${Math.max(
      visible.offsetTop + LAUNCHER_INSET,
      Math.min(visible.offsetTop + visible.height - height - LAUNCHER_INSET, preferredTop),
    )}px`;
  }

  function applyCoordinates(next: LauncherCoordinates): void {
    coordinates = next;
    if (!root) return;
    root.style.left = `${next.left}px`;
    root.style.top = `${next.top}px`;
    positionMenu();
  }

  function closeMenu(restoreFocus: boolean): void {
    if (menu) menu.hidden = true;
    button?.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onOutsideInteraction);
    document.removeEventListener("focusin", onOutsideInteraction);
    if (restoreFocus) button?.focus();
  }

  function openMenu(): void {
    if (!menu || !button) return;
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    positionMenu();
    document.addEventListener("pointerdown", onOutsideInteraction);
    document.addEventListener("focusin", onOutsideInteraction);
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }

  function onOutsideInteraction(event: Event): void {
    if (event.target instanceof Node && !root?.contains(event.target)) closeMenu(false);
  }

  function updateAppearance(): void {
    unsubscribeSystemTheme?.();
    unsubscribeSystemTheme = null;
    const target = root;
    if (!target) return;
    if (theme === "system") {
      unsubscribeSystemTheme = watchSystemTheme((resolved) => {
        applyAppearance(target, resolved, palette);
      });
    } else {
      applyAppearance(target, theme, palette);
    }
  }

  function updateLabels(): void {
    if (!root || !button || !menu) return;
    button.title = `${t("content.openInConfx")} — ${t("launcher.help")}`;
    button.setAttribute("aria-label", t("content.openInConfx"));
    button.setAttribute("aria-description", t("launcher.help"));
    menu.setAttribute("aria-label", t("launcher.menuLabel"));
    const labels: I18nKey[] = [
      "launcher.hideUntilReload",
      "launcher.hideOnSite",
      "launcher.resetPosition",
    ];
    menu.querySelectorAll<HTMLButtonElement>("button").forEach((item, index) => {
      const label = t(labels[index]);
      if (item.textContent !== label) item.textContent = label;
      item.disabled = saving;
    });
    if (feedback) {
      const message = t("launcher.saveFailed");
      if (feedback.textContent !== message) feedback.textContent = message;
      feedback.hidden = !saveFailed;
    }
  }

  async function persistOverride(
    patch: Partial<LauncherOverride>,
    optimistic = false,
  ): Promise<void> {
    if (saving) return;
    const previous = override;
    const generation = ++saveGeneration;
    const observedOverrides = overridesGeneration;
    saving = true;
    saveFailed = false;
    if (optimistic) override = { ...override, ...patch };
    updateLabels();
    applyCoordinates(getLauncherPosition(override, viewport()));
    try {
      const state = await updateLauncherSite(location.origin, config.pageKind, patch);
      if (!active || generation !== saveGeneration) return;
      if (observedOverrides === overridesGeneration) {
        override = state[launcherSiteKey(location.origin, config.pageKind)] ?? {
          hidden: false,
          ...DEFAULT_LAUNCHER_POSITION,
        };
      } else {
        await refreshOverrides();
      }
    } catch (error) {
      if (!active || generation !== saveGeneration) return;
      console.error("[cx] failed to save launcher settings", error);
      saveFailed = true;
      if (observedOverrides === overridesGeneration) override = previous;
      else await refreshOverrides();
    } finally {
      if (active && generation === saveGeneration) {
        saving = false;
        void reconcile();
        if (saveFailed) openMenu();
      }
    }
  }

  function releasePointer(): void {
    const previous = drag;
    drag = null;
    if (button) {
      delete button.dataset.dragging;
      if (previous && button.hasPointerCapture?.(previous.pointerId)) {
        button.releasePointerCapture(previous.pointerId);
      }
    }
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !event.isPrimary || saving) return;
    closeMenu(false);
    suppressClick = false;
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: { ...coordinates },
      moved: false,
    };
    button?.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    suppressClick = true;
    event.preventDefault();
    if (button) button.dataset.dragging = "true";
    const visible = viewport();
    const min = getLauncherPosition({ edge: "left", yRatio: 0 }, visible);
    const max = getLauncherPosition({ edge: "right", yRatio: 1 }, visible);
    applyCoordinates({
      left: Math.max(min.left, Math.min(max.left, drag.origin.left + dx)),
      top: Math.max(min.top, Math.min(max.top, drag.origin.top + dy)),
    });
  }

  function onPointerUp(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const moved = drag.moved;
    releasePointer();
    if (moved) void persistOverride(snapLauncherPosition(coordinates, viewport()), true);
  }

  function onPointerCancel(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return;
    releasePointer();
    applyCoordinates(getLauncherPosition(override, viewport()));
  }

  function openConfx(): void {
    const context = getPageContext();
    if (!active || !context) return;
    closeMenu(false);
    BrowserApi.sendMessage(config.buildPayload(context)).catch((error) => {
      console.error("[cx] open-confx failed", error);
    });
  }

  function onClick(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (suppressClick && event.detail !== 0) {
      suppressClick = false;
      return;
    }
    openConfx();
  }

  function onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    openMenu();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.target === button) {
      if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
        event.preventDefault();
        event.stopPropagation();
        openMenu();
        return;
      }
      if (event.key === "Enter" && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        suppressClick = false;
        openConfx();
        return;
      }
    }
    if (!menu || menu.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    if (event.key === "Tab") {
      closeMenu(false);
      return;
    }
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const items = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  }

  function onMenuClick(event: MouseEvent): void {
    if (!(event.target instanceof Element)) return;
    const item = event.target.closest<HTMLButtonElement>("button[data-action]");
    if (!item || item.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    if (item.dataset.action === "hide-session") {
      sessionHidden = true;
      void reconcile();
    } else if (item.dataset.action === "hide-site") {
      void persistOverride({ hidden: true });
    } else if (item.dataset.action === "reset-position") {
      closeMenu(true);
      void persistOverride(DEFAULT_LAUNCHER_POSITION);
    }
  }

  function ensureStyle(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = launcherCss;
    (document.head ?? document.documentElement).appendChild(style);
  }

  function mount(): void {
    root = document.createElement("div");
    root.className = "cx-launcher";
    root.dataset.product = config.pageKind;
    button = document.createElement("button");
    button.id = config.btnId;
    button.type = "button";
    button.className = "cx-confx-button";
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", `${config.btnId}-menu`);
    button.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><path d="M8 13h8M8 17h5"></path></svg>';
    menu = document.createElement("div");
    menu.id = `${config.btnId}-menu`;
    menu.className = "cx-launcher-menu";
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    for (const action of ["hide-session", "hide-site", "reset-position"]) {
      const item = document.createElement("button");
      item.type = "button";
      item.dataset.action = action;
      item.setAttribute("role", "menuitem");
      item.tabIndex = -1;
      menu.appendChild(item);
    }
    feedback = document.createElement("p");
    feedback.className = "cx-launcher-feedback";
    feedback.setAttribute("role", "alert");
    menu.appendChild(feedback);
    root.append(button, menu);
    updateAppearance();
    updateLabels();
    applyCoordinates(getLauncherPosition(override, viewport()));
    button.addEventListener("pointerdown", onPointerDown);
    button.addEventListener("pointermove", onPointerMove);
    button.addEventListener("pointerup", onPointerUp);
    button.addEventListener("pointercancel", onPointerCancel);
    button.addEventListener("lostpointercapture", onPointerCancel);
    button.addEventListener("click", onClick);
    button.addEventListener("contextmenu", onContextMenu);
    root.addEventListener("keydown", onKeyDown);
    menu.addEventListener("click", onMenuClick);
    document.body.appendChild(root);
  }

  function unmount(): void {
    unsubscribeSystemTheme?.();
    unsubscribeSystemTheme = null;
    closeMenu(false);
    releasePointer();
    button?.removeEventListener("pointerdown", onPointerDown);
    button?.removeEventListener("pointermove", onPointerMove);
    button?.removeEventListener("pointerup", onPointerUp);
    button?.removeEventListener("pointercancel", onPointerCancel);
    button?.removeEventListener("lostpointercapture", onPointerCancel);
    button?.removeEventListener("click", onClick);
    button?.removeEventListener("contextmenu", onContextMenu);
    root?.removeEventListener("keydown", onKeyDown);
    menu?.removeEventListener("click", onMenuClick);
    root?.remove();
    root = null;
    button = null;
    menu = null;
    feedback = null;
  }

  async function reconcile(): Promise<void> {
    if (
      !active ||
      !settingsReady ||
      !overridesReady ||
      !enabled ||
      sessionHidden ||
      override.hidden ||
      !getPageContext()
    ) {
      unmount();
      return;
    }
    ensureStyle();
    if (!root?.isConnected || !button?.isConnected || !menu?.isConnected) {
      unmount();
      mount();
    }
    updateLabels();
    if (!drag) applyCoordinates(getLauncherPosition(override, viewport()));
  }

  async function refreshSettings(): Promise<void> {
    const generation = ++settingsGeneration;
    try {
      const settings = await loadSettings();
      if (!active || generation !== settingsGeneration) return;
      const appearanceChanged = theme !== settings.theme || palette !== settings.palette;
      enabled = settings[config.settingsKey];
      theme = settings.theme;
      palette = settings.palette;
      t = createTranslator(settings.locale);
      settingsReady = true;
      if (appearanceChanged && root?.isConnected) updateAppearance();
    } catch (error) {
      if (!active || generation !== settingsGeneration) return;
      settingsReady = false;
      console.error(config.logPrefix, error);
    }
    void reconcile();
  }

  async function refreshOverrides(): Promise<void> {
    const generation = ++overridesGeneration;
    try {
      const state = await loadLauncherState();
      if (!active || generation !== overridesGeneration) return;
      override = state[launcherSiteKey(location.origin, config.pageKind)] ?? {
        hidden: false,
        ...DEFAULT_LAUNCHER_POSITION,
      };
      overridesReady = true;
      // A read begun before a save can still supersede that save when it completes.
      overridesGeneration++;
    } catch (error) {
      if (!active || generation !== overridesGeneration) return;
      overridesReady = false;
      console.error("[cx] failed to load local launcher settings", error);
    }
    void reconcile();
  }

  function onViewportChange(): void {
    releasePointer();
    applyCoordinates(getLauncherPosition(override, viewport()));
  }

  function destroy(): void {
    active = false;
    settingsGeneration++;
    overridesGeneration++;
    saveGeneration++;
    saving = false;
    saveFailed = false;
    observer?.disconnect();
    observer = null;
    debounced?.cancel();
    debounced = null;
    unsubscribeSettings?.();
    unsubscribeSettings = null;
    unsubscribeOverrides?.();
    unsubscribeOverrides = null;
    window.removeEventListener("resize", onViewportChange);
    visualViewport?.removeEventListener("resize", onViewportChange);
    visualViewport?.removeEventListener("scroll", onViewportChange);
    visualViewport = null;
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
    if (activeLaunchers.get(config.pageKind) === launcher) activeLaunchers.delete(config.pageKind);
    unmount();
  }

  function onPageShow(): void {
    init();
  }

  function onPageHide(event: PageTransitionEvent): void {
    destroy();
    if (event.persisted) window.addEventListener("pageshow", onPageShow, { once: true });
  }

  function init(): void {
    if (active) return;
    activeLaunchers.get(config.pageKind)?.destroy();
    activeLaunchers.set(config.pageKind, launcher);
    active = true;
    settingsReady = false;
    overridesReady = false;
    unsubscribeSettings = watchStorageKey("sync", "cx.settings.v1", () => void refreshSettings());
    unsubscribeOverrides = watchLauncherState(() => void refreshOverrides());
    debounced = createDebouncedReconcile(reconcile);
    observer = new MutationObserver(debounced);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["content"],
    });
    visualViewport = window.visualViewport;
    window.addEventListener("resize", onViewportChange);
    visualViewport?.addEventListener("resize", onViewportChange);
    visualViewport?.addEventListener("scroll", onViewportChange);
    window.addEventListener("pagehide", onPageHide);
    void refreshSettings();
    void refreshOverrides();
  }

  const launcher: FloatingButton = { init, destroy };
  return launcher;
}
