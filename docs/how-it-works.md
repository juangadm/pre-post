# How it works

## Choosing Pre and Post

pre-post works out both sides itself, cheapest option first:

| | Pre (the baseline) | Post (this branch) |
|---|---|---|
| 1 | `--before` | `--after` |
| 2 | `before` in `.pre-post.json` | the preview deployment for this commit |
| 3 | the production deployment for the base commit | a local dev server |
| 4 | whatever is on production now | |
| 5 | the base commit, served locally | |

Rows 2 to 4 need no dev environment at all: a preview deployment and a production URL are
enough for anyone who can open the PR. Deployments come from the GitHub Deployments API, so
Vercel, Cloudflare Pages, Netlify and Render all work with no extra token and nothing to
configure; a host that records only a commit status is read from the deployment bot's own PR
comment instead. Row 4 covers repositories that do not deploy every push to their default
branch — it prints which commit Pre actually came from rather than implying the base.

pre-post never guesses a baseline. If no deployment can be found it says so and names the
one flag that fixes it, because a baseline that is quietly the wrong site reads as 100%
changed on every route and looks exactly like a real result.

The last baseline needs no network at all: it checks the base commit into a throwaway
worktree and boots its dev script. That keeps pre-post working inside a sandboxed agent
container, a CI job, or behind an egress allowlist — and it compares against exactly what the
branch forked from, rendered in the same browser as the Post side. `--local` skips
deployments entirely and builds both sides this way.

## The pipeline

1. **Routes.** Diffs the branch against the merge base with `main` — fetching that branch
   first when the checkout does not have it, which is the normal shape in CI and in
   web/sandbox editors. When no shared history can be established it stops with one
   sentence rather than reporting an empty diff; `--base <ref>` names the commit directly.
   Then it follows the import graph: a change to `components/ui/button.tsx` marks every page
   that imports it. Supports Next.js App and Pages Router, Vite apps (React Router,
   file-based `src/pages`), and a generic fallback. Monorepos are handled by picking the app
   that owns the changed files.
2. **Capture.** Playwright + Chromium headless shell. The page's clock is held still while
   it loads, then run forward by a fixed budget, so a page that animates on a timer is
   photographed at the same frame on both sides. Reduced motion, animations finished, caret
   hidden, fonts and images settled, layout stable, lazy content primed. 2x device scale,
   full page (capped at 2400 CSS px), desktop (add mobile with `--mobile`). All routes and
   viewports run concurrently.
3. **Diff.** Pure-JS pixel comparison in worker threads. Reports the percentage changed, the
   bounding box, and a tight crop of the changed region. A route counts as changed when the
   painted difference covers at least `minChangedArea` CSS px² (default 100, roughly a third
   of a 16px icon) or at least `threshold` of the canvas.
4. **Layout shift.** A padding change near the top of a page moves everything below it, and
   pixel diffing would count every moved pixel as changed. So the two sides are first
   checked for a single vertical offset. When one is found, Pre is re-spaced into Post's
   layout and compared there: the crop comes from that pair, and the PR says
   `Content shifted down 48px` instead of quoting a percentage. Content inserted above the
   shift — the banner that caused it — still reads as new. Reflow, where content moves both
   across and down, has no single offset and is reported as a normal diff.
5. **Publish.** Images go to a `pre-post-assets` branch in the same repository via the
   GitHub API, one commit per run. Nothing is committed to the PR branch, no CI is
   triggered, and the images render on private repos — visible to exactly whoever can see
   the repository. See [Screenshot storage](storage.md).
6. **Describe.** The images go in a delimited block at the top of the PR description,
   replaced in place on every run, leaving your own text untouched. Changed routes show a
   Pre/Post crop with the full page collapsed underneath; unchanged routes fold into a
   single line. A pure layout shift shows the full pages directly under
   `Content shifted down 40px. Nothing else changed.` If the PR cannot be edited — a fork,
   a read-only token — it falls back to one sticky comment.
