# Making pre-post work everywhere

Target environments: a plain terminal (Ghostty, iTerm), Cursor, Claude Code, Codex —
and the web/sandbox version of each. The CLI is the contract; every environment is a
way of invoking it.

Each chunk below is scoped to stand alone as one session. Order is deliberate:
silently-wrong before missing-reach before polish.

Status key: **confirmed** = reproduced in a real environment, evidence noted.
**to verify** = suspected from reading the code; the session starts by proving it.

---

## 1. Shallow clones report "nothing changed" — confirmed, highest priority

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

---

## 2. The Post side assumes a local dev server — to verify

`pre-post pr` serves the working tree locally for "Post" and the base commit for
"Pre". A sandbox may not be able to run a dev server, and a PM or designer may not
have a dev environment at all — yet they are in the goal's audience.

**Scope.** Make "two deployed URLs" (preview vs production) a first-class path rather
than a fallback, and make `pre-post pr` choose it automatically when a preview
deployment for the head SHA exists. Check what `deployments.ts` already resolves
before writing anything.

**Validate.** A run with no local dev server, no `--before`, and a preview deployment
present produces a full comparison.

**Size.** M.

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
