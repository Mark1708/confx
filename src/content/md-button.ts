import { BrowserApi } from "@/lib/browser/browser-api";
import { readDocumentPageContext } from "@/lib/page-context";
import type { OpenConfxRequest } from "@/types";
import btnCss from "./confx-button.css?inline";

const BTN_ID = "cx-open-md-btn";
const STYLE_ID = "cx-confx-button-style";

function getPageContext() {
  const context = readDocumentPageContext(document, location.href, document.title);
  return context.kind === "confluence" ? context : null;
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = btnCss;
  document.head.appendChild(style);
}

function updateTopOffset(btn: HTMLButtonElement): void {
  const header = document.querySelector("#header, #navigation, .aui-header, header");
  const rect = header?.getBoundingClientRect();
  const offset = rect && rect.height > 0 ? Math.ceil(rect.bottom + 12) : 76;
  btn.style.setProperty("--cx-confx-button-top", `${offset}px`);
}

function buildButtonElement(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.id = BTN_ID;
  btn.type = "button";
  btn.className = "cx-confx-button";
  btn.title = "Открыть страницу в ConfX";
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
      <polyline points="14 2 14 8 20 8"></polyline>
      <path d="M8 13h8"></path>
      <path d="M8 17h5"></path>
    </svg>
    <span>Открыть в ConfX</span>
  `;
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const context = getPageContext();
    if (!context) return;
    const payload: OpenConfxRequest = {
      kind: "open-confx",
      source: "confluence",
      host: context.host,
      pageId: context.pageId,
      title: context.title,
    };
    BrowserApi.sendMessage(payload).catch((error) => {
      console.error("[cx] open-confx failed", error);
    });
  });
  updateTopOffset(btn);
  return btn;
}

function mount(): boolean {
  if (document.getElementById(BTN_ID)) return true;
  if (!getPageContext()) return false;

  ensureStyle();
  document.body.appendChild(buildButtonElement());
  return true;
}

function unmount(): void {
  document.getElementById(BTN_ID)?.remove();
}

let observer: MutationObserver | null = null;

export function initMdButton(): void {
  if (!getPageContext()) return;

  mount();

  if (observer) return;
  observer = new MutationObserver(() => {
    const existing = document.getElementById(BTN_ID) as HTMLButtonElement | null;
    if (!getPageContext()) {
      unmount();
      return;
    }
    if (existing) {
      updateTopOffset(existing);
    } else {
      mount();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}
