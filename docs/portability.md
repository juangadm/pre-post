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
it had no case: a baseline that is quietly the wrong site looks exactly like a real result.
Widening now stops at deployments a host actually recorded. Add it back only if a real host
is found that records none, and only behind a check that the two sides are the same site —
that check now exists, see the different-sites backstop below. (The reason given here at the
time — "reads as ~100% changed on every route" — was never measured and is false; it reads
as a *small* change. The backstop section has the numbers.)

**Still open.**

- **Unverified in a live run.** The sandbox blocks `api.github.com`, `*.vercel.app` and the
  production domain, so every run here used replayed payloads and local stand-in hosts. The
  new paths are proven against shapes, not against Vercel. Whether a Vercel deployment
  *status* carries `environment_url` — which decides whether the pinned lookup returns a URL
  at all — is still unchecked: `GET /repos/{owner}/{repo}/deployments/{id}/statuses`.
- ~~**Nothing sanity-checks the baseline.**~~ Done, though not the way this bullet said: the
  premise ("every route at ~100% changed means different sites") is measurably wrong in both
  directions. See the different-sites backstop below.
- `doctor` says nothing about the deployed path, so it cannot tell a user whether the
  zero-setup route is available to them.

---

## 3. Capture time changed what was captured — FIXED

Opened to explain a real run on 2026-09-05 (PR #20, branch
`claude/post-preview-deployment-urls-198t98`), which compared production against the
branch's preview deployment. **It turned out not to be the cause of that run** — see the
correction at the end of this chunk — but it is a real defect on its own evidence:

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

**What this did not fix, and a correction.** The chunk was opened to explain the #20 run
above, and attributed it to the animation. A live run from a machine that can reach both
hosts disproved that: the Post side was capturing **the Vercel Deployment Protection login
page**, not the site. The numbers give it away in hindsight — 4.53% / 1.99% reproduced to
two decimal places across three runs and across two different preview deployments, and did
not move when the timeline fix landed. Timing noise does not reproduce to two decimals.

The determinism defect above is real, measured and fixed on its own evidence. It was not the
cause of the run it was opened to explain. The sandbox blocks `prepost.juangabriel.org` and
`*.vercel.app` (the egress proxy answers 403 to CONNECT), so the fix was proven against the
site's own production build served from two local ports with injected latency — the same
code, the same asymmetry, not the same wire. The one thing that reproduction could never
show was what the far side actually served. The lesson from chunk 2 applies again, one level
up: a faithful reproduction of a real phenomenon still is not evidence that the phenomenon
is the one in the report.

---

## 4. Token discovery checks presence, not capability — PARTLY FIXED

**What was claimed, and what the evidence actually said.** The chunk suspected that sandbox
and CI environments "often inject a `GITHUB_TOKEN` scoped to the current repo's Actions
context", and that the failure "would land mid-run, after capture, with a raw API error".
Two of those are false. The third is true, but only through a route the chunk did not
describe.

**GitHub Actions injects nothing.** A probe workflow on this repository, in a step declaring
no `env:` of its own:

```
GITHUB_TOKEN set: no
GH_TOKEN set: no
gh on PATH: /usr/bin/gh
gh auth token: fails
```

`gh` is installed on the runner and signed in to nothing. `getToken()` returns null there,
`requireToken()` stops the run before anything is captured, and the existing message is the
right one. A token reaches a step only when the workflow author writes
`env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` — which is how anyone runs a token-using
tool in CI, but it is opt-in, not injection.

**The failure was never a raw API error.** `GitHub.request` has always mapped 401 and 403 to
`NeedsHumanError`. Running the real `publishAssets` from inside a runner holding the default
token, against the real API:

```
publishAssets threw after 88ms
  name:    NeedsHumanError
  message: GitHub rejected the token (403). Run: gh auth login   (or set GH_TOKEN with repo access), then re-run.
```

Typed, one sentence, exit 3 — and advice nobody can act on, since `gh auth login` is not
something you do inside a GitHub Actions runner. What was wrong was *when* the sentence
arrived and *what it said*, not that it was missing.

