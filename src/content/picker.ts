import { createTranslator } from "@/i18n";
import { BrowserApi } from "@/lib/browser/browser-api";
import type { ConfluencePageMeta, PickerResult } from "@/types";
import { loadContentTranslator } from "./i18n";
import pickerCss from "./picker.css?inline";

let overlay: HTMLDivElement | null = null;
let highlight: HTMLDivElement | null = null;
let tooltip: HTMLDivElement | null = null;
let styleEl: HTMLStyleElement | null = null;
let currentTarget: Element | null = null;
let depthOffset = 0;
let active = false;
let pickerT = createTranslator();

const SNAP_SELECTORS = [
  "h1, h2, h3",
  ".table-wrap",
  ".expand-container",
  ".confluence-information-macro",
  "section",
  "#main-content",
];

function snapToMeaningful(el: Element): Element {
  for (const sel of SNAP_SELECTORS) {
    const closest = el.closest(sel);
    if (closest && closest !== document.body) return closest;
  }
  return el;
}

function liftByDepth(el: Element, offset: number): Element {
  let node: Element | null = el;
  for (let i = 0; i < offset && node?.parentElement; i++) {
    node = node.parentElement;
  }
  return node ?? el;
}

function ensureOverlay(): void {
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.setAttribute("data-cx-picker", "1");
    styleEl.textContent = pickerCss;
    document.head.appendChild(styleEl);
  }
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "cx-picker-overlay";
    document.body.appendChild(overlay);
  }
  if (!highlight) {
    highlight = document.createElement("div");
    highlight.id = "cx-picker-highlight";
    overlay?.appendChild(highlight);
  }
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "cx-picker-tooltip";
    document.body.appendChild(tooltip);
  }
}

function removeOverlay(): void {
  overlay?.remove();
  tooltip?.remove();
  styleEl?.remove();
  overlay = null;
  highlight = null;
  tooltip = null;
  styleEl = null;
}

function describe(el: Element): { selector: string; stats: string } {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const cls = el.classList.length ? `.${Array.from(el.classList).slice(0, 2).join(".")}` : "";
  const selector = `${tag}${id}${cls}`;

  const tables = el.querySelectorAll("table").length;
  const images = el.querySelectorAll("img").length;
  const textLen = (el.textContent ?? "").replace(/\s+/g, " ").trim().length;
  const words = Math.round(textLen / 5.5);
  const parts: string[] = [];
  if (tables) parts.push(pickerT("picker.overlay.tablesShort", { count: tables }));
  if (images) parts.push(pickerT("picker.overlay.imagesShort", { count: images }));
  if (words) parts.push(pickerT("picker.overlay.wordsApprox", { count: words }));
  return { selector, stats: parts.join(" · ") || pickerT("picker.overlay.empty") };
}

function updateHighlight(el: Element): void {
  if (!highlight || !tooltip) return;
  const rect = el.getBoundingClientRect();
  highlight.style.left = `${rect.left}px`;
  highlight.style.top = `${rect.top}px`;
  highlight.style.width = `${rect.width}px`;
  highlight.style.height = `${rect.height}px`;

  const { selector, stats } = describe(el);
  tooltip.innerHTML = `
    <div class="cx-selector">${escapeHtml(selector)}</div>
    <div class="cx-stats">${escapeHtml(stats)}</div>
    <div class="cx-hint">${escapeHtml(pickerT("picker.overlay.hint"))}</div>
  `;
  const ttTop = rect.top > 40 ? rect.top - 36 : rect.bottom + 8;
  tooltip.style.left = `${Math.min(rect.left, window.innerWidth - 380)}px`;
  tooltip.style.top = `${ttTop}px`;
}

function onMove(e: MouseEvent): void {
  if (!active) return;
  const target = document.elementFromPoint(e.clientX, e.clientY);
  if (!target || target === overlay || target === tooltip) return;
  const snapped = snapToMeaningful(target);
  currentTarget = liftByDepth(snapped, depthOffset);
  updateHighlight(currentTarget);
}

function onClick(e: MouseEvent): void {
  if (!active) return;
  e.preventDefault();
  e.stopImmediatePropagation();

  const target = currentTarget ?? targetFromClick(e);
  if (!target) return;

  sendPickedBlock(target);
  stopPicker();
}

function targetFromClick(e: MouseEvent): Element | null {
  const target = document.elementFromPoint(e.clientX, e.clientY);
  if (!target || target === overlay || target === tooltip) return null;
  return liftByDepth(snapToMeaningful(target), depthOffset);
}

function onKeydown(e: KeyboardEvent): void {
  if (!active) return;
  if (e.key === "Escape") {
    e.preventDefault();
    stopPicker();
    return;
  }
  if (e.key === "]") {
    depthOffset = Math.max(0, depthOffset - 1);
    if (currentTarget) updateHighlight(currentTarget);
  }
  if (e.key === "[") {
    depthOffset += 1;
    if (currentTarget) updateHighlight(currentTarget);
  }
}

function currentPageMeta(): ConfluencePageMeta {
  const pageId = document.querySelector('meta[name="ajs-page-id"]')?.getAttribute("content") ?? "";
  const spaceKey =
    document.querySelector('meta[name="ajs-space-key"]')?.getAttribute("content") ?? "";
  const title =
    document.querySelector('meta[name="ajs-page-title"]')?.getAttribute("content") ??
    document.title;
  const version = Number(
    document.querySelector('meta[name="ajs-page-version"]')?.getAttribute("content") ?? 0,
  );
  return {
    id: pageId,
    title,
    spaceKey,
    baseUrl: `${location.protocol}//${location.host}`,
    url: location.href,
    version: Number.isFinite(version) && version > 0 ? version : undefined,
  };
}

function sendPickedBlock(el: Element): void {
  const clone = el.cloneNode(true) as HTMLElement;
  // strip picker UI from the clone if any slipped in
  clone
    .querySelectorAll("#cx-picker-overlay, #cx-picker-tooltip, #cx-picker-highlight")
    .forEach((n) => {
      n.remove();
    });
  const payload: PickerResult = {
    kind: "picker-result",
    html: clone.outerHTML,
    meta: currentPageMeta(),
  };
  BrowserApi.sendMessage(payload).catch(() => {});
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function refreshPickerTranslations(): Promise<void> {
  pickerT = await loadContentTranslator();
  if (active && currentTarget) updateHighlight(currentTarget);
}

export function startPicker(): void {
  if (active) return;
  active = true;
  depthOffset = 0;
  void refreshPickerTranslations();
  ensureOverlay();
  document.documentElement.classList.add("cx-picker-active");
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeydown, true);
}

export function stopPicker(): void {
  if (!active) return;
  active = false;
  document.documentElement.classList.remove("cx-picker-active");
  document.removeEventListener("mousemove", onMove, true);
  document.removeEventListener("click", onClick, true);
  document.removeEventListener("keydown", onKeydown, true);
  removeOverlay();
  currentTarget = null;
}
