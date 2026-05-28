# ConfX

> Browser extension for exporting Confluence and Jira content to Markdown, CSV, images, and ZIP archives.

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
| Quick verification | `npm ci && npx tsc --build --force && npx vitest run && npm run release:all` |
| Verification level | Run-confirmed during release maintenance when noted in release notes |

## Screenshots

Screenshots are not included yet. Recommended captures before a public release:

- Chrome side panel at 320-360px width.
- Chrome side panel at 480px width.
- Yandex Browser popup fallback.
- Markdown viewer page.

## Features

- **Page export**: export the current Confluence page as Markdown, CSV tables, images, and a manifest.
- **Space export**: export a Confluence space flow when the current page context supports it.
- **Subtree export**: recursively export child pages and generate a navigable `README.md`.
- **Picker**: select a block on the page, preview it, and export only that block.
- **Watch**: track saved snapshots and inspect changes over time.
- **Jira support**: extract useful Jira issue content when the current tab is a Jira issue.
- **Rule engine**: configure section/table extraction rules for Confluence page conventions.

## Install from GitHub Releases

Chrome Web Store publishing is intentionally out of scope for now. GitHub Releases are the distribution channel for the current release flow.

| Browser | Artifact | Installation path | Notes |
|---|---|---|---|
| Chrome / Chromium | `confx-chrome.zip` | Unzip, then load the unpacked folder from `chrome://extensions` | Developer Mode must be enabled. The ZIP contains `manifest.json` at archive root. |
| Yandex Browser | `confx-yandex.crx` | Drag the CRX into `browser://tune` | The CRX is signed with the ConfX Yandex release key. |

Always download `SHA256SUMS` from the same release and compare checksums before installing manually distributed artifacts.

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

## Release artifacts

```sh
npm run release:chrome   # dist/ -> release/confx-chrome.zip
npm run release:yandex   # dist-yandex/ -> release/confx-yandex.crx
npm run release:all      # builds both artifacts and release/SHA256SUMS
```

`release:all` fails when the Yandex signing key is missing. This is intentional: a complete release must include both browser artifacts.

Generated outputs are ignored and must not be committed:

- `dist/`
- `dist-yandex/`
- `release/`
- `keys/`
- `*.crx`
- `*.zip`
- `*.pem`

## GitHub Actions distribution

The release workflow builds both artifacts and publishes them as workflow artifacts. For `v*` tags it also attaches them to a GitHub Release.

Required secret and release variable:

| Name | Type | Purpose |
|---|---|---|
| `YANDEX_CRX_PRIVATE_KEY_B64` | GitHub Actions secret | Base64-encoded private signing key for `confx-yandex.crx`. |
| `YANDEX_EXTENSION_ID` | Workflow env / secret override | Expected Yandex extension ID. The default release value is `cjhpodjghfokdfoljmfbgibjjfpafdip`. |

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

## Permissions and security

ConfX uses browser session cookies to read Confluence and Jira pages through the active browser context. It does not require a separate Confluence token.

Manifest permissions include tab access, scripting, downloads, storage, and host permissions for HTTP/HTTPS pages. Keep this broad access in mind before installing development builds.

Yandex CRX signing is security-sensitive:

- never commit private keys;
- never paste keys in issues, chat, or documentation;
- store release keys in a secret manager or GitHub Actions secrets;
- validate `YANDEX_EXTENSION_ID` before publishing release artifacts.

## Verification

```sh
npm ci
npx tsc --build --force
npx vitest run
npm run release:all
```

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
