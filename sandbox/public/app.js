/* Self-hosted developer UI. Server snapshots never overwrite a live native editor. */
"use strict";

const element = (id) => document.getElementById(id);
const route = new URL(window.location.href);
const pageId = route.searchParams.get("pageId");
const isPage = ["/pages/viewpage.action", "/pages/editpage.action"].includes(route.pathname);
const isEditing = route.pathname === "/pages/editpage.action";
let catalog;
let detail;
let editor;
let editorBaseVersion;
let editorGeneration;
let cleanEditorHtml = "";
let busy = false;

function pageUrl(id, edit = false) {
  return `/pages/${edit ? "editpage" : "viewpage"}.action?pageId=${encodeURIComponent(id)}`;
}

function node(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}

function link(text, href) {
  const result = node("a", text);
  result.href = href;
  return result;
}

function report(message, error = false) {
  element("status").textContent = message;
  element("status").classList.toggle("error", error);
}

async function request(path, method = "GET", body) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const payload = await response.json();
  if (!response.ok) {
    const message =
      typeof payload.error === "string"
        ? payload.error
        : payload.error?.message || payload.message || response.statusText;
    throw new Error(`HTTP ${response.status}: ${message}`);
  }
  return payload;
}

function nativeDirty() {
  return Boolean(editor?.initialized && editor.getContent() !== cleanEditorHtml);
}

function renderNativeState() {
  if (!editor?.initialized) return;
  element("native-state").textContent = nativeDirty() ? "Unsaved changes" : "Clean working copy";
  if (element("snapshot-kind").value === "native-editor") renderSnapshot();
}

function setBusy(value) {
  busy = value;
  for (const id of ["reset-sandbox", "refresh-snapshot", "apply-scenario"])
    element(id).disabled = value;
  for (const id of ["save-draft", "discard-draft", "publish-page"])
    element(id).disabled = value || !editor?.initialized;
  if (editor?.initialized) editor.mode.set(value ? "readonly" : "design");
  element("workspace").setAttribute("aria-busy", String(value));
}

async function operate(action) {
  if (busy) return;
  setBusy(true);
  try {
    await action();
  } catch (error) {
    report(`${error.message} Your native working copy has been retained.`, true);
  } finally {
    setBusy(false);
    try {
      await refreshLogs();
    } catch (error) {
      report(`Request log unavailable: ${error.message}`, true);
    }
  }
}

function renderNavigation() {
  const tree = element("page-tree");
  const children = (parentId) => {
    const list = node("ul");
    for (const page of catalog.pages.filter(
      (candidate) => String(candidate.parentId ?? "") === String(parentId ?? ""),
    )) {
      const item = node("li");
      const anchor = link(page.title, pageUrl(page.id));
      anchor.dataset.pageId = page.id;
      if (isPage && String(page.id) === pageId) anchor.setAttribute("aria-current", "page");
      item.append(anchor);
      if (catalog.pages.some((candidate) => String(candidate.parentId) === String(page.id)))
        item.append(children(page.id));
      list.append(item);
    }
    return list;
  };
  tree.replaceChildren(children(null));
}

function renderCatalog() {
  renderNavigation();
  element("catalog-count").textContent =
    `${catalog.pages.length} specimens · generation ${catalog.generation}`;
  const rows = catalog.pages.map((page) => {
    const row = node("tr");
    const title = node("th");
    title.scope = "row";
    title.append(link(page.title, pageUrl(page.id)), node("small", `#${page.id}`, "page-id"));
    const actions = node("td");
    actions.append(
      link("View", pageUrl(page.id)),
      document.createTextNode(" · "),
      link("Edit", pageUrl(page.id, true)),
    );
    row.append(
      title,
      node("td", page.components.join(" · ")),
      node("td", `v${page.version}`),
      node("td", page.hasDraft ? "Saved" : "None"),
      actions,
    );
    return row;
  });
  element("component-index").replaceChildren(...rows);
  const selected = element("scenario").value;
  element("scenario").replaceChildren(
    ...catalog.scenarios.map((scenario) => {
      const option = node("option", scenario.label);
      option.value = scenario.id;
      return option;
    }),
  );
  if (selected) element("scenario").value = selected;
}

