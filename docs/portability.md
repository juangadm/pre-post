# Making pre-post work everywhere

Target environments: a plain terminal (Ghostty, iTerm), Cursor, Claude Code, Codex —
and the web/sandbox version of each. The CLI is the contract; every environment is a
way of invoking it.

Each chunk below is scoped to stand alone as one session. Order is deliberate:
silently-wrong before missing-reach before polish.

Status key: **confirmed** = reproduced in a real environment, evidence noted.
**to verify** = suspected from reading the code; the session starts by proving it.

---

## 1. Shallow clones report "nothing changed" — FIXED

Web and sandbox environments check out a branch with `--depth 1 --single-branch`.
There is then no `origin/main` ref at all, so:

- `defaultBranch()` falls through to the string `'main'`
- `mergeBase()` returns null (both `merge-base` attempts fail on a missing ref)
- `changedFiles()` falls back to `target = 'HEAD'`, which means "uncommitted only"
- a branch whose changes are *committed* therefore shows **zero** changed files

Reproduced against a `--depth 1 --single-branch` clone of this repo carrying a
committed edit to `site/app/page.tsx`:

```
$ pre-post detect
{"framework":"generic","appRoot":".","changedFiles":0,"routes":[],"skippedDynamic":[]}
$ echo $?
0
```

`pre-post pr` would publish "no visual changes" for that branch. This is the exact
failure class as #17: confident, silent, wrong.

**Scope.** Resolve the base three ways, in order: the PR's base SHA from the API when
a PR exists; a fetch that makes the base reachable in a shallow clone (`git fetch
--no-tags --depth=… origin <base>`, deepening if merge-base still fails); the current
local guess. Remove the silent `|| 'HEAD'` fallback — when the base cannot be
resolved, raise `NeedsHumanError` (exit 3) with one sentence, never a clean exit 0.

**Validate.** The shallow clone above must either detect `/` or exit 3. A unit test
per resolution step, and one integration test against a real `--depth 1` clone.

**Size.** M. Touches `git.ts`, `routes.ts`, `comparison.ts`.

**Done.** `resolveBase` in `git.ts` resolves explicit ref → local merge base → a
widening fetch (depth 50, deepen 200, unshallow) → uncommitted-only on the base
branch itself, and returns null rather than guessing. `changedFiles` now requires
its target, so the silent `|| 'HEAD'` cannot come back. Detection carries the base
and hands it to the baseline, so Pre and the route list agree. The clone above now
reports `changedFiles: 4`, route `/`, `base: {sha: 26aa6cd, source: fetched}`;
with the remote removed it exits 3 with one sentence. Seven tests in
`tests/unit/base.test.ts` cover the clone shapes.

---

## 2. The Post side assumes a local dev server — FIXED

**What was actually wrong.** Not the ordering: `resolveComparison` already tried
`deployed` before `local`, so "two deployed URLs" was never a fallback after local serving
failed. The bug was one step inside it. `deployedBaseline` had exactly one way to find Pre —
a successful **production** GitHub Deployment recorded against **exactly `pr.base.sha`** —
while the Post side had two (the Deployments API, and the deploy bot's PR comment). So the
run would find the preview, find no baseline, log *"comparing locally instead"*, and land on
a dev server the person almost certainly does not have. Two reasons that baseline lookup
almost never succeeds:

- Production is a branch, not a commit. A repository has a production deployment at the
  exact fork point only by coincidence.
- Vercel — the most common host for the apps this is pointed at — records **no GitHub
  Deployment at all**. Confirmed on this repo: PR #19's head commit carries one commit
  status (`context: "Vercel"`, `target_url` → the Vercel dashboard) plus a `vercel[bot]`
  comment, and nothing else. That is exactly why `previewUrlFromComments` exists for the
  preview side; the baseline side had no equivalent.

**Reproduced** with the real payload shapes from PR #19, replayed to the built CLI through
`GITHUB_API_URL` (this sandbox's network policy blocks `api.github.com` and `*.vercel.app`,
so the two deployment hosts were local stand-ins). No dev server, no `--before`:

```
$ pre-post pr --no-local-baseline --no-comment
Preview deployment found but no reachable deployed baseline; comparing locally instead.

No preview deployment for this commit and no dev server on the usual ports (3000, 5173, ...).
$ echo $?
3
```

Note the second line: a preview *was* found. The message is the opposite of what happened,
which is the same failure class as #17 — confident and wrong — aimed at the one user who
can do least about it. The control (a production deployment recorded at `base.sha`) produced
a full deployed comparison on the first try, which isolated the fault to the baseline lookup
rather than to the strategy or its ordering.

**Done.** The baseline now has the same breadth the preview always had, tried in order and
always named in the run's output: `--before` → `.pre-post.json` → production deployment for
the base commit → **newest production deployment, whatever commit it was built from** (new
`latestProductionDeployment`, reports that commit rather than implying the base) → **the
site's published address** (new `src/homepage.ts`: the website on the GitHub repository,
then `homepage` in package.json; rejects loopback, non-HTTP and code-host URLs, so a library
whose homepage is its own repo is not screenshotted as if it were the app). Two smaller
things were in the way of the same path: `previewForHead` demanded an open PR, though hosts
build on push, so it now keys on the head commit and uses the PR only for the comment
fallback; and `--dry-run` withheld the GitHub client entirely, making it the one mode that
could never choose a deployment — reads now use `gh`, writes use `writeGh`. The dead-end
error was replaced by `NoDeployedBaselineError`, which names the preview it found and the
one flag that fixes it. The preview is looked up first and alone, so a run with no preview
spends no baseline requests; a deployed run costs six GitHub calls end to end.

