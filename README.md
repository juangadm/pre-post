# pre-post

Before/after screenshots for pull requests. One command detects the routes your branch
changed, captures each one before and after, uploads the images to GitHub, and puts them at
the top of the PR description where a reviewer can judge them at a glance.

It works out both sides itself, cheapest option first:

| | Pre (the baseline) | Post (this branch) |
|---|---|---|
| 1 | `--before` | `--after` |
| 2 | `before` in `.pre-post.json` | the preview deployment for this commit |
| 3 | the production deployment for the base commit | a local dev server |
| 4 | whatever is on production now | |
| 5 | the base commit, served locally | |

Rows 2 to 4 need no dev environment at all, which is the point: a preview deployment and a
production URL are enough for anyone who can open the PR. Deployments come from the GitHub
Deployments API, so Vercel, Cloudflare Pages, Netlify and Render all work with no extra
token and nothing to configure; a host that records only a commit status is read from the
deployment bot's own PR comment instead. Row 4 covers repositories that do not deploy every
push to their default branch, so nothing is deployed at the fork point — it prints which
commit Pre actually came from rather than implying the base.

pre-post never guesses a baseline. If no deployment can be found it says so and tells you
the one flag that fixes it, because a baseline that is quietly the wrong site reads as 100%
changed on every route and looks exactly like a real result.

The last baseline needs no network at all: it checks the base commit into a throwaway
worktree and boots its dev script. That keeps pre-post working inside a sandboxed agent
container, a CI job, or behind an egress allowlist — and it compares against exactly what
the branch forked from, rendered in the same browser as the Post side.

