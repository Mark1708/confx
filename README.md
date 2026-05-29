# ConfX

> Browser extension for exporting Confluence and Jira content to Markdown, CSV, images, and ZIP archives. Works through your active browser session -- no separate API token required.

![Status](https://img.shields.io/badge/status-active-111827?style=for-the-badge&labelColor=111827&color=5b5ef4)
![Manifest](https://img.shields.io/badge/manifest-v3-111827?style=for-the-badge&labelColor=111827&color=5b5ef4)
![Runtime](https://img.shields.io/badge/runtime-node.js-111827?style=for-the-badge&logo=nodedotjs&logoColor=5b5ef4)
![License](https://img.shields.io/badge/license-MIT-111827?style=for-the-badge&labelColor=111827&color=5b5ef4)

[Русская версия](README.ru.md)

| Field | Value |
|---|---|
| Status | Active |
| Type | Browser extension / host-page extraction tool |
| Host browsers | Chrome / Chromium, Yandex Browser |
| Primary stack | Manifest V3, React 18, TypeScript, Vite, CRXJS, Tailwind CSS |
| Release artifacts | `confx-chrome.zip`, `confx-yandex.crx`, `SHA256SUMS` |
| Quick verification | `npm ci && npm run typecheck && npm test && npm run build:chrome` |
| Full release verification | `npm ci && npm run release:all` (requires Yandex signing key) |

## What ConfX exports

When you export a page or issue, ConfX produces a ZIP archive:

```text
confluence-page.zip
  README.md                # navigable index for subtree exports
  manifest.json            # source metadata and export metadata
  pages/
    page-title.md          # page or issue content as Markdown
  tables/
    section-table.csv      # extracted tables as CSV
  images/
    image-001.png          # inline images downloaded from the host
  attachments/
    original-file.pdf      # page attachments when export is enabled
```

- **Markdown** -- main page or issue content converted from Confluence/Jira HTML.
- **CSV** -- extracted tables, one file per table.
- **Images** -- inline images downloaded from the host, deduplicated when enabled.
- **Attachments** -- page attachments up to the configured size limit.
- **manifest.json** -- source host, page ID, title, version, space, labels, export timestamp.

## Screenshots

Screenshots will be added before Chrome Web Store publishing.

## Features

- **Page export**: export the current Confluence page as Markdown, CSV tables, images, and a manifest.
- **Space export**: export all pages in a Confluence space when the current page context supports it.
- **Subtree export**: recursively export child pages and generate a navigable `README.md`.
- **Picker**: select a block on the page, preview it, and export only that block.
- **Watch** *(experimental)*: track saved snapshots and inspect changes over time.
- **Jira support**: extract useful Jira issue content when the current tab is a Jira issue.
- **Rule engine**: configure section/table extraction rules for Confluence page conventions.

## Security and privacy

> ConfX reads Confluence and Jira content through your **active browser session cookies**. A separate Confluence or Jira API token is not required.
>
> Development builds currently request **broad HTTP/HTTPS host access** (`https://*/*`, `http://*/*`). Install only trusted release artifacts and always verify checksums against `SHA256SUMS` from the same GitHub Release.

## Install from GitHub Releases

Chrome Web Store publishing is intentionally out of scope for now. GitHub Releases are the distribution channel for the current release flow.

### Chrome / Chromium

1. Download `confx-chrome.zip` and `SHA256SUMS` from the same release.
2. Verify the checksum: `sha256sum -c SHA256SUMS --ignore-missing`.
3. Unzip `confx-chrome.zip`.
4. Open `chrome://extensions`.
5. Enable **Developer Mode** (toggle in the top-right corner).
6. Click **Load unpacked**.
7. Select the extracted folder that contains `manifest.json` at its root.

### Yandex Browser

1. Download `confx-yandex.crx` and `SHA256SUMS` from the same release.
2. Verify the checksum: `sha256sum -c SHA256SUMS --ignore-missing`.
3. Open `browser://tune`.
4. Drag `confx-yandex.crx` into the browser window.

## Usage

### Export a Confluence page

1. Open a Confluence page in your browser.
2. Open the ConfX side panel (click the ConfX icon in the toolbar).
3. Choose an extraction preset if needed.
4. Click **Export**.
5. Save the generated ZIP file.

### Export a block with the picker

1. Open a Confluence page in your browser.
2. Open the ConfX side panel and click **Launch picker**.
3. Hover over the page to highlight the target block. Use `[` / `]` to adjust the selection level. Press `Esc` to cancel.
4. Click the block to select it.
5. In the side panel, click **Export block**.
6. Save the generated ZIP file.

### Export a Jira issue

1. Open a Jira issue in your browser.
2. Open the ConfX side panel (click the ConfX icon in the toolbar).
3. Click **Export**.
4. Save the generated ZIP file.

## Requirements

- **Node.js 22** (matches the CI workflow).
- **npm** (bundled with Node.js).
- **Chrome / Chromium** -- for Chrome local builds and smoke checks.
- **Yandex Browser** -- for Yandex CRX smoke checks (optional).
- **OpenSSL** -- for local Yandex signing key generation (optional).

## Local development

```sh
npm ci
npm run dev
```

Chrome development build:

```sh
npm run build:chrome
```

Load `dist/` from `chrome://extensions` with Developer Mode enabled.

Yandex development build requires a local signing key:

```sh
npm run gen:key:yandex
npm run release:yandex
```

The generated local key is only for development unless your team explicitly promotes it to the release key.


## GitHub Actions distribution

The release workflow builds both artifacts and publishes them as workflow artifacts. For `v*` tags it also attaches them to a GitHub Release.

Required secret and release variable:

| Name | Type | Purpose |
|---|---|---|
| `YANDEX_CRX_PRIVATE_KEY_B64` | GitHub Actions secret | Base64-encoded private signing key for `confx-yandex.crx`. |
| `YANDEX_EXTENSION_ID` | Workflow env / secret override | Expected Yandex extension ID. |

The workflow writes the private key to a temporary file, uses it only for the Yandex build, validates the computed extension ID, and removes the file at the end of the job.

## Browser support

| Capability | Chrome / Chromium | Yandex Browser |
|---|---|---|
| Manifest V3 | Supported | Supported |
| Primary UI | Side panel | Popup fallback / compatible extension UI |
| `side_panel` manifest entry | Present | Present for compatibility |
| `action.default_popup` | Not included | Included in the Yandex target |
| Direct GitHub artifact | `confx-chrome.zip` | `confx-yandex.crx` |
| Extension ID stability | Managed by install channel | Depends on the Yandex signing key |

## Verification

### Local verification (no private keys required)

```sh
npm ci
npm run typecheck
npm test
npm run build:chrome
```

### Full release verification (requires Yandex signing key)

```sh
npm run release:all
```

`release:all` requires `YANDEX_KEY_PATH` or a local `keys/yandex.pem` file.

Chrome ZIP root check:

```sh
python3 - <<'PY'
import zipfile

with zipfile.ZipFile('release/confx-chrome.zip') as archive:
    assert 'manifest.json' in archive.namelist()
PY
```

Manual browser smoke checks before a public release:

1. Load `dist/` in Chrome and verify the side panel at 320-360px and 480px.
2. Install `release/confx-yandex.crx` in Yandex Browser and verify the popup fallback opens.
3. Export one Confluence page and confirm the ZIP contains Markdown and manifest files.

## Troubleshooting

| Problem | Check |
|---|---|
| Chrome ZIP does not install | Ensure the archive was extracted and `manifest.json` is in the selected folder root. |
| Yandex release fails | Check `YANDEX_KEY_PATH` or local `keys/yandex.pem`. |
| Yandex extension ID changed | Verify the signing key and `YANDEX_EXTENSION_ID`. A different key creates a different extension identity. |
| Side panel looks clipped | Use the latest release; narrow Chrome side panel layouts are explicitly supported. |
| Export fails on a page | Confirm you are logged in to Confluence/Jira in the same browser profile. |

## Project structure

```text
src/
  manifest.ts              # MV3 manifest generated by CRXJS
  background/              # service worker and browser UI routing
  content/                 # picker and injected page controls
  sidepanel/               # React side panel and popup UI
  options/                 # rule/settings editor
  viewer/                  # Markdown viewer page
  lib/                     # extraction pipeline
  types/                   # shared TypeScript models
scripts/
  zip-chrome.mjs           # Chrome ZIP artifact
  pack-yandex.mjs          # signed Yandex CRX artifact
  checksums.mjs            # SHA256SUMS generation
```

## Status

ConfX is active and maintained as a browser extension release flow. Chrome Web Store publishing is planned separately and is not part of the current automation.

## License

MIT
