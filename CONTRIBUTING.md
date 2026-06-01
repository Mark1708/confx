# Contributing to ConfX

Thank you for your interest in ConfX. Contributions are welcome.

## Development setup

**Requirements:** Node.js 22 or later.

```sh
git clone <repo-url> && cd confx
npm ci
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
npm run typecheck
npm test
npm run lint
npm run format:check
npm run build:chrome
```

Or as a single command:

```sh
npm ci && npm run typecheck && npm test && npm run build:chrome
```

## Code style

ConfX uses ESLint and Prettier. Configuration is in `eslint.config.js` and `.prettierrc`.

```sh
npm run lint          # check for lint errors
npm run lint:fix      # auto-fix lint errors
npm run format:check  # check formatting
npm run format        # auto-format
```

## Testing

All new code must have tests. The project targets 80% or higher coverage.

```sh
npm test              # run tests
npm run test:coverage # run tests with coverage report
npm run test:watch    # run tests in watch mode during development
```

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
