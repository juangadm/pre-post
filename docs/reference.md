# Reference

## Commands

```bash
pre-post pr                                  # everything, on the current branch's PR
pre-post pr --before https://acme.com        # pin the baseline (saved to .pre-post.json)
pre-post pr --local                          # build both sides locally; ignore deployments
pre-post pr --no-local-baseline              # never build the base commit locally
pre-post pr --routes /pricing,/docs          # explicit routes
pre-post pr --viewports desktop,1440x900     # custom viewports
pre-post pr --require-pr                     # exit quietly when there is no open PR
pre-post pr --dry-run                        # capture + diff locally, post nothing
pre-post pr --json                           # machine-readable output

pre-post https://acme.com http://localhost:3000 --routes /pricing   # ad-hoc comparison
pre-post before.png after.png                # diff two images
pre-post detect                              # which routes does this branch touch?
pre-post login https://staging.acme.com      # sign in once; the session is reused
pre-post prune --days 90                     # clean up the assets branch
pre-post doctor                              # browser, token, dev server, config
```

`pre-post --help` lists every flag.

## Exit codes

| code | meaning |
|---|---|
| 0 | done; for `doctor`, `pre-post pr` can run |
| 1 | the run failed — every capture errored, or an unexpected error; for `doctor`, a required check failed |
| 2 | the arguments could not be parsed |
| 3 | something needs a human; the message says what (log in, start the dev server, pass `--before`) |

Re-running after a code 3 picks up where it left off.

`doctor` marks a check **FAIL** only when `pre-post pr` has no way to proceed without it —
the browser, a GitHub token, and being inside a git repository. Everything else prints as
**note**: no dev server running, or no `--before` saved, narrows *which* strategy a run
picks rather than stopping it.

## `.pre-post.json`

Optional, in the repo root. Every field is optional.

```json
{
  "before": "https://acme.com",
  "routes": ["/"],
  "samples": { "/blog/[slug]": "/blog/hello-world" },
  "viewports": ["desktop"],
  "fullPage": true,
  "maxHeight": 2400,
  "scale": 2,
  "threshold": 0.001,
  "minChangedArea": 100,
  "maxRoutes": 6,
  "ignore": ["apps/docs"],
  "headers": {},
  "assetsBranch": "pre-post-assets",
  "baselineSetup": "pnpm run build:packages"
}
```

**`samples`** gives one example URL per dynamic route, so it can be captured.

**`baselineSetup`** runs in the app directory between the install and the dev server when the
baseline is built from source — a workspace build, a codegen step. In a turborepo it is
inferred (`turbo run build --filter=<app>^...`); setting it turns the guess off. A command
that fails stops the run with one instruction, rather than quietly comparing against
something else.

**Env files** copied into the baseline's worktree get their origin variables rewritten to the
port the baseline actually listens on, so an auth-gated app does not reject its own
callbacks. Only names that can only mean the app's own address are rewritten —
`BETTER_AUTH_URL`, `NEXTAUTH_URL`, `AUTH_URL`, `APP_URL`, `SITE_URL`, `CANONICAL_URL` and
their `_ORIGIN`/`_BASE_URL` forms, with an optional `NEXT_PUBLIC_` / `VITE_` / `PUBLIC_`
prefix. Generic names like `BASE_URL`, `SERVER_URL`, `PUBLIC_URL` and `DATABASE_URL` are left
alone.

## Environment variables

| Variable | Purpose |
|---|---|
| `PRE_POST_GH_TOKEN` | GitHub token read before the two below. Use it where a hosted environment sets `GH_TOKEN` itself |
| `GH_TOKEN` / `GITHUB_TOKEN` | GitHub token (default: `gh auth token`) |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Bypass Vercel Deployment Protection on preview and production URLs |
| `PRE_POST_CONCURRENCY` | Parallel pages (default 6) |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | Use a specific Chromium binary |
| `GH_REPO` | `owner/repo` when the remote URL cannot be parsed |

## Library

```ts
import { runPr, captureScreenshot, diffImages, detectRoutesForRepo } from '@juangadm/pre-post';
```
