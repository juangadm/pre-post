# pre-post optimization plan

Goal: pre-post gives a reviewer the visual answer before they read a line of the
diff. Anyone shipping a front-end change — a PM, a marketer, a designer, an
engineer — runs one command, on an open PR or while preparing one, and the
before/after screenshots for every route the branch touches land at the top of the
PR description, Pre beside Post. Nothing to scroll to, nothing pasted by hand, no
screenshots in model context.

Two properties carry the whole tool. It has to be **fast**: a run finishes while
you are still looking at the PR — seconds, not minutes — because a tool you wait
on is a tool you stop reaching for. And it has to **just work**: the right routes
without configuration, identical pages reported as identical, and an honest
account of anything it could not check. A reviewer who trusts the images stops
opening the preview deployment; one who does not ignores the tool entirely.

## 1. Where the time and tokens go today

The capture engine is already fast. Measured in a clean container against the
bundled fixture pages:

| Measurement | Result |
|---|---|
| 8 screenshots (4 routes, pre and post, pool of 4) | 3.3 s |
| Full Chromium launch vs headless-shell launch | 1236 ms vs 389 ms |
| 2x PNG vs 1x PNG of the same page | 60 KB vs 26 KB |

The multi-minute, six-figure-token runs come from the workflow around it:

1. **Playwright MCP path.** `.mcp.json` registers a Playwright MCP server and
   `SKILL.md` offers it as "Option B". Each navigation through it puts a page
   accessibility snapshot into model context and each screenshot puts an image
   into context. Eight pages this way is 100k+ tokens. The server also loads
   ~20 tool definitions into every session whether used or not.
2. **Approval loops on images.** The skill tells the model to show every
   screenshot and ask before posting. Each image is thousands of tokens; each
   approval is a round trip.
3. **Verbose surface.** A 1,150-word skill file re-read on every invocation,
   plus pretty-printed JSON from `detect` that lists every changed file.
4. **Cold starts.** The package compiles TypeScript on install (`prepare`),
   so `npx` from GitHub builds before running. The browser launcher tries
   system Chrome first, which fails on Linux and costs time.
5. **Uploading by committing to the PR branch.** Slow (commit + push),
   triggers a fresh CI run for a screenshots-only commit, needs push rights,
   and images land on main after merge (main already carries 1x1 test PNGs
   from dogfooding).

Quality gaps:

- **No visual diff.** Nothing says whether pre and post are identical, so
  unchanged routes get posted and the model has to eyeball images.
- **Route detection is regex on file names.** A shared component change maps
  to nothing or to `/`. Vite apps are not recognized.
- **Determinism.** No clock freezing, no wait for images, no lazy-load
  handling on full page, and a Vercel-protected URL silently captures the
  login page as "before".
- **0x0.st fallback** is a public anonymous host and should not exist in a
  company tool.

## 2. Decisions

| Topic | Decision |
|---|---|
| Frameworks | Next.js (App and Pages Router) and Vite apps first; generic fallback stays |
| "Before" | Production URL (what is on main). "After" is the local dev server |
| Storage | Dedicated orphan branch `pre-post-assets` written via the GitHub Contents API. No PR-branch commits, no CI triggers, works on private repos, prunable |
| Output | A delimited block at the top of the PR description, replaced in place on re-run. A sticky comment only when the description cannot be edited. Markdown also printed for manual paste |
| Unchanged routes | Collapsed into a single "no visual change" line so reviewers know they were checked |
| Automation | No GitHub Action for now. The skill is the product; first run must self-heal |
| Login-protected pages | `pre-post login <url>` opens a browser once, the developer signs in, the session is saved locally and reused |
| Resolution | 2x device scale factor. Crisp when a reviewer clicks to enlarge |
| Framing | Full page (height capped) so nothing below the fold is missed. The comment leads with a crop of the changed region; full page is collapsed underneath |
| Browser engine | Keep Playwright + Chromium for fidelity. Switch to `playwright-core` + headless shell. Never let the model drive the browser |
| GIF capture | Parked. Images first |
| Marketing site | Out of scope for this plan |

Why not other engines: Vercel `agent-browser` exists for agents driving a
browser interactively, which is exactly the expensive pattern being removed.
Lightweight engines (Lightpanda and similar) do not render CSS faithfully
enough for pixel comparison. Cloud screenshot APIs cannot reach `localhost`,
which is the "after" state.

## 3. Target architecture

```
/pre-post  (skill, ~40 lines)
   └─ npx pre-post pr [--routes ...]      one process, no model in the loop
        ├─ doctor      browser present? gh authenticated? PR exists? fix or pause with one instruction
        ├─ detect      base-branch diff → import graph → routes (Next.js, Vite, generic)
        ├─ capture     headless shell, one context per viewport, settle-based waits, 2x, full page
        ├─ diff        pixelmatch → % changed, changed-region crop, highlight image
        ├─ publish     Contents API → pre-post-assets branch → blob URLs
        └─ describe    block at the top of the PR description (marker-based
                       upsert; sticky comment only if it cannot be edited)
   └─ prints a ≤15-line summary table; --json for agents
```