**The capability gap is real.** `ci.yml` declares no `permissions:` block, and every job on
this repository logs what it was granted:

```
##[group]GITHUB_TOKEN Permissions
Contents: read
Metadata: read
Packages: read
```

Read-only — GitHub's default for repositories created since February 2023, and a setting an
owner can flip either way, so this is one repository's answer and not a universal one.
Measured from inside a job carrying that token:

| call | result |
|---|---|
| `GET /repos/juangadm/pre-post` | 200, `permissions.push: false` (262ms) |
| `GET /repos/juangadm/pre-post/pulls?state=open` | 200 |
| `GET .../git/ref/heads/pre-post-assets` | 200 |
| `GET /user` | 403 (an installation token has no user) |
| `POST .../git/blobs` | **403** `Resource not accessible by integration` |

Every read `pr` makes before it captures succeeds; the first write after it fails. One route
at one viewport took 22.7s to capture in that same job, so the window the chunk was pointing
at is real even though the way in is a workflow that maps the token rather than an
environment that injects one.

**The sandbox is a different failure, and `doctor` was lying about it.** A Claude Code web
sandbox *does* inject both variables — set to a placeholder the egress proxy substitutes on
some API paths and not others. There `pre-post pr` exits 3 in 0.75s at the PR lookup, before
any capture: the read-before-capture ordering already covers it, and there was no 30 seconds
to save. But `doctor` reported

```
github     ok  token found
```

in exactly that environment, where every call the run makes answers 401. Presence cannot earn
an all-clear, and this was one — the failure class the rest of this file is about, in the
command whose whole job is to answer "will this work?".

**Done.** `checkWriteAccess` makes one authenticated write and reports three outcomes:
writable, rejected, or could-not-tell. `pr` starts it alongside the PR lookup, so it costs no
wall clock, and answers it before the local baseline (which can install and build a whole app)
and long before the captures. `doctor` reports what the token can do instead of that one
exists. `cannotPublishHint` follows the environment: inside a runner it names the workflow
permission, outside one it names `gh auth login`, one sentence either way.

**Why a write, and not a read.** `GET /repos/{owner}/{repo}` answers `permissions.push: false`
for this exact token in 262ms with no side effect, which makes it look like the better check.
It is not: `permissions` describes the *account's* access to the repository, not the scopes
the credential carries, so a classic token without `repo` scope held by someone who can push
reads `push: true` and is still refused the write. A check that hands out a confident
all-clear to a credential that will fail is worse than no check, so the preflight asks the
question it needs answered rather than the cheaper one that merely correlates with it. The
write is the first one `publishAssets` makes, on the one piece of content that cannot add
anything — the empty blob already exists in every repository, so success stores nothing new.

**What it proves, and what it does not.** The token may write objects to the repository. It
does not prove the run will publish: creating the `pre-post-assets` *ref* is a separate
permission a ruleset can refuse, and editing the PR description needs `pull-requests: write`,
which nothing here checks — a workflow granted only `contents: write` will capture, publish,
and then fail on the description. So `writable: true` means "not this failure", never "this
will work", and the code says so. An answer that is not about access — a 500, a dropped
connection — is not read as a refusal: `doctor` says it could not reach GitHub, and `pr` says
so and carries on to fail wherever it really fails.

**Validated** against the real read-only token in a real Actions job (`GITHUB_ACTIONS=true`):

```
github     FAIL  This workflow's token cannot write to juangadm/pre-post, so the screenshots
                 would have nowhere to go: add "permissions: contents: write" to the job and re-run.

$ pre-post pr --routes /
This workflow's token cannot write to juangadm/pre-post, so the screenshots would have
nowhere to go: add "permissions: contents: write" to the job and re-run.
exit=3 elapsed_ms=1416
```

1.4s instead of the 22.7s that job spent capturing one route. `--dry-run` with both variables
unset still completes on exit 0. Nine unit tests in `tests/unit/github.test.ts` cover the
three outcomes, the two hints, and that a 500 or an unreachable API is not called a rejection.

