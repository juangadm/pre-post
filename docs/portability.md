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

## 2. The Post side assumes a local dev server — PARTLY FIXED

**What was claimed, and what the evidence actually said.** The chunk suspected that "two
deployed URLs" was a fallback after local serving failed. It was not: `resolveComparison`
already tried `deployed` before `local`. The first session then diagnosed a second bug —
that `deployedBaseline` could not find Pre on Vercel because Vercel records no GitHub
Deployments — and reproduced it against a stub built on that assumption. **The assumption
was wrong.** `GET /repos/juangadm/pre-post/deployments` returns Preview *and* Production
deployments from `vercel[bot]`, including production at `26aa6cd` and `718402f` — the exact
base commits of PRs #19 and #20. On this repository the pinned lookup finds a baseline.

The lesson is the one this project already writes down: a reproduction against a stub proves
the code does what the stub says, not that the stub matches the world. The endpoint was one
public URL away and was not checked before the fix was designed.

**What survives, on its own evidence.** Four defects hold independently of that assumption:

- The base-SHA pin is the *only* baseline lookup. It works where a host deploys every push
  to the default branch. A repository that deploys on a tag, promotes by hand, or whose base
  commit is older than its retained deployments has nothing at the fork point, and the run
  falls through to needing a dev server.
- `previewForHead` required an open PR, though hosts build on push. A pushed branch with a
  green preview could not be compared until a PR existed.
- `--dry-run` withheld the GitHub client entirely, making it the one mode that could never
  choose a deployment — so it always demanded a dev server, from the person least likely to
  have one.
- When a preview was found but no baseline, the run exited 3 saying *"No preview deployment
  for this commit"* — the opposite of what happened.

**Done.** `latestProductionDeployment` (new) answers "what is on production now" when the
base commit has no deployment, and reports the commit it was built from so Pre is never
mistaken for the base; `DeploymentUrl` carries that `sha`. `previewForHead` keys on the head
commit and uses the PR only for the bot-comment fallback. `deployedPair` looks the preview
up first and alone, so a run with no preview spends no baseline requests. `--dry-run` now
reads GitHub and writes nothing (`gh` vs `writeGh`). `NoDeployedBaselineError` names the
preview it found and the one flag that fixes it.

**Cut, deliberately.** A first pass added a baseline guessed from the repository website or
`homepage` in package.json, for hosts recording no deployments. Once the premise collapsed
it had no case: a baseline that is quietly the wrong site reads as ~100% changed on every
route and looks exactly like a real result. Widening now stops at deployments a host
actually recorded. Add it back only if a real host is found that records none, and only
behind a check that the two sides are the same site.

**Still open.**

- **Unverified in a live run.** The sandbox blocks `api.github.com`, `*.vercel.app` and the
  production domain, so every run here used replayed payloads and local stand-in hosts. The
  new paths are proven against shapes, not against Vercel. Whether a Vercel deployment
  *status* carries `environment_url` — which decides whether the pinned lookup returns a URL
  at all — is still unchecked: `GET /repos/{owner}/{repo}/deployments/{id}/statuses`.
- **Nothing sanity-checks the baseline.** Every route at ~100% changed almost certainly
  means the two sides are different sites, not that the branch rewrote everything. Say so
  instead of publishing. Belongs with the noise-floor work below.
- `doctor` says nothing about the deployed path, so it cannot tell a user whether the
  zero-setup route is available to them.

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
