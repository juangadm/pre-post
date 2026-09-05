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

## 3. Identical pages reported as changed — FIXED

A real run on 2026-09-05 (PR #20, branch `claude/post-preview-deployment-urls-198t98`)
compared production against the branch's preview deployment:

```
changed  / @ mobile  (4.41%)
changed  / @ desktop (1.87%)
```

That branch touched `src/`, `docs/` and `README.md`. Nothing under `site/`. Both sides were
serving identical site code, and the tool reported a visual change on both viewports — the
failure class this project cares about most: confident, and wrong.

**What the noise actually was.** Capture time was a hidden input. `browser.ts` pinned the
clock with `ctx.clock.setFixedTime()`, which fixes what the page *reads* from `Date.now()`
but leaves `setTimeout`, `setInterval` and `requestAnimationFrame` firing; `animations:
'disabled'` covers CSS and Web Animations, not a React state machine on a timer. The
marketing site's hero is exactly that: a seven-phase loop driven by `setTimeout`, with a
`setInterval` typing effect inside it. Whatever frame it happened to be showing when the
screenshot fired is what got captured.

Measured, not assumed. Screenshotting the same URL at controlled delays after load:

| Delay after load | Difference from the +0ms capture |
|---|---|
| +200ms | 0.54% |
| +1500ms | 1.60% |
| +4000ms | 3.54% |

The page differs from *itself* by up to 3.5% depending only on when you look — the same
order as the 4.41% the real run reported. Two hosts answer at different speeds (a warm CDN
next to a cold preview deployment), so the two sides land on different frames. Reproduced
end to end by serving the built site from two local ports and putting a latency-adding
proxy in front of one: byte-identical HTML, and `pre-post` reported `changed / @ mobile
(0.20%)`. The crops showed it plainly — Pre had the hero's terminal fully drawn, Post had
that region still empty.

The false positive is intermittent, not constant: the animation cycles, so sometimes both
sides land on the same frame and the run is clean. That is worse than a reliable failure,
not better.

**The fix.** Install Playwright's clock *paused* (`clock.install()` + `clock.pauseAt()`)
rather than only pinning what the page reads. The page's timers do not move while it loads,
so waiting longer for a slow host, a cold cache or a busy machine no longer advances an
animation. Once the page is loaded and quiet its timeline is run forward by a fixed budget
(`TIMELINE_BUDGET_MS`, 600ms) in frame-sized steps, the same on both sides, and the
screenshot is taken with it still held. Settling now splits along that line: real time for
what the network delivers, budgeted virtual time for what the page animates. No threshold
was touched.

Two consequences worth knowing:

- **A context per capture.** Playwright's clock belongs to the browser context and is
  replayed into every page opened in it, so pages sharing a context inherit the timeline
  earlier captures ran. Reusing one context per viewport put the second capture at a
  different clock position — an 8px offset in the regression fixture, which is how it was
  caught. Contexts are now per capture, which also stops storage and caches leaking between
  the two sides. No measurable cost: a 1-route, 2-viewport run went from ~3.4s to ~2.7s.
- **`--wait` means both.** Real time for anything still in flight, and the same again on the
  page's timeline for anything animating.

**Validated.** The reproduction above reports `0.00%` on both viewports, 18 runs out of 18,
across latency gaps of 0ms, 250ms and 900ms. A small real change injected into the animated
hero is still caught (16.96% mobile / 11.68% desktop), the fixture ladder still reports every
rung as changed and every no-op as zero, and `tests/browser/capture.test.ts` now asserts that
the same animated page captured 1.2s apart is pixel-identical — with a second test that
`--wait` still moves it, so the first cannot pass by the fixture going static.

**Still open.** The sandbox blocks `prepost.juangabriel.org` and `*.vercel.app` (the egress
proxy answers 403 to CONNECT), so this was proven against the site's own production build
served from two local ports with injected latency — the same code, the same asymmetry, not
the same wire. Worth one confirming run of the original command from a machine that can
reach both hosts.

---

## 4. Token discovery checks presence, not capability — to verify

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

## 5. Environment adapters — to verify

The skill in `skill/` is Claude Code-specific. Cursor reads `.cursor/rules`, Codex
reads `AGENTS.md`, a terminal user reads the README. Nothing should fork the
behaviour — the CLI already holds it — but each surface needs its own thin pointer.

**Scope.** One documented invocation per environment, and a check that the CLI needs
nothing environment-specific to run. No new behaviour.

**Validate.** Run the same command by hand in each of the four surfaces.

**Size.** S, mostly docs.

---

## 6. First-run cost in a locked-down sandbox — to verify

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

## 7. Errors that leak Node internals — confirmed

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
- Honest coverage line: say what was checked *and* what was skipped.

---

## Findings: the first five minutes

Not work items — these are the "it just works" promise breaking for exactly the people this
tool is for.

**The recorded fork path pointed nowhere.** `CLAUDE.md` named the clone as
`~/My Drive/4. Gen AI/pre-post/` and told agents to "always work in the fork clone directory
above". The repository is not there. An agent that trusts the line either edits nothing or
goes looking for a tree that does not exist — in a container or a web sandbox it is wrong by
construction, since the checkout is somewhere else again. Fixed: the fork is identified by
`git remote -v` showing `juangadm/pre-post`, which is the test Step 0 already required and
the only one that travels between machines.

**A clean machine cannot install this.** Getting the CLI running took four attempts. Both
halves reproduce from a fresh clone:

```
$ pnpm install                    # with strict-dep-builds enabled
 ERR_PNPM_IGNORED_BUILDS  Ignored build scripts: esbuild@0.27.2, sharp@0.34.5
 Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
$ echo $?
1
$ npm install                     # over the node_modules pnpm just wrote
npm error Cannot read properties of null (reading 'edgesOut')
$ echo $?
1
```

pnpm 10 blocks dependency build scripts until they are approved; where `strict-dep-builds`
is set the warning is an error and the whole install fails on exit 1. Both packages belong
to `site/`, so the CLI — which needs neither — cannot be installed because of the marketing
site. Falling back to npm then fails on its own: npm cannot read the symlinked tree pnpm
left behind, and the error names none of that.

The repository declares no allow-list, which is what makes approval necessary. Verified fix,
not applied here (out of scope for the noise-floor work): add to `pnpm-workspace.yaml`

```yaml
onlyBuiltDependencies:
  - esbuild
  - sharp
```

With that line, `pnpm install --config.strict-dep-builds=true` completes in 2.7s from a
clean clone. The npm path deserves one sentence in the README as well: pnpm and npm cannot
share a `node_modules`, so `rm -rf node_modules` before switching.

**Noticed in passing, not acted on.** `package.json` still carries `"prepare": "npm run
build"`, so every install compiles TypeScript — the thing Phase 1 of the optimization plan
set out to remove ("ship prebuilt `dist/` so `npx` never compiles; drop the `prepare`
hook"). It also means an install failure and a compile failure look alike.
