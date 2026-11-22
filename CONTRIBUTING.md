# Contributing to ConfX

Thank you for your interest in ConfX. Contributions are welcome.

## Development setup

**Requirements:** Node.js 22.12 or later.

```sh
git clone <repo-url> && cd confx
npm install
```

Run the development server:

```sh
npm run dev
```

Build for Chrome:

```sh
npm run build:chrome
```

Load the `dist/` directory from `chrome://extensions` with Developer Mode enabled.

## Project structure

```text
src/
  background/   MV3 service worker and browser UI routing
  content/      Picker and injected page controls (floating buttons)
  sidepanel/    React side panel UI and extraction entry points
  options/      Rule and settings editor
  viewer/       Markdown viewer page
  lib/          Extraction pipeline, API clients, shared utilities
  types/        Shared TypeScript type definitions
scripts/        Build and release scripts (ZIP, CRX, checksums)
```

## Making changes

1. Create a branch from `main`.
2. Make your changes.
3. Run the full verification suite before opening a PR:

```sh
npm install
npm run check:privacy
npm run typecheck
npm test
npm run test:sandbox
npm run lint
npm run format:check
npm run build:chrome
npx playwright install chromium
SANDBOX_E2E_PORT=4187 npm run test:sandbox:e2e
YANDEX_EXTENSION_ID=cjhpodjghfokdfoljmfbgibjjfpafdip npm run build:yandex
```

## Code style

ConfX uses ESLint and Prettier. Configuration is in `eslint.config.js` and `.prettierrc`.

```sh
npm run lint          # check for lint errors
npm run lint:fix      # auto-fix lint errors
npm run format:check  # check formatting
npm run format        # auto-format
```

### Icon artwork

`src/assets/icon.svg` is the geometry source. After editing it or the colors in
`src/lib/appearance.css`, run `npm run icons:generate` with bundled Chromium installed.
The explicit development command renders every PNG at its actual size, resolving the
shared CSS tokens for all modes/palettes. Commit the generated assets with the source.
Ordinary builds consume those assets and do not require Chromium or regenerate icons.
Check the native 16/20px toolbar, both modes and all palettes. For System, close ConfX UI,
keep a normal host page visible and change its actual media preference; also check a
visible extension page. Offscreen is only an initial sample and must close after reading.
The browser extension-manager icon is static; only the action icon follows appearance.

## Testing

Coverage gates are defined in `vitest.config.ts`. New checks must cover user-visible behavior and must not lower those gates. The Yandex build above is unsigned and does not require a signing key.

```sh
npm test              # run tests
npm run test:coverage # run tests with coverage report
npm run test:watch    # run tests in watch mode during development
```

## Release checklist

`0.3.0` is the current stable release. Keep the existing package version until the
next release is approved; review [CHANGELOG.md](CHANGELOG.md) first.
Preparation alone does not authorize committing, tagging, pushing, packaging or signing.

- [ ] Review the complete diff and untracked files. Keep authored source, tests,
  workflows, docs and intended assets; exclude local IDE state, dependencies,
  `dist/`, `dist-yandex/`, generated JS/type/build caches, local reports/browser profiles,
  `.env*` secrets and private signing keys. Do not confuse authored config JS with
  emitted JS. `.gitignore` does not untrack files or prove history is clean.
- [ ] Review public fixture/media privacy separately from the fixture guard, including
  OCR and visual review of intended README media. Explicitly stage only reviewed paths,
  including intended icon assets and both README GIFs; do not use blanket staging.
  Include `package-lock.json` whenever dependencies or package metadata change, and
  ensure `package.json`, lock root and `packages[""].version` all agree.
- [ ] Run the full verification suite under **Making changes** after integration,
  plus the release guard smoke matrix below. Treat checks as required, not already
  passed remotely. Record the exact source revision and outcomes.
- [ ] Run `npm audit --omit=dev` and `npm audit`; both must report 0 known
  vulnerabilities before a release. Review any new advisory explicitly instead of
  using `npm audit fix --force`, and keep the Node minimum aligned with the build tooling.