function renderPage() {
  const { page, published, draft } = detail;
  document.title = `${page.title} · Lorem laboratory`;
  document.body.dataset.title = page.title;
  element("page-title").textContent = page.title;
  element("page-breadcrumb").textContent =
    `LOREM / Page ${page.id} / ${isEditing ? "Edit" : "View"}`;
  element("view-page").href = pageUrl(page.id);
  element("edit-page").href = pageUrl(page.id, true);
  element(isEditing ? "edit-page" : "view-page").setAttribute("aria-current", "page");
  element("published-version").textContent = `v${page.version}`;
  element("draft-version").textContent = draft
    ? `Saved · base v${draft.baseVersion}`
    : "No saved draft";
  element("page-components").textContent = page.components.join(" · ");
  const expectations = [
    ...(page.expectations?.supportedEdits ?? []).map((expectation) => `Supported: ${expectation}`),
    ...(page.expectations?.protectedRegions ?? []).map(
      (expectation) => `Protected: ${expectation}`,
    ),
  ];
  element("page-expectations").replaceChildren(
    ...expectations.map((expectation) => node("li", expectation)),
  );
  // Published view is produced by the independent, validating server codec, not editor input.
  element("main-content").innerHTML = published.view;
  element("scenario").value = detail.scenario;
  let versionMeta = document.querySelector('meta[name="ajs-page-version"]');
  if (!versionMeta) {
    versionMeta = document.createElement("meta");
    versionMeta.name = "ajs-page-version";
    document.head.append(versionMeta);
  }
  versionMeta.content = String(page.version);
  renderSnapshot();
}

function renderSnapshot() {
  const kind = element("snapshot-kind").value;
  let value;
  if (kind === "native-editor")
    value = editor?.initialized
      ? editor.getContent()
      : "Open Edit page to inspect the native working copy.";
  else if (!detail) value = "Select a specimen to inspect its source.";
  else {
    const [source, format] = kind.split("-");
    value = detail[source]?.[format] ?? "No saved draft.";
  }
  element("snapshot-source").textContent = value;
  element("snapshot-caption").textContent = detail
    ? `Page ${detail.page.id} · published v${detail.page.version} · generation ${detail.generation}${editorBaseVersion === undefined ? "" : ` · native base v${editorBaseVersion}`}. Refresh updates snapshots, not the native editor.`
    : "Select a page from the catalog. The HTTP log remains available here.";
}

async function refreshLogs() {
  const { entries } = await request("/sandbox/api/logs");
  element("request-count").textContent = `(${entries.length})`;
  element("request-log").replaceChildren(
    ...entries
      .slice()
      .reverse()
      .map((entry) => {
        const item = node("details", undefined, "log-entry");
        const summary = node(
          "summary",
          `${entry.seq} · ${entry.method} ${entry.path} · ${entry.status} · ${entry.kind}${entry.truncated ? " · CLIPPED" : ""}`,
        );
        const body = node("pre", JSON.stringify(entry, null, 2));
        body.tabIndex = 0;
        item.append(summary, body);
        return item;
      }),
  );
}

async function refreshSnapshots() {
  const [state, page] = await Promise.all([
    request("/sandbox/api/state"),
    isPage ? request(`/sandbox/api/pages/${encodeURIComponent(pageId)}`) : Promise.resolve(null),
  ]);
  catalog = state;
  detail = page;
  renderCatalog();
  if (detail) renderPage();
  else renderSnapshot();
}

function replaceNativeFromSnapshot() {
  editorBaseVersion = detail.draft?.baseVersion ?? detail.page.version;
  editorGeneration = detail.generation;
  editor.setContent(detail.draft?.editor ?? detail.published.editor);
  editor.undoManager.clear();
  editor.undoManager.add();
  editor.setDirty(false);
  cleanEditorHtml = editor.getContent();
  element("editor-base").textContent = `Base v${editorBaseVersion}`;
  renderNativeState();
}

async function initializeEditor() {
  if (!window.tinymce)
    throw new Error("Self-hosted TinyMCE failed to load. Check /vendor/tinymce assets.");
  const editors = await window.tinymce.init({
    selector: "#wysiwygTextarea",
    license_key: "gpl",
    base_url: "/vendor/tinymce",
    suffix: ".min",
    promotion: false,
    branding: false,
    menubar: "edit view insert format table tools",
    plugins: "lists link image table code searchreplace visualblocks",
    toolbar:
      "undo redo | blocks | bold italic underline strikethrough | forecolor backcolor | bullist numlist | link image table | code visualblocks",
    height: 480,
    resize: true,
    content_css: "/sandbox/editor-content.css",
    body_class: "wiki-content native-content",
    indent: false,
    pad_empty_with_br: true,
    // Keep intentional final breaks; TinyMCE otherwise removes even the seed <p><br></p>.
    remove_trailing_brs: false,
    convert_urls: false,
    entity_encoding: "raw",
    noneditable_class: "mceNonEditable",
    valid_elements:
      "@[id|class|title|style|dir|lang|contenteditable|data-*|aria-*|role],a[href|target|rel|name],abbr,b,blockquote,br,caption,code,col[span|width],colgroup[span|width],dd,del,div,dl,dt,em,figcaption,figure,h1,h2,h3,h4,h5,h6,hr,i,img[src|alt|width|height],kbd,li[value],mark,ol[start|type|reversed],p,pre,s,samp,small,span,strike,strong,sub,sup,table[border|cellpadding|cellspacing|width],tbody,td[colspan|rowspan|headers|width|height|align|valign],tfoot,th[colspan|rowspan|scope|headers|width|height|align|valign],thead,tr[align|valign],u,ul",
    setup(instance) {
      instance.on("change input Undo Redo SetContent", () => {
        if (editor?.initialized) renderNativeState();
      });
    },
  });
  editor = editors[0];
  if (!editor?.initialized) throw new Error("TinyMCE did not initialize a native editor.");
  replaceNativeFromSnapshot();
}

