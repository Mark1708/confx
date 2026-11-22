# Changelog

## 0.3.0 — 2026-11-22

Stable release prepared against `v0.2.0`.

### Added

- One export workspace with **Export**, **Update page** and **Watch**, pinned source
  context, remembered per-source drafts and one cancellable export owner. Export
  defaults remain separate from one-off options and the running job.
- Three destinations for Confluence and Jira exports: browser ZIP download, a fresh
  folder, or a new ZIP streamed to disk. Larger exports and filesystem operations
  open a normal extension tab; cancellation or denied access does not silently
  switch destinations.
- A draggable page launcher with per-page/site hiding and live settings; a single
  options page for defaults, language, appearance and advanced settings.
- Independent Light/Dark/System mode and Violet/Blue/Forest/Graphite/Amber palettes,
  live across ConfX surfaces without recoloring the host page. New pixel-sized
  toolbar artwork follows the selected mode/palette. Paired English/Russian README
  demos show real subtree exports in the synthetic Lorem sandbox.

### Fixed

- Source pinning and workspace recovery keep the source page distinct from viewers,
  native panels and workspace tabs; section changes preserve drafts and live cancel.
- Sequential package writing, collection pagination and canonical resource links
  avoid silently truncated exports. Fatal page failures are not reported as ready.
- Disk destinations create unique job-named outputs and reject existing-name
  collisions rather than overwrite files. ZIP readiness waits for writable close;
  interrupted output can remain incomplete and is not reported as ready.

### Security

- The online viewer sanitizes rendered Markdown to passive HTML: no forms, controls,
  frames, styles, event handlers or active URL schemes. Image alt text, link labels
  and destinations are encoded before Markdown rendering; legitimate links, images,
  details, code and tables stay readable.
- Editor updates are validated in an isolated world and injected only into the
  browser-validated document of the open Confluence editor. Navigation or disposal
  during conversion fails closed and never delivers private edits to a replacement
  document. Requires Chrome 106+ document targeting; there is no unpinned fallback.
- A fatal failure in one parallel source read cancels its in-flight siblings, and the
  export keeps its lock until they settle; a failed job aborts outstanding work. The
  viewer cancels pending reads on unmount.
- Console warnings for failed image and attachment downloads contain only a reason and
  status, never signed URLs, attachment titles or raw errors. The package manifest
  keeps its intentional resource fields.
- Build and test tooling was updated (Vite 7.3, Vitest 4.1.12, plugin-react 4.7) and
  DOMPurify 3 was added for the viewer; `npm audit` reports 0 known vulnerabilities.
  Node.js 22.12 or later is now required.

### Changed / migration

- Settings migrate append-only: v4→v5 preserves effective export rules and introduces
  explicit export defaults; v5→v6 adds the palette without rebuilding those defaults.
  Existing Light/Dark choices keep Violet. Newer settings versions are preserved.
- The manifest adds `offscreen` for a one-shot initial System-theme sample, closed
  after reading. Broad HTTP(S) host access remains; content reads still use the
  active browser session, not a separate API token. Review browser permission prompts.
- Release validation requires stable numeric `X.Y.Z`, matching package/lock root
  versions and an exact `vX.Y.Z` tag before verification/build/sign/publish. Branch
  dispatch remains verification plus a Chrome artifact, not a public release.

### Removed / migration

- Bulk Markdown creation, updates and publishing are removed, not deferred. Use
  read-only bulk export instead. Apply each `editable.md` only to its matching open
  Confluence editor after diff review and explicit confirmation; ConfX does not
  publish the page or upload attachments. Jira remains export-only.

### Acceptance limits

- Recorded R2 native acceptance covers **Vivaldi on macOS**, including OS folder/file
  selection, permission refusal and editor-only apply. It does not establish native
  Chrome/Yandex dialog coverage. OPFS automation and README GIFs are not
  native-dialog evidence.
- System toolbar updates require a visible eligible HTTP(S) page with the content
  script or a visible ConfX window; browser-internal-only sessions wait for an
  eligible page. The extension-manager icon stays static Dark + Violet.
- Directory cancellation leaves closed files and a terminal marker; interrupted disk
  ZIPs may remain incomplete. Ordinary downloads retain compressed data in memory;
  disk exports still materialize the current page/resources, and Jira search keeps
  aggregate text/JSON. No measured speedup or heap bound is promised.