- [ ] Reconfirm manual acceptance on the intended build: all three destinations,
  real OS file/folder selection and cancellation/denial, no overwrite or hidden
  fallback, native panel → workspace → diff → confirmed editor-only apply,
  unchanged/conflict cases, launcher, responsive keyboard UI, and all mode/palette
  combinations. Check System changes with ConfX closed on an eligible visible host
  page and with a visible extension page. Historical Vivaldi/macOS acceptance is
  not Chrome/Yandex native-dialog evidence or acceptance of the final release point.
- [ ] Confirm repository access to `YANDEX_CRX_PRIVATE_KEY_B64` without exposing it,
  and verify it retains the approved `YANDEX_EXTENSION_ID`
  (`cjhpodjghfokdfoljmfbgibjjfpafdip`). Unsigned builds need no private key.
  A missing/mismatched key blocks signing; never generate a replacement identity.
- [ ] Obtain explicit approval of the intended source/assets, candidate notes and
  release point. Commit only when authorized, then require a clean
  `git status --porcelain`. If source changes after checks, repeat affected checks
  before approval. Preserve the approved commit as the immutable release point.
- [ ] Only after separate tag/push/publication authorization, use the matching
  `v0.3.0` tag at that exact commit and the existing release workflow. A branch
  dispatch verifies and uploads Chrome only; dispatch on a matching tag can publish.
  Never move/force-push an approved tag or rerun publication to replace approved
  assets. Fixes need a new reviewed version/release point. Do not commit directly
  to `main` to bypass the repository's review/CI flow.
- [ ] Only when packaging/signing is authorized, validate newly produced root
  manifest versions/layout, Chrome ZIP and Yandex CRX identity/signature/checksums,
  and review remote workflow results and installed artifacts. Existing `release/`
  ZIP/CRX/checksums are older outputs, not refreshed evidence for this candidate.

### Release guard smoke matrix

Run the inline Node guard from `.github/workflows/release.yml` with synthetic metadata
in a temporary directory, not by changing the working package/lock or triggering a
publishing workflow. Required cases (package / lock root / lock `packages[""]`):

| Metadata versions | `RELEASE_REF` | Event | Expected guard result |
| --- | --- | --- | --- |
| `0.3.0` / `0.3.0` / `0.3.0` | `refs/tags/v0.3.0` | push or dispatch | Pass |
| `0.3.0` / `0.3.0` / `0.3.0` | `refs/tags/v0.2.0` | push or dispatch | Reject |
| `0.3.0` / `0.3.0` / `0.3.0` | `refs/tags/v0.3.0-rc.1` | push or dispatch | Reject |
| `0.3.0` / `0.2.0` / `0.3.0` | `refs/tags/v0.3.0` | push | Reject |
| `0.3.0` / `0.3.0` / `0.2.0` | `refs/tags/v0.3.0` | push | Reject |
| `0.3.0` / `0.3.0` / `0.3.0` | `refs/heads/r2` | dispatch | Pass; only verification + Chrome artifact |
| `0.3.0-rc.1` / `0.3.0-rc.1` / `0.3.0-rc.1` | `refs/tags/v0.3.0-rc.1` | dispatch | Reject |
| `banana` / `banana` / `banana` | `refs/heads/r2` | dispatch | Reject |

Also inspect job dependencies: `verify` must need `validate-release`; both build jobs
must need `verify`; Yandex and publish must retain their tag-only conditions.
Local guard success does not prove GitHub Actions scheduling or remote CI success.

## Pull requests

A good PR includes:

- A clear description of what changed and why.
- The verification commands listed above passing locally.
- New tests covering the changed behavior.
- No unnecessary refactoring mixed with the actual change.

## Reporting issues

Use [GitHub Issues](../../issues) to report bugs or request features. Include:

- ConfX version or commit hash.
- Browser and version.
- Steps to reproduce.
- Expected vs actual behavior.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