async function saveDraft() {
  const html = editor.getContent();
  const result = await request(`/sandbox/api/pages/${pageId}/draft`, "POST", {
    editor: html,
    generation: editorGeneration,
    baseVersion: editorBaseVersion,
  });
  detail = { ...detail, draft: result.draft };
  cleanEditorHtml = html;
  editor.setDirty(false);
  await refreshSnapshots();
  renderNativeState();
  report(`Draft saved against v${result.draft.baseVersion}. Published content is unchanged.`);
}

async function discardDraft() {
  if (
    !window.confirm(
      "Discard the saved draft and all native working-copy edits? Published content will be retained.",
    )
  )
    return;
  await request(`/sandbox/api/pages/${pageId}/draft`, "DELETE", { generation: editorGeneration });
  await refreshSnapshots();
  replaceNativeFromSnapshot();
  report("Draft discarded. Native editor now contains the published snapshot.");
}

async function publishPage() {
  const html = editor.getContent();
  const publishedVersion = editorBaseVersion + 1;
  const converted = await request("/rest/api/contentbody/convert/storage", "POST", {
    value: html,
    representation: "editor",
    content: { id: pageId },
  });
  await request(`/rest/api/content/${pageId}`, "PUT", {
    id: pageId,
    type: "page",
    title: detail.page.title,
    generation: editorGeneration,
    version: { number: publishedVersion },
    body: { storage: { value: converted.value, representation: "storage" } },
  });
  cleanEditorHtml = html;
  editor.setDirty(false);
  await refreshSnapshots();
  editorBaseVersion = publishedVersion;
  element("editor-base").textContent = `Base v${editorBaseVersion}`;
  renderNativeState();
  renderSnapshot();
  report(`Published v${publishedVersion}. Saved draft cleared; native Undo history retained.`);
}

function bindActions() {
  element("snapshot-kind").addEventListener("change", renderSnapshot);
  element("refresh-snapshot").addEventListener("click", () =>
    operate(async () => {
      await refreshSnapshots();
      report("Snapshots refreshed. Native working copy is unchanged.");
    }),
  );
  element("save-draft").addEventListener("click", () => operate(saveDraft));
  element("discard-draft").addEventListener("click", () => operate(discardDraft));
  element("publish-page").addEventListener("click", () => operate(publishPage));
  element("apply-scenario").addEventListener("click", () =>
    operate(async () => {
      await request(`/sandbox/api/pages/${pageId}/scenario`, "POST", {
        scenario: element("scenario").value,
      });
      await refreshSnapshots();
      report(
        `Scenario applied: ${detail.scenario}. Native working copy and base revision retained.`,
      );
    }),
  );
  element("reset-sandbox").addEventListener("click", () =>
    operate(async () => {
      if (
        !window.confirm(
          "Reset all Lorem pages, published versions, drafts and scenarios? This discards all sandbox edits.",
        )
      )
        return;
      await request("/sandbox/api/reset", "POST", { confirm: "reset-lorem" });
      await refreshSnapshots();
      if (editor?.initialized) replaceNativeFromSnapshot();
      report("Sandbox reset to the original Lorem catalog.");
    }),
  );
  window.addEventListener("beforeunload", (event) => {
    if (!nativeDirty()) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

async function boot() {
  bindActions();
  setBusy(true);
  try {
    await refreshSnapshots();
    element("dashboard").hidden = isPage;
    element("page-workspace").hidden = !isPage;
    if (isPage) {
      element("editor-panel").hidden = !isEditing;
      if (isEditing) await initializeEditor();
    }
    await refreshLogs();
    report(
      isEditing
        ? "Native editor ready. Changes stay local until Save draft or Publish."
        : "Sandbox ready. Only explicit Publish changes published content.",
    );
  } catch (error) {
    report(`Unable to initialize sandbox: ${error.message}`, true);
  } finally {
    setBusy(false);
  }
}

void boot();
