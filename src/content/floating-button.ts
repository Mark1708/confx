import { createTranslator } from "@/i18n";
import { BrowserApi } from "@/lib/browser/browser-api";
import { type PageContext, readDocumentPageContext } from "@/lib/page-context";
import { loadSettings } from "@/lib/settings";
import type { AppSettings, OpenConfxRequest } from "@/types";
import btnCss from "./confx-button.css?inline";
import { loadContentTranslator } from "./i18n";

const STYLE_ID = "cx-confx-button-style";
const FALLBACK_BUTTON_LABEL = createTranslator()("content.openInConfx");

type ButtonPageKind = Extract<PageContext["kind"], "confluence" | "jira">;
type ButtonPageContext<TKind extends ButtonPageKind> = Extract<PageContext, { kind: TKind }>;

export interface ButtonConfig<TKind extends ButtonPageKind> {
  btnId: string;
  pageKind: TKind;
  settingsKey: keyof Pick<AppSettings, "showConfluenceButton" | "showJiraButton">;
  buildPayload: (context: ButtonPageContext<TKind>) => OpenConfxRequest;
  logPrefix: string;
}

export function createFloatingButton<TKind extends ButtonPageKind>(config: ButtonConfig<TKind>): { init: () => void } {
  let buttonLabel = FALLBACK_BUTTON_LABEL;
  let showButton: boolean | null = null;
  let settingsLoadPromise: Promise<boolean> | null = null;
  let observer: MutationObserver | null = null;

  function getPageContext(): ButtonPageContext<TKind> | null {
    const context = readDocumentPageContext(document, location.href, document.title);
    return context.kind === config.pageKind ? (context as ButtonPageContext<TKind>) : null;
  }

  function ensureStyle(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = btnCss;
    document.head.appendChild(style);
  }

  function setButtonLabel(btn: HTMLButtonElement, label: string): void {
    btn.title = label;
    const labelNode = btn.querySelector("span");
    if (labelNode) labelNode.textContent = label;
  }

  function buildButtonElement(): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.id = config.btnId;
    btn.type = "button";
    btn.className = "cx-confx-button";
    btn.title = buttonLabel;
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
        <polyline points="14 2 14 8 20 8"></polyline>
        <path d="M8 13h8"></path>
        <path d="M8 17h5"></path>
      </svg>
      <span></span>
    `;
    setButtonLabel(btn, buttonLabel);
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const context = getPageContext();
      if (!context) return;
      BrowserApi.sendMessage(config.buildPayload(context)).catch((error) => {
        console.error("[cx] open-confx failed", error);
      });
    });
    return btn;
  }

  async function refreshButtonLabel(): Promise<void> {
    const translator = await loadContentTranslator();
    buttonLabel = translator("content.openInConfx");
    const existing = document.getElementById(config.btnId) as HTMLButtonElement | null;
    if (existing) setButtonLabel(existing, buttonLabel);
  }

  async function shouldShowButton(): Promise<boolean> {
    if (showButton !== null) return showButton;
    if (!settingsLoadPromise) {
      settingsLoadPromise = loadSettings()
        .then((settings) => {
          showButton = settings[config.settingsKey];
          return showButton;
        })
        .catch((error: unknown) => {
          console.error(`${config.logPrefix}; showing button`, error);
          showButton = true;
          return showButton;
        });
    }

    return settingsLoadPromise;
  }

  function mount(): boolean {
    if (document.getElementById(config.btnId)) return true;
    if (!getPageContext()) return false;

    ensureStyle();
    document.body.appendChild(buildButtonElement());
    return true;
  }

  function unmount(): void {
    document.getElementById(config.btnId)?.remove();
  }

  async function reconcile(): Promise<void> {
    if (!getPageContext()) {
      unmount();
      return;
    }

    const shouldShow = await shouldShowButton();
    if (!shouldShow) {
      unmount();
      return;
    }

    const existing = document.getElementById(config.btnId);
    const mounted = mount();
    if (mounted && !existing) void refreshButtonLabel();
  }

  function init(): void {
    if (!getPageContext()) return;

    void reconcile();

    if (observer) return;
    observer = new MutationObserver(() => {
      void reconcile();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  return { init };
}