**Validated.** Same harness, no dev server, no `--before`: a preview plus a production
deployment at a *different* commit, and a preview plus no deployments at all but a
repository website, both now produce a full comparison (`Pre … Production deployment for
aaaaaaa` / `production site, from the repository homepage`), capture, diff at 99.6%/99.9%,
and markdown — including under `--dry-run`. 261 tests pass with `TEST_BROWSER=true`.

**Found on the way, not fixed here.**

- Nothing sanity-checks the baseline. If the published address resolves to an unrelated site
  (a docs page, a parked domain), every route reads as ~100% changed and the result still
  looks like a real one. A cheap guard — treat "every route changed by ~100%" as a signal
  that the two sides are different sites, and say so instead of publishing — belongs with
  the noise-floor work already listed below.
- `doctor` reports on the dev server and the browser but says nothing about the deployed
  path, so it cannot tell a user whether the zero-setup route is available to them.
- Route detection still needs a git checkout. Someone with no clone at all is out of reach
  of every chunk here; that is a bigger question than portability.

---

## 3. Token discovery checks presence, not capability — to verify

`getToken()` accepts `GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth token`. Sandbox
environments often inject a `GITHUB_TOKEN` scoped to the current repo's Actions
context, which may not permit creating the `pre-post-assets` branch. The failure
would land mid-run, after capture, with a raw API error.

**Scope.** Preflight the token's actual capability in `doctor` and at the start of
`pr` — one cheap authenticated call — and fail with one sentence before spending
30 seconds on screenshots.

**Validate.** A read-only token exits 3 with an actionable sentence before capture.

**Size.** S.

---

## 4. Environment adapters — to verify

The skill in `skill/` is Claude Code-specific. Cursor reads `.cursor/rules`, Codex
reads `AGENTS.md`, a terminal user reads the README. Nothing should fork the
behaviour — the CLI already holds it — but each surface needs its own thin pointer.

**Scope.** One documented invocation per environment, and a check that the CLI needs
nothing environment-specific to run. No new behaviour.

**Validate.** Run the same command by hand in each of the four surfaces.

**Size.** S, mostly docs.

---

## 5. First-run cost in a locked-down sandbox — to verify

First use downloads the Chromium headless shell (~80 MB). A sandbox behind a proxy,
or with no CDN egress, may fail. Confirmed working in Claude Code web: the launcher
found a pre-installed browser via `PLAYWRIGHT_BROWSERS_PATH` and launched as root
without `--no-sandbox`.

**Scope.** Verify the failure message when the download is blocked, and that a
pre-installed browser is always preferred over downloading one.

**Validate.** Run with egress blocked and no cached browser; the error must name the
fix in one sentence.

**Size.** S.

---

## 6. Errors that leak Node internals — confirmed

An unknown flag prints a raw `ERR_PARSE_ARGS_UNKNOWN_OPTION` stack trace:

```
$ pre-post detect --cwd /some/path
TypeError [ERR_PARSE_ARGS_UNKNOWN_OPTION]: Unknown option '--cwd'
    at checkOptionUsage (node:internal/util/parse_args/parse_args:102:13)
    ...
```

Also: `doctor` prints `devserver FAIL` and exits 0, so a caller cannot tell pass from
fail by exit code.

**Scope.** Catch the parse error and print the usage line. Decide and document
`doctor`'s exit-code contract.

**Validate.** Unknown flag exits non-zero with one line and no stack.

**Size.** S.

---

## Already agreed, tracked elsewhere

- Self-cleaning assets branch (cleanup rides along with each publish, instead of a
  `prune` nobody runs).
- Noise floor: capture twice, subtract self-noise, so animation and fonts stop
  reading as changes.
- Honest coverage line: say what was checked *and* what was skipped.