> Originally forked from [before-and-after](https://github.com/vercel-labs/before-and-after) by James Clements / Vercel Labs.

```
$ npx -y @juangadm/pre-post@latest pr

Routes (nextjs-app, 41ms): /, /pricing
  /                           medium src/app/page.tsx imports src/components/ui/button.tsx (2 hops)
  /pricing                    medium src/app/pricing/page.tsx imports src/components/ui/button.tsx (2 hops)
Capturing 8 screenshots (2 route(s) × 2 viewport(s)) ...
  changed  /pricing @ mobile (1.42%, 1811ms)
  changed  /pricing @ desktop (0.64%, 2036ms)
  same     / @ mobile (0.00%, 1990ms)
  same     / @ desktop (0.00%, 2211ms)
Publishing 10 image(s) to acme/web@pre-post-assets ...
Updated PR description: https://github.com/acme/web/pull/42
pre-post · PR #42 · 2 route(s) · 2 viewport(s) · 6.8s
  /         desktop  no change
  /         mobile   no change
  /pricing  desktop  0.64% changed
  /pricing  mobile   1.4% changed
Comment: https://github.com/acme/web/pull/42
```

## How it works

1. **Routes.** Diffs the branch against the merge base with `main` — fetching that branch
   first when the checkout does not have it, which is the normal shape in CI and in the
   web/sandbox editors. When no shared history can be established it stops with one
   sentence rather than reporting an empty diff, and `--base <ref>` names the commit
   directly. Then it follows the import
   graph: a change to `components/ui/button.tsx` marks every page that imports it. Next.js
   App Router and Pages Router, Vite apps (React Router, file-based `src/pages`), and a
   generic fallback. Monorepos are handled by picking the app that owns the changed files.
2. **Capture.** Playwright + Chromium headless shell. The page's own clock is held
   still while it loads and then run forward by a fixed budget, so a page that animates
   on a timer is photographed at the same frame on both sides however fast each host
   answered. Reduced motion, animations finished, caret hidden, fonts and images settled,
   layout stable, lazy content primed. 2x device scale, full page (capped at 2400 CSS
   px), desktop (add mobile with `-r`).
   All routes and viewports run concurrently.
3. **Diff.** Pure-JS pixel comparison in worker threads. Reports the percentage changed,
   the bounding box, and a tight crop of the changed region. A route counts as changed when
   the painted difference covers at least `minChangedArea` CSS pixels² (default 100, roughly
   a third of a 16px icon) or at least `threshold` of the canvas — the first rule is what
   decides on a page, the second on a small image.
4. **Layout shift.** A padding change near the top of a page moves everything below it, and
   pixel diffing counts every moved pixel as changed: a change a designer would call
   "slightly roomier" reads as most of the page repainted, and the crop is suppressed just
   when it would be most useful. So the two sides are checked for a single vertical offset
   first — how far the content moved, and from which row. When one is found, Pre is re-spaced
   into Post's layout and the two are compared there: the crop comes from that pair, and the
   comment says `Content shifted down 48px` instead of quoting a percentage. Rows Post gained
   are left as background rather than skipped, so content inserted above the shift — the
   banner that caused it — still reads as new rather than as nothing. The offset is only
   accepted when it accounts for most of the difference across the rows both sides share.
   The raw numbers are left alone: a move is a visual change, and reporting less of one would
   hide it. Reflow, where content moves both across and down, has no single offset to find,
   so it is reported the way it always was.
5. **Publish.** Images go to a `pre-post-assets` branch in the same repository via the GitHub
   API, as one commit per run. Nothing is committed to the PR branch, no CI is triggered,
   and the blob URLs render on private repos — a screenshot is visible to exactly whoever
   can see the repository. `pre-post prune` removes images for PRs closed more than 90 days
   ago, but note that it commits a deletion rather than rewriting history: the older commits
   still hold the blobs, so a link handed out earlier keeps working. Treat anything captured
   as permanent, and think twice before pointing pre-post at a preview holding real data.
6. **Describe.** The images go in a delimited block at the top of the PR description,
   replaced in place on every run and leaving your own text untouched. Changed routes show
   a Pre/Post crop with the full page collapsed underneath; unchanged routes fold into a
   single line. If the PR cannot be edited — a fork, a read-only token — it falls back to
   one sticky comment.

## Install

Nothing to install. `npx -y @juangadm/pre-post@latest pr` downloads the CLI and, on first
use, the Chromium headless shell (~80 MB). You need Node 20+ and a GitHub token: either
`gh auth login` or `GH_TOKEN`.

As a Claude Code skill:

```bash
npx skills add juangadm/pre-post -y
```

Then say `/pre-post` after making UI changes.

## Usage

```bash
pre-post pr                                  # everything, on the current branch's PR
pre-post pr --before https://acme.com        # pin the baseline (saved to .pre-post.json)
pre-post pr --no-local-baseline              # never build the base commit locally
pre-post pr --routes /pricing,/docs          # explicit routes
pre-post pr --viewports desktop,1440x900     # custom viewports
pre-post pr --dry-run                        # capture + diff locally, post nothing
pre-post pr --json                           # machine-readable output

pre-post https://acme.com http://localhost:3000 --routes /pricing   # ad-hoc comparison
pre-post before.png after.png                # diff two images
pre-post detect                              # which routes does this branch touch?
pre-post login https://staging.acme.com      # sign in once; the session is reused
pre-post prune --days 90                     # clean up the assets branch
pre-post doctor                              # browser, token, dev server, config
```

When something needs a human, the CLI exits with code 3 and one sentence saying what to do
(log in, start the dev server, pass `--before`). Re-running picks up where it left off.

Results go into a delimited block at the top of the PR description, which re-runs replace in
place, leaving your own text untouched. If the PR cannot be edited — a fork, a read-only
token — it falls back to a single sticky comment.

## Configuration

Optional `.pre-post.json` in the repo root:

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
  "assetsBranch": "pre-post-assets"
}
```

Environment:

| Variable | Purpose |
|---|---|
| `GH_TOKEN` / `GITHUB_TOKEN` | GitHub token (default: `gh auth token`) |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Bypass Vercel Deployment Protection on preview and production URLs |
| `PRE_POST_CONCURRENCY` | Parallel pages (default 6) |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | Use a specific Chromium binary |
| `GH_REPO` | `owner/repo` when the remote URL cannot be parsed |

## Library

```ts
import { runPr, captureScreenshot, diffImages, detectRoutesForRepo } from '@juangadm/pre-post';
```

## Development

```bash
pnpm install
pnpm build
pnpm test:unit
TEST_BROWSER=true pnpm test        # needs a Chromium; npx playwright-core install chromium-headless-shell
```

## License

MIT