The model's entire context cost is the skill text plus the summary table.
It only looks at an image if it chooses to open the optional contact sheet.

## 4. Phases

Each phase ships on its own and is useful alone. Status: all phases implemented in 1.0.0 on this branch; the GIF feature and a CI mode remain parked.

### Phase 1: stop the token bleed (no behavior change)
- Remove the Playwright MCP server from `.mcp.json` and "Option B" from the skill.
- Ship prebuilt `dist/` so `npx` never compiles; drop the `prepare` hook.
- Try headless shell and bundled Chromium before system Chrome.
- Outcome: per-run context falls from 100k+ tokens to a few thousand.
- Risk: none; the CLI path already covers everything Option B did.

### Phase 2: one-shot `pre-post pr`
- New command that runs doctor → detect → capture → diff → publish → comment.
- Compact summary output; `--json` for agents.
- Skill rewritten to ~40 lines: preflight, run the command, relay the summary.
- The model no longer asks for approval per image; the human reviews on GitHub.
- Outcome: a run is one tool call and one short result.
- Risk: posting without a preview. Mitigated by the description block being
  replaceable on re-run and by `--dry-run` printing the markdown only.

### Phase 3: GitHub-native storage
- `publish` writes each image with `PUT /repos/{owner}/{repo}/contents/...`
  on branch `pre-post-assets` (created as an orphan if missing), using the
  `gh` token. Paths are `<pr-number>/<route>-<viewport>-<pre|post|diff>.png`.
- URLs are the existing `github.com/.../blob/<sha>/...?raw=true` form, which
  renders on private repos.
- `pre-post prune --older-than 90d` deletes stale PR folders.
- Remove the 0x0.st and generic blob adapters and the PR-branch commit path.
- Outcome: no PR-branch pollution, no CI re-runs, no push needed.
- Risk: repos that block branch creation by policy. Fallback flag to commit to
  the PR branch stays available but off by default.

### Phase 4: capture quality and determinism
- `playwright-core` + headless shell; one browser context per viewport reused
  across routes.
- Replace fixed 3 s + 2 s waits with a settle check: fonts ready, images
  complete, two consecutive stable animation frames, 500 ms network quiet,
  hard cap 8 s.
- Freeze `Date.now` and animations, hide carets and scrollbars, set
  `prefers-reduced-motion`, scroll through the page once to trigger lazy
  loading before a full-page capture, cap full-page height.
- `--header`, `--cookie`, Vercel deployment-protection bypass header, and the
  saved login session from `pre-post login`.
- Fail loudly on 401/403/5xx instead of capturing an error page.
- Outcome: identical pages produce identical pixels; flaky diffs disappear.
- Risk: pages with intentional motion. `--wait <ms>` remains as an override.

### Phase 5: pixel diff
- `pixelmatch` + `pngjs` (pure JS, no native build).
- Per route/viewport: percent changed, bounding box of the change, highlight
  image, and a padded crop of the changed region from both pre and post.
- Routes under the threshold (default 0.1%) collapse into one line.
- Optional `--contact-sheet` writes one 1x image (pre | post | diff) per
  route for the rare case the model needs to look.
- Outcome: reviewers see exactly what changed; unchanged work makes no noise.

### Phase 6: route detection v2
- Diff against the merge base with the default branch, not `HEAD`.
- Build a lightweight import graph from source files; a changed component
  resolves to every page that imports it, directly or transitively.
- Vite support: React Router route files and `vite.config` presence; a
  `.pre-post.json` in the repo can declare routes and sample values for
  dynamic segments (`/blog/[slug]` → `/blog/hello-world`).
- Outcome: detection is fast, accurate, and covers Vite apps.

### Phase 7: first-run experience
- `doctor` installs the headless shell if missing, checks `gh auth status`,
  finds the dev server port, and resolves the production URL from
  `.pre-post.json`, `homepage` in `package.json`, or a prompt.
- When something needs a human (not logged in to `gh`, page needs a login),
  the CLI stops with one sentence saying exactly what to do, and re-running
  picks up where it left off.
- Outcome: first use is one pause at most; every later use just works.

### Phase 8: cleanup
- Remove `gifenc`, `video.ts`, and the clipboard code path from the skill
  flow; move GIF to a later milestone.
- Update README, AGENTS.md, and tests. Delete the stray 1x1 PNGs from main.

## 5. Targets

| Metric | Today | Target |
|---|---|---|
| Wall clock, 4 routes at 2 viewports, local dev server | minutes | under 30 s |
| Model context per run | 100k+ tokens | under 3k tokens |
| Commits added to the PR branch | 1 per run | 0 |
| CI runs triggered by screenshots | 1 per run | 0 |
| Unchanged routes posted | all | none |
| Human setup on first run | manual | at most one pause |

## 6. Out of scope for now
- GIF/video capture.
- The marketing site.
- A GitHub Action / CI mode (can be added later on top of `pre-post pr`).