**Not reproduced end to end.** No run here contrived a real visual diff in CI, so the full
"capture, then 403" sequence was never one command. It is assembled from three measurements
that were each real, in the same job, with the same token: the reads succeed, the capture
costs 22.7s, and `publishAssets` is refused in 88ms. The ordering that puts the publish after
the capture is read from `pr.ts`, not measured.

**Still open.** `pull-requests: write` is unchecked, as above. And `doctor` still exits 0
whatever it finds, so this check reads as advice rather than a verdict — chunk 7's exit-code
contract is where that gets decided.

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

## Findings from the first live run (2026-09-05)

Confirmed on a real machine against the real hosts. Three failures, all of the
confident-and-wrong class, none of them fixed — recorded here so the next session starts
from evidence.

**1. A protected deployment is captured as a login page and diffed. — FIXED**

`browser.ts` raises `HttpStatusError` on 401/403, and `resolveAuth` sends
`x-vercel-protection-bypass` when `VERCEL_AUTOMATION_BYPASS_SECRET` is set. Neither helps
here: Vercel's Deployment Protection answers the *redirected* request with **HTTP 200** and
a login page, so the guard never fires. The run then reports:

```
changed  / @ mobile (4.53%)
changed  / @ desktop (1.99%)
```

— the site diffed against a login screen, published to a PR description as "Visual changes".
This is the exact failure the optimization plan predicted ("a Vercel-protected URL silently
captures the login page as 'before'") and it is still open.

**Scope.** Detect the wall by what came back, not by the status: a redirect to a known
sign-in host, or a page whose content says so, is not the site. Stop with `NeedsHumanError`
(exit 3) naming `VERCEL_AUTOMATION_BYPASS_SECRET` in one sentence. A generic version of the
"~100% changed means the two sides are different sites" check from chunk 2 belongs here too:
a diff that large is a bug report about the run, not a result.

**What the wall actually does**, measured against the live protected preview rather than
assumed — the assumption would have been wrong in the direction that matters:

```
status=200
final=https://vercel.com/login?next=%2Fsso-api%3Furl%3D...%26nonce%3D...
<title>Login – Vercel</title>
```

A redirect off-site, answered 200. Had it served the login inline at the same URL, a check
keyed on "the browser moved" would have silently done nothing — the same class of failure
one level up.

**Done.** `landing.ts` judges where a capture ended: blocked requires both that the browser
moved *and* that where it moved to is sign-in shaped, so an ordinary canonical-domain
(`.xyz` → `.org`, apex → `www`) or trailing-slash redirect still passes. `browser.ts` records
the final URL, the title and whether the response looked like Vercel. `run.ts` produces no
diff for a walled side, and `pr.ts` exits 3 naming the bypass secret when every route is
walled. Against a server shaped like the real wall, the old code reported
`changed / @ desktop (0.30%)`; it now reports that the site was never captured. Sixteen unit
tests in `tests/unit/landing.test.ts` (including the live URL and title above) and two
pipeline tests in `tests/browser/wall.test.ts`.

**The general case, built — but not on the signal this chunk proposed.** A backstop that
notices "these are two different sites" would have caught this run without knowing anything
about sign-in pages. That much held. The proposed *signal* — a diff near 100% on every route
— did not survive measurement.

Measured, on real pages and on the fixture set:

| pair | changed |
|---|---|
| the marketing site vs an unrelated real site, served locally | 2.66% desktop / 5.02% mobile |
| fixture pricing page vs three unrelated fixtures | 0.72% – 7.99% |
| the same site with a full theme change (`scenario-theme-change`) | 99.14% |
| the same site redesigned (`rung-7-redesign`) | 99.60% |

The rule is backwards. Web pages are mostly background and a pixel diff counts the pixels
that differ, so two *unrelated* pages agree on most of the canvas and read as a small
change — landing in the same 1–8% band as the login-page run at the top of this section
(4.53% / 1.99%). Meanwhile a legitimate redesign, the PR most worth screenshotting, reads
~100%. A threshold at 100% would have missed every occurrence on record and fired on the
best runs. It is the same mistake this file keeps recording: an intuition about how the
world looks, never measured against it.

What separates them is the **words**. A redesign changes how a page looks, not what it says;
a different site says something else. Containment of the smaller page's vocabulary in the
larger, with common English words removed (without that filter, two unrelated English pages
score 0.18 on shared articles and prepositions alone, close enough to the weakest same-site
pair at 0.20 to be unusable):

```
different sites   0.000, 0.000, 0.000, 0.071
same site         0.200 (weakest fixture), 0.417 – 1.000, and 1.000 for real pages
```

**Done.** `sameness.ts` holds the floor (0.1, in the empty band above) and the rule: a page
with fewer than ten distinct words is not judged at all, and *every* judgeable page has to
disagree before the run stops — one rewritten page is a branch doing its job, every page is
the wrong site. Captures carry their visible text, read after the screenshot so it cannot
influence the pixels being compared. `pr.ts` raises `NeedsHumanError` naming both sides
instead of publishing.

**The evidence has to be about pages, not captures.** Folding one route's viewports together
is the difference between a working rule and one that contradicts itself. A route captured at
desktop and mobile is one page's word list twice; counting it as two agreeing witnesses let a
single-route run — an explicit `--routes /`, or the `/` fallback when the diff names no
routes — reject exactly the case the rule above permits, a branch that rewrote a page.
Captures are now folded per route, keeping each route's *strongest* showing of shared words,
and a run with only one page to go on asks the **title** as a second witness: a title is where
a site names itself, so a rewritten page keeps it and a different site does not. With no
usable title there is no corroboration and the run publishes — the right way to be wrong here,
since a diff someone can look at beats refusing on one page's say-so. (Caught in review; the
first version's own doc comment claimed the property its code did not have.)

Verified end to end against two real sites served locally: caught at 1.69% / 2.91% changed —
numbers no ratio rule would flag — while a dark redesign of the same site at >50% changed
passes untouched. Twelve unit tests in `tests/unit/sameness.test.ts`, three pipeline tests in
`tests/browser/sameness.test.ts`.

**What it does not catch.** Two sides that are the same site at different *versions* but
wrongly paired (last year's production against this branch) share their vocabulary and pass,
correctly — that is a real comparison, just a stale one. A site with almost no text on any
route is never judged, by design.

**2. Any port that answers is treated as the dev server. — FIXED**

`detectDevServer` (`doctor.ts:51`) accepts a port when `status !== null` — any status at all.
`DEV_PORTS` includes 5000, which on macOS is **AirPlay Receiver**. With no dev server
running, the probe adopts AirPlay, gets its 403, and prints:

```
localhost:5000 requires a login. Run: npx pre-post login http://localhost:5000
```

Advice to sign in to a macOS system service, in place of "no dev server is running". It bites
precisely when nothing else is listening — the case the message exists to describe.

**Scope.** Require a plausible app response (2xx/3xx with an HTML content-type), not merely a
reachable socket. Drop 5000 and 7000 on darwin, or probe them last and never accept a 401/403
from them. `NoDevServerError` should win over any inference drawn from a stranger's port.

**Done.** `looksLikeDevServer` in `doctor.ts` decides: never a 401/403, a redirect on its own
terms, otherwise an HTML document. Reproduced first against a server shaped like the real
one — 403, `Content-Length: 0` — which the old probe adopted and the new one refuses,
naming the port it passed over.

Two deliberate departures from the scope above, both to avoid trading one wrong answer for
another:

- **A 404 or 500 that renders still counts.** The spec said 2xx/3xx, but a dev server with no
  `/` route, or one with a compile error, answers 404 or 500 with a page and is still the dev
  server. Refusing it would send someone hunting for a server they are already running — the
  same class of wrong advice, pointed the other way.
- **5000 is kept, not dropped.** The status rule already rejects AirPlay's 403 on every
  platform, so dropping the port would only cost the people running something real on it
  (Flask defaults there). It is probed last instead, behind every port a framework actually
  defaults to. 7000 was never in the list, so there was nothing to drop.

`scanDevServers` also reports what it passed over, and `doctor` prints it: "none found on the
usual ports" reads as a lie to someone who knows a service is listening on one of them. Nine
tests in `tests/unit/devserver.test.ts`.

**3. Serving the base commit needs a package manager on PATH. — FIXED**

```
Could not serve base commit 864ce15: pnpm install failed; run it by hand in
/var/folders/.../pre-post-base-58vjgT/site to see why.
```

`pnpm` was not on PATH in that shell (`zsh: command not found: pnpm`), and the local baseline
path assumes it. The same shell could still build the CLI with
`./node_modules/.bin/tsc -p tsconfig.pkg.json`, so the tool was runnable while its baseline
was not. Related to the install finding below, and it removes the fallback exactly when the
deployed path has already failed — as it did here, so the run ended with all three failures
stacked.

**Scope.** Choose the package manager from what the repo declares and what is actually on
PATH, fall back to `npm`, and say which one failed and how to run it by hand.

**Done.** `detectPackageManager` now reads the `packageManager` field before the lockfile —
the field is the deliberate statement, and a repository mid-migration can carry two
lockfiles. `resolvePackageManager` intersects that with `onPath` (a PATH scan, not a
`--version` subprocess) and falls back to npm, which ships with Node. The fallback says so,
including that it will not honour the declared lockfile; when npm is missing too, that is the
message rather than an install failure.

Reproduced with pnpm off PATH in a repo declaring it: the old code reported "pnpm install
failed" and gave up, the new one boots the baseline on npm.

**One thing the scope did not name.** "Run it by hand in `<dir>`" pointed into the throwaway
worktree, which `cleanup()` deletes *before* the message is printed — advice to visit a
directory that no longer exists. The failure now names the command in full and the same
relative directory in the caller's own checkout, which is still there to run it in.

Seven tests in `tests/unit/baseline.test.ts`.

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

**A clean machine cannot install this. — FIXED**  Getting the CLI running took four
attempts. Both halves reproduce from a fresh clone:

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
is set the warning is an error and the whole install fails on exit 1. Falling back to npm
then fails on its own: npm cannot read the symlinked tree pnpm left behind, and the error
names none of that.

**Correction to the note as first written.** It said "both packages belong to `site/`, so the
CLI — which needs neither — cannot be installed because of the marketing site". Half of that
is wrong, and it is the half that assigns blame. `sharp` does arrive with `next` in `site/`.
`esbuild` arrives with `vitest → vite` at the **root**: it is the CLI's own test runner
pulling it in, not the site. Traced in `pnpm-lock.yaml` rather than assumed from the package
names.

**Done.** `pnpm-workspace.yaml` now declares the allow-list:

```yaml
onlyBuiltDependencies:
  - esbuild
  - sharp
```

Reproduced before the fix (exit 1, `ERR_PNPM_IGNORED_BUILDS`, `esbuild@0.27.2` and
`sharp@0.34.5`) and after, from a deleted `node_modules`: `pnpm install
--config.strict-dep-builds=true` completes on exit 0 in 3.6s.

The npm path is now a paragraph in the README's Development section. Both halves were
verified: `npm install` over pnpm's tree fails with `Cannot read properties of null (reading
'edgesOut')`, and after `rm -rf node_modules site/node_modules` it succeeds and builds the
CLI. One detail worth having in the note — npm installs the CLI only, since `site/` is a
pnpm workspace member and npm does not read `pnpm-workspace.yaml`.

**Fixed in passing, because it blocked a test.** `diff-pool.ts` transferred each job's
buffers to the worker, detaching them in the calling thread. The `error` handler that exists
to finish a job inline when a worker dies was therefore holding a payload it could not read,
and failed with "Cannot perform Construct on a detached ArrayBuffer". Latent in production —
the worker only dies when its module cannot load — but the fallback could never have worked.
Jobs are copied now.

**Noticed in passing, not acted on.** `package.json` still carries `"prepare": "npm run
build"`, so every install compiles TypeScript — the thing Phase 1 of the optimization plan
set out to remove ("ship prebuilt `dist/` so `npx` never compiles; drop the `prepare`
hook"). It also means an install failure and a compile failure look alike.
