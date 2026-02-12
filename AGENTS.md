# AGENTS.md

Guidelines for AI agents working on this project.

## Project Overview

Pre-post is a library and Claude Code skill for capturing visual pre/post comparisons of web pages. It detects affected routes from git diffs, screenshots URLs using Playwright, and generates PR-ready markdown with uploaded images.

Forked from [vercel-labs/before-and-after](https://github.com/vercel-labs/before-and-after) by James Clements.

## Directory Structure

This is a pnpm workspace monorepo with two packages:

```
pre-post/
├── src/                       # Core library (npm package: pre-post)
│   ├── index.ts              # Main exports, BeforeAndAfter class
│   ├── types.ts              # TypeScript types (DetectedRoute, CompareOptions, etc.)
│   ├── browser.ts            # Playwright browser management (captureScreenshot, closeBrowser, readScreenshot)
│   ├── capture.ts            # Screenshot capture (captureBeforeAfter, captureResponsive)
│   ├── routes.ts             # Route detection entry point (detectRoutes, detectFramework, getChangedFiles)
│   ├── routes/               # Framework-specific route detection
│   │   ├── nextjs.ts         # Next.js App Router + Pages Router detection
│   │   └── generic.ts        # Remix, SvelteKit, and generic fallback
│   ├── viewport.ts           # Viewport presets (desktop, mobile, tablet)
│   ├── filename.ts           # Semantic filename generation with timestamps
│   ├── clipboard.ts          # Cross-platform clipboard access
│   ├── upload.ts             # Upload: git-native default (uploadGitNative, commitAndPushScreenshots), adapter fallbacks
│   └── bin/
│       └── cli.ts            # CLI entry point (detect, compare, run subcommands)
├── tests/                     # Library tests (Vitest)
│   ├── unit/                 # Unit tests (no browser needed)
│   │   ├── routes.test.ts    # Route detection tests (55 cases)
│   │   ├── browser.test.ts   # readScreenshot tests
│   │   ├── viewport.test.ts  # Viewport preset tests
│   │   ├── filename.test.ts  # Filename generation tests
│   │   ├── clipboard.test.ts # Clipboard tests
│   │   ├── from-images.test.ts # Image processing tests
│   │   └── url-normalize.test.ts # URL normalization tests
│   ├── browser/              # Browser-based tests (require TEST_BROWSER=true)
│   │   └── capture.test.ts   # Playwright capture tests
│   ├── integration/          # Full workflow tests
│   │   ├── cli.test.ts       # CLI integration tests
│   │   ├── full-workflow.test.ts # BeforeAndAfter class E2E tests
│   │   └── upload.test.ts    # Upload adapter tests
│   └── fixtures/
│       └── pages/            # HTML test pages (before/after pairs)
├── skill/                     # Claude Code skill definition
│   ├── SKILL.md              # Skill instructions (orchestration brain)
│   └── scripts/
│       ├── upload-and-copy.sh # Upload images + copy markdown to clipboard
│       └── adapters/         # Storage adapter scripts (git-native, 0x0st, blob, gist)
├── site/                      # Marketing website (Next.js)
│   ├── app/                  # Next.js App Router pages
│   ├── components/           # React components (hero, browser, logo, etc.)
│   ├── hooks/                # React hooks
│   ├── lib/                  # Utilities
│   ├── styles/               # CSS
│   ├── public/               # Static assets + test fixtures
│   └── package.json          # Site dependencies
├── .mcp.json                  # Playwright MCP server configuration
├── package.json               # Root package (library)
└── pnpm-workspace.yaml        # Workspace configuration
```

## Key Workflows

### Taking Screenshots

Pre-post uses Playwright programmatically (not as a CLI tool):

```typescript
import { captureScreenshot, closeBrowser } from './browser';

const image = await captureScreenshot(url, {
  viewport: { width: 1280, height: 800 },
  selector: '.card',       // optional: capture specific element
  fullPage: false,         // optional: full page screenshot
});
// image is a Buffer containing a PNG at 2x retina resolution
await closeBrowser();
```

Key behaviors:
- `deviceScaleFactor: 2` -- all screenshots are retina quality (image dimensions = 2x viewport)
- `waitUntil: 'networkidle'` -- waits for all network requests to finish
- `document.fonts.ready` -- waits for web fonts to load
- CSS animations/transitions are disabled for consistent captures

### Route Detection

Detect affected routes from git changes:

```typescript
import { detectRoutes, getChangedFiles, detectFramework } from './routes';

const files = getChangedFiles('main...HEAD');
const framework = detectFramework('.');
const routes = detectRoutes(files, framework);
// routes: [{ path: '/dashboard', sourceFile: 'app/dashboard/page.tsx', confidence: 'high', reason: '...' }]
```

Or via CLI:

```bash
npx pre-post detect
```

### Uploading for PR Comments

By default, screenshots are committed directly to the PR branch under `.pre-post/` and served via `raw.githubusercontent.com` (git-native upload). This requires no external services.

```bash
./skill/scripts/upload-and-copy.sh before.png after.png --markdown
```

Outputs centered markdown table and copies to clipboard. Screenshots auto-append to the PR body, newest on top.

To use an external adapter instead (e.g., 0x0.st):

```bash
IMAGE_ADAPTER=0x0st ./skill/scripts/upload-and-copy.sh before.png after.png --markdown
```

### Adding New Storage Adapters

1. Create `skill/scripts/adapters/<name>.sh`
2. Script must:
   - Accept file path as `$1`
   - Print uploaded URL to stdout
   - Exit 0 on success, non-zero on failure
3. Use via `IMAGE_ADAPTER=<name>`

Available adapters: `git-native` (default), `0x0st`, `blob`, `gist`

## Testing

```bash
# Install dependencies
npx pnpm install

# Build the library
npx pnpm build

# Run all unit + integration tests (no browser needed)
npx pnpm test

# Run browser-dependent tests (requires Playwright browsers)
TEST_BROWSER=true npx pnpm test
```

Browser-dependent tests are wrapped with `it.skipIf(!playwrightAvailable)` and only run when `TEST_BROWSER=true` is set. This keeps the default test suite fast and CI-friendly.

Test pages are in `tests/fixtures/pages/`. Each scenario has `before.html` and `after.html`.

## Development

```bash
# Install all dependencies
npx pnpm install

# Build the library
npx pnpm build

# Run tests in watch mode
npx pnpm test -- --watch

# Run the marketing site
cd site && npx pnpm dev
```

## Conventions

- Screenshots saved to `~/Downloads/` by default, with semantic filenames (e.g., `pre-2025-02-11T18-00-00.png`)
- PR markdown uses centered alignment (`|:------:|`) for GitHub compatibility
- All screenshots are 2x retina (`deviceScaleFactor: 2`), so image pixel width = 2 * viewport width
- Adapters are standalone bash scripts with no dependencies beyond curl/gh
- Route detection confidence levels: `high` (direct page file), `medium` (layout/component), `low` (global style)
- Routes are deduplicated by path (keeping highest confidence) and capped at 5 by default

## Architecture Notes

### Browser Module (`src/browser.ts`)
Manages a singleton Playwright browser + page instance. The page is reused across captures with viewport resized as needed. Always call `closeBrowser()` when done.

### Route Detection (`src/routes.ts` + `src/routes/`)
Pure functions that map file paths to route paths. No I/O except `getChangedFiles()` which shells out to `git diff`. The module auto-detects framework by checking for `app/` vs `pages/` directories.

### Capture Module (`src/capture.ts`)
High-level capture functions that compose browser.ts primitives. `captureBeforeAfter()` captures a pair; `captureResponsive()` captures one URL at multiple viewports.

### Skill (`skill/SKILL.md`)
The orchestration layer for Claude Code. Handles: dev server detection, production URL validation, route detection + Claude refinement, screenshot capture, user approval, and PR markdown posting. Uses either the CLI (`npx pre-post compare`) or Playwright MCP tools.

### MCP Configuration (`.mcp.json`)
Configures the Playwright MCP server for Claude Code integration, enabling browser automation tools (`browser_navigate`, `browser_take_screenshot`, etc.) when working in this repo.
