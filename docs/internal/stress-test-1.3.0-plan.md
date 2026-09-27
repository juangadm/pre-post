# pre-post 1.3.0 stress-test: plans by problem area

## Context

A real-site stress test of 1.3.0 (`juangadm/pre-post-lab`, PRs #1–#15) found six problem areas. The worst one: a broken branch gets published as a design change. You asked for plans, not patches: for each area, the root cause (checked against the code), one invariant, the systemic change, trade-offs, and how to verify it. Then a priority ranking. No code in this step.

I traced every observation to the source (HEAD `f908639`) and to the lab logs and PR bodies. Where the findings file was wrong or incomplete, it says **Correction**.

### The single design gap behind all six areas

Every stage of pre-post assumes its input is valid and produces free-form text for whatever went wrong:
- the server "answered", so it's ready;
- the page was captured, so it's a real render;
- a pixel differs, so it's a change;
- a route wasn't detected, so it's not affected.

When something goes wrong, the explanation becomes a string on stderr (`note: "local returned 500"`, `warn("capping at 6")`). It never enters the result the PR is rendered from.

The fix across all areas is the same shape. **Each stage returns either valid evidence or a typed reason why not. Terminal, JSON and PR are pure renders of one result model.** The areas below are that principle applied six times.

---

## Foundation (do first, small): one typed `RunReport`

Today `PrRunResult` / `RouteCaptureOutcome` (`src/types.ts:241-311`) exist, but key facts are lost or flattened:
- `note`, `error` and `delivery.hint` are pre-formatted strings;
- provenance (`Comparison.before.detail`) is dropped at `pr.ts:345`;
- run-level warnings only go to `log()`.

Extend the model rather than replace it:
- `provenance: { pre: {kind:'base-commit'|'deployment'|'url', sha?, label}, post: {...} }`
- `coverage: { captured[], notCaptured: [{route, reason:'cap'|'needs-sample'|'unreachable'}] }`
- `failures: [{side:'pre'|'post', kind, route?, excerpt?}]`: typed, not a note string.
- `changes`: see area 4.

`buildComment`, `buildSummary` and `detect --json` (`report.ts`, `commands/detect.ts`) render only from this model. That lets the model grow one area at a time without touching every renderer each time.

---

## 1. Broken pages are published as real changes

**Root cause (confirmed).** HTTP status is treated as advice, not a gate.
- `browser.ts:581-586`: only 401/403 throw.
- `run.ts:319-325`: only 404 means "absent".
- `run.ts:235-240`: a 500 falls through to `isChanged()` and becomes `changed`, with a note string that the PR renderer ignores (`report.ts:86-111`). The note calls Pre "production" and Post "local" regardless of strategy.

Two gates are missing:
- **Readiness.** `baseline.ts:632-644` `waitForServer` accepts any HTTP response on `/`, and `doctor.ts:77-94` deliberately treats a 500 as "is a dev server".
- **Verdict.** `run.ts:362-374` has no run-level failure for 5xx. The CLI exits 1 only if *all* outcomes are `error` (`cli.ts:249`).

The overlay is kept visible on purpose (`browser.ts:294-305`), which is right, but nothing reads it as a failure signal.

**Invariant.** A screenshot is only compared, published or counted as a change if both sides are healthy renders. Otherwise the run reports which side is broken, where and why, in the PR and via a non-zero exit.

**Approach.**
1. **A `health` classification per capture.** Each capture yields `healthy | broken{cause}`, from two layered signals:
   - HTTP status ≥500 (universal);
   - a framework error probe on the page. Add `errorProbe` to the existing `FrameworkAdapter` table (`routes.ts:30-130`). For Next.js: `[data-nextjs-dialog-overlay]` inside the `nextjs-portal` shadow root (the selector noted at `browser.ts:316`). It must be re-measured against Next 16 in both states, per `tasks/lessons.md`.

   The probe also catches runtime-error overlays served with HTTP 200, which a status check alone misses.
2. **A new outcome status `broken`**, with `side` and `excerpt`. It is never diffed and never uploaded. The error screenshot is kept in `-o` as local evidence only.
3. **A run-level verdict:**
   - Any `post` broken → verdict `post-broken`. The PR block is replaced by one sentence, e.g. "This branch doesn't render: `/work` fails with *Module not found…*". No images. Exit **4**, a new code documented next to `NeedsHumanError`'s 3, so CI can tell a broken branch (4) from a tool crash (1).
   - `pre` broken → `baseline-broken`. That isn't the PR's fault, so the message is "couldn't compare", also exit 4.
4. **Route warm-up as readiness.** Before capture, GET every selected route on both servers. This forces the dev compile and turns "server answered" into "routes healthy". A 5xx gets one retry after the server goes quiet, to separate a first-compile flake from a persistent failure. A persistent failure short-circuits: no browser work on a broken branch. Side benefit: captures no longer pay compile time.
5. Side labels come from `provenance`, not the hard-coded "production" / "local".

**Alternatives considered.**
- Status-only: misses 200-with-overlay.
- Overlay-only: framework-specific and brittle.
- Hiding the overlay: rejected, it produces "blank" screenshots that hide breakage.

**Trade-offs and risks.**
- A route that intentionally returns 500 (rare) is now a failure. Allow `.pre-post.json` `"expectStatus": {"/boom": 500}`.
- Warm-up adds about 1 request per route per side, but moves compile time out of capture, so it should be net-neutral.
- Users will notice that a broken branch now exits non-zero and says so in the PR. That is the point.

**Verification.**
- Scenario 15 (broken-build): one sentence in the PR, 0 images, exit 4.
- Scenario 10 first run: must not publish.

New scenarios:
- 15b: broken **base** commit, giving `baseline-broken`.
- 15c: runtime `throw` in a client component, 200 plus overlay.
- 15d: a transient first-compile 500 that heals on retry.

Unit tests: `run.test` matrix of {200, 404, 500, overlay} × {pre, post}.

---

## 2. Local runs fail where the site itself works

**Root cause: partly confirmed, font error not yet proven.** Confirmed:
- **Server output is discarded.** `baseline.ts:866-871` spawns with `stdio:'ignore'`, so pre-post literally cannot show *why* a server 500s.
- **Cleanup is slow and racy.** `baseline.ts:727-743` sends SIGTERM without awaiting exit, then runs a **synchronous** `git worktree remove --force` over a fully copied `node_modules`. It blocks the event loop for 12–31s while the dev server may still be writing `.next`.
- **The "near-instant" copy isn't.** The comment at `baseline.ts:591-597` says APFS clones are near-instant. In practice `cp -c -R` still creates every inode and runs in O(files), measured at about 10s every run.
- **The baseline is rebuilt from scratch every run:** copy, boot cold, delete, even when the base commit hasn't changed.

**Disproved:** "state leaking from the baseline". The worktree is in `os.tmpdir()`, with no shared `.next`, cache or env (`baseline.ts:714`).

**Unproven:** the next/font failure. Turbopack reports `Can't resolve '@vercel/turbopack-next/internal/font/google/font'` when fetching the Google font CSS fails, so a likely cause is a font-fetch failure while both servers boot at once and the ~10s copy saturates I/O. Another candidate is env inherited through `npx` (`npm_config_*`, `NODE_OPTIONS`). Every 500 run also had the slow cleanup, which suggests a Post server stuck retrying.

**Invariant.** Each side runs in an environment equivalent to the user running `dev` themselves. When a server fails, pre-post shows that server's own error output, attributed to its side.

**Approach.**
1. **Diagnose first (a spike, no product change).** Pipe both servers' output to `<out>/logs/{pre,post}.log`. Reproduce `global-style` across a small matrix: parallel vs sequential boot × reuse copy vs none × inherited vs cleaned env. Then fix the actual cause. If it's boot contention, warm-up from area 1 plus sequencing Pre's copy behind Post's first compile closes it. If it's env, pass a curated env.
2. **A `DevServer` lifecycle object** replaces the ad-hoc spawn and kill. It owns:
   - a log file and a ring buffer (the excerpt source for area 1's `broken{excerpt}`);
   - readiness via route warm-up;
   - `stop()`: SIGTERM, then **await exit** with a timeout, then SIGKILL. All async.
3. **A persistent baseline worktree** instead of create/copy/delete per run:
   - Keep one baseline per repo under `~/.cache/pre-post/<repo-id>/base`. Each run does `git checkout --detach <sha>`.
   - Re-sync `node_modules` only when the install-inputs hash changes. The existing `reusableInstall` check (`baseline.ts:539-559`) becomes the cache key.
   - Keep `.next`, so Pre boots warm on reruns.
   - Cleanup becomes "stop two processes".
   - A file lock guards concurrent runs; if it's held, fall back to today's temp worktree.
   - `prune` (`commands/prune.ts`) clears the cache.

**Alternatives considered.**
- Symlinking `node_modules`: Turbopack refuses it (existing comment).
- Background-deleting the temp worktree: hides the cost but still copies every run.
- Production builds (`next build`) for both sides: slower and changes what's being compared.

**Trade-offs and risks.**
- A persistent cache means persistent disk use. APFS clones are cheap, but a Linux CI runner gets a real copy. CI is ephemeral anyway, so `--local` in the action keeps the temp path.
- Stale `.next` across very different base commits: Next invalidates this itself, and `prune` is the escape hatch.
- Expected effect: about 25–45s saved per run (reuse ~10s plus cleanup 12–31s), and a warm Pre boot.

**Verification.**
- Scenarios 11 (global-style) and 10 (mobile-only), run 5 times each: 0 spurious 500s. If one does occur, the PR shows the server's own error line.
- `cleanup` under 2s on every run. Second run's Pre boot faster than the first.

New:
- two concurrent `pr` runs in the same repo;
- a run killed with Ctrl-C, then the next run is clean;
- a lockfile change triggers a re-sync.

---

## 3. Route selection is incomplete, and silently so

**Root cause (confirmed).** Detection is "import edges from changed file to page file". Three things fall out of that model:
- **CSS files aren't graph nodes.** `imports.ts:10`: `.css` isn't in `SOURCE_EXTENSIONS`, and `routes.ts:396` drops it.
- **Layouts are dead ends.** Only `page.*` files are entries (`routes.ts:42`), and pages don't import their layouts.
- **So global CSS and layouts get hand-written special cases** that emit only `/` (`nextjs.ts:51-58, 75-84`, `generic.ts:39-46`), despite reasons like "affects all pages".

Meanwhile the **full route inventory is computed and then discarded** (`routes.ts:392, 410`: `known`, used only for snapping).

The cap (`routes.ts:226-235`) sorts by confidence, then alphabetically, and slices, so `/writing` sorts after `/work` and is always the one cut. The only record is a `warn()`.

**Correction:** the cap *is* printed in the terminal: `Detected 7 routes, capping at 6…` is the first line of `layout-header.log`. But it prints before the server output, `detect` passes no logger (`detect.ts:13`), and it never reaches the JSON or the PR.

The `/` fallback (`pr.ts:254-257`) captures an unrelated page when only a dynamic template changed.

**Invariant.** Every route the change can affect is either captured or explicitly listed as not captured with a reason, in the terminal, JSON and PR alike.

**Approach.** Make the graph the single source of truth and delete the special cases:
1. **Route inventory as a first-class output:** `adapter.routeEntries`, returned in `RepoRouteDetection`.
2. **Add the missing edge types to the graph:**
   - stylesheets become nodes, so `layout.tsx` → `globals.css` is an import edge;
   - **segment edges**: a `layout.*` or `template.*` at segment S affects every inventory route under S (an adapter method; Pages Router `_app` affects all);
   - project-wide config (`tailwind.config`, `next.config`, `postcss.config`) affects the root.

   With those edges, "global style" is ordinary reachability: `globals.css` → root layout → all routes. `GLOBAL_PATTERNS`, the "layout → `/`" rule and the "components → `/`" rule are deleted.
3. **Selection is a policy over the affected set, not a truncation:**
   - Rank by confidence, then by **cause diversity**: routes reached via different changed files first, so one route per distinct cause always survives.
   - Then fill up to the cap.
   - The rest go to `coverage.notCaptured` with `reason:'cap'`.
4. **Dynamic routes.**
   - No `/` fallback. If nothing is capturable, say "nothing to capture; `/writing/[slug]` needs a sample" and capture nothing.
   - Optional follow-on: discover a sample by reading links on already-captured Pre pages that match the pattern. `/writing` links to `/writing/foo`, so no user input is needed.

**Alternatives considered.**
- Raising the default cap: hides the problem.
- Parsing JSX to find which layout wraps which page: the file-system convention already encodes this.
- Keeping special cases but emitting all routes: still a list of patches, and misses a nav imported only by the layout.

**Trade-offs and risks.**
- A global CSS or root layout change now selects every static route, which means more captures.
- Area 5's grouping keeps the PR readable. The cap still bounds cost, now visibly.
- Behaviour change: layout-only changes select many more routes.

**Verification.**
- Scenario 11: all 7 static routes are affected, 6 captured, `/writing` listed as not captured (cap).
- Scenario 12: the dropped route is named in terminal, JSON and PR.
- Scenario 8: no `/` capture; clear "needs sample".
- Scenario 3: unchanged set, but cause-diverse ranking.

New scenarios:
- a nav imported **only** by `app/layout.tsx`;
- a nested `app/writing/layout.tsx` selects `/writing` and its children only;
- a `tailwind.config` change.

Unit: `routes.test` asserts *which* routes survive, not just `length ≤ 6`.

---

## 4. The diff doesn't tell a changed page from a noisy one

**Root cause (confirmed).** Four separate gaps.

**a) There's no model of nondeterminism.** Each side is captured once (`run.ts:149-152`).
- `Math.random` is seeded globally (`browser.ts:347`), but the sequence is **order-dependent**. Any component added or removed upstream, or a difference in async ordering, gives `DitherImage` a different pattern on each side.
- `crypto.getRandomValues` isn't seeded.
- Animation time is a fixed 600ms (`browser.ts:32`), plus extra frames per scroll step during priming (`540-546`). So a taller Post lands on a different frame. This is scenario 14's half-dithered capture.

**b) The crop is one bounding box of every differing pixel** (`diff.ts:151-168`), with no clustering.
- A nav change plus dither noise becomes one 808×1356 box (scenario 3).
- `expandRegion` pads from x0, which clips the left edge.

**c) The crop and the verdict use different predicates.**
- The verdict uses the area/ratio thresholds (`run.ts:251-260`).
- The crop fires on **any** remaining pixel (`diff.ts:283-303`).
- So scenario 4 gets "Nothing else changed" plus a noise crop. That breaks the SKILL.md promise.

**d) Shift is one global offset over exact row hashes** (`shift.ts:75-140`).
- `RouteShift` drops `from` and the band height (`types.ts:282-289`), so "inserted here" can't be expressed.
- Scenario 5's banner: the shift was either not detected or rejected, the raw box covered more than 50% of the page, and the crop was suppressed (`diff.ts:68`), leaving full pages only.

**On reruns:** the same pixels produce the same bytes (crops use deterministic pngjs). Different bytes therefore mean nondeterministic *pixels*, which is the same root cause as (a).

**Invariant.** Pre-post reports a region as changed only if it differs between Pre and Post by more than either side differs from itself. Each change is one typed description (inserted / removed / moved / changed region), and the verdict, text and crop are all derived from it.

**Approach.**
1. **Learn each side's noise.**
   - Where Pre ≠ Post, capture that side a second time in a fresh context. Pixels that differ between a side's own two captures form its *unstable mask*.
   - Unchanged pages cost nothing extra.
   - If a large area is unstable, say so ("this page renders differently on each load") rather than hiding it.
2. **Settle to a fixed point, not a fixed time.** Advance the page timeline until two consecutive frames are pixel-identical, capped at a budget, with the same policy on both sides. Priming scroll steps stop consuming animation time. Whatever the animation still does after settling is caught by the unstable mask.
3. **Model changes as a row alignment**, not one offset.
   - Align the row hashes of the masked images with a patience/LCS diff, the way a text diff aligns lines.
   - That yields ops: `equal`, `inserted{y,h}`, `removed{y,h}`, `changed`.
   - Within `changed` bands, cluster the differing pixels into connected **regions**.
   - The result is `changes: Change[]` on the report, replacing `RouteShift`.
4. **One significance predicate** decides verdict, crop and text: region area and ratio after masking.
   - Crops are per region.
   - Wide regions snap to the full page width rather than clipping.
   - A pure `moved` gets no crop, by construction.
   - An insertion crops only the inserted band, with the text "New content at top of `/about`; the rest moved down 120px".

**Alternatives considered.**
- Per-component ignore selectors: manual, and exactly the kind of site-specific patch you ruled out. Keep them as a user escape hatch only (`ignore` already exists in config).
- Raising thresholds: hides real 2px changes (scenario 13 must keep passing).
- Perceptual diff (SSIM): helps anti-aliasing, not randomness.

**Trade-offs and risks.**
- The second capture adds about 1 capture's time, only on routes that changed.
- Row alignment is O(rows²) in the worst case. Patience diff on unique rows is near-linear; cap by page height (already capped at 2400 CSS px).
- Users will notice fewer, tighter crops and new "inserted" wording.
- Risk: a true change that also flickers gets masked. Mitigated by reporting large unstable areas.

**Verification.**
- **Scenario 3:** the `/` crop is nav-sized and not clipped.
- **Scenario 4:** a "moved down 48px" sentence and no crop.
- **Scenario 5:** described as an insertion, with a banner crop.
- **Scenario 14:** a settled Post image.
- **Scenarios 13 and 9:** unchanged (2px still caught; looping animation still ignored).
- **Rerun:** identical verdicts and crop rectangles.

New:
- two separate insertions;
- a removed section;
- a canvas animation longer than 600ms;
- `crypto.getRandomValues` noise.

---

## 5. The PR is written for the tool's author, not a reviewer

**Root cause: confirmed, with one correction.**
- The renderer emits one section per route × viewport (`report.ts:86-112`), so one nav change produces 6 sections and 24 images.
- The Pre label is `hostOf(beforeBase)` (`report.ts:72`), so the throwaway port appears in every PR. Confirmed in PR #15's real body.
- Run-level failures never reach the markdown (area 1).

**Correction:** "local returned 500", "(2 hops)", "0.00% once aligned (7.13% raw)" and Timings are **terminal-only**. The PR bodies in `out/pr2-body-*.md` and PR #15 don't contain them. They reached reviewers only if an agent pasted terminal output. SKILL.md line 71 ("Report the summary the command prints") invites exactly that.

**Invariant.** The PR block is a pure render of the `RunReport` in reviewer language. It says what changed, where, and what wasn't checked, and nothing in it depends on the machine that produced it.

**Approach.**
- **Provenance labels:** "Pre = base `38d9f0b` · Post = this branch @ `abd0fe5`".
- **Group identical changes.** Fingerprint each change by its crop pixels (area 4). One change seen on several routes renders once, as "Same change on 6 pages: `/`, `/about`, …", with one representative image and the rest folded.
- **Status first.** A failure (area 1) or coverage gap (area 3) callout goes at the top, in plain words.
- **Terminal vs PR:**
  - The terminal keeps the technical detail; Timings move behind `--timings`.
  - `notes` become typed fields, so each renderer phrases them for its own audience.
- **SKILL.md:** "the PR block is the deliverable; don't paste the terminal summary into it".

**Alternatives considered:** a hand-tuned text cleanup of the existing strings. That's patchy and drifts again.

**Trade-offs and risks.** Grouping hides per-route images behind a fold, but they stay one click away. The fingerprint must be exact-equal on masked crops, not fuzzy, to avoid merging different changes.

**Verification.**
- **Scenario 3:** 1 group and 2 images, not 6 sections and 24 images.
- **All scenarios:** no `localhost` in the PR body (a test asserts this for every fixture).
- **Scenarios 12 and 15:** the callouts are present.

---

## 6. Old copies and old docs get used

**Root cause (confirmed).** The instructions an agent follows are copied once and never reconciled with the CLI they drive.
- Nothing in `src/` knows about installed skill copies.
- `doctor` checks neither the skill copies nor the project's devDependency against the running version (`commands/doctor.ts:95-131`).
- `SKILL.md` allows `@latest` (lines 5, 42, 96), while `action.yml:51-60` correctly pins to its own version.
- Stale wording remains in `cli.ts:95,124-125`, `SKILL.md:14,70` and `package.json` ("comment").

**Invariant.** The skill text an agent reads and the CLI it runs come from the same release, and pre-post reports any drift it can see.

**Approach.**
- **Stamp and pin at release.** `skill/SKILL.md` gets `version:` frontmatter, and every `npx` line in it is rewritten to `@<version>` by the release step, the same rule `action.yml` already follows. The release check fails if they disagree.
- **A doctor drift check.** `doctor` (and a one-line warning in `pr`) reports:
  - installed copies (`~/.claude/skills/pre-post/SKILL.md`, `~/.claude/commands/pre-post.md`, project `.claude/…`) whose version differs, including the override precedence of `commands/`;
  - a project devDependency range that the running version doesn't satisfy.
- **Fix the wording**, then add one test that asserts the help text and SKILL.md describe the delivery mode that `github.ts` actually uses.

**Trade-offs and risks.** Pinning means skill users need a skill update to get a new CLI. That's intentional: same release, same behaviour. `doctor` reads files in `~/.claude`; it only reports and never edits.

**Verification.** Recreate the lab machine state (stale `commands/pre-post.md`, `^0.1.1` devDependency). `doctor` names both. `--help` and SKILL.md contain no "comment on the PR".

---

## Priority ranking

| Rank | Area | Why |
|---|---|---|
| 1 | **1. Broken pages published** | It's a correctness and trust failure: CI and reviewers get a false signal, and every other guarantee depends on this one. It's also cheap. |
| 2 | **2. Local env failures** | It produces area 1's false positives and costs 25–45s per run. It starts with the diagnostic spike. |
| 3 | **3. Route coverage** | Silent gaps mean "no change" can't be trusted. It also unlocks area 5's grouping. |
| 4 | **4. Noise vs change** | The largest piece of engineering. It makes crops and wording trustworthy. |
| 5 | **5. Reviewer-facing PR** | Mostly a renderer change once the model from areas 1, 3 and 4 exists. |
| 6 | **6. Stale copies** | Real, but it only affects agent-driven runs and is quick. It can ship alongside anything. |

**Build order:**
1. Foundation (`RunReport`) plus the area 2 diagnostic spike, in parallel.
2. Area 1.
3. Area 2 structural work.
4. Area 3.
5. Area 4.
6. Area 5.

Area 6 can go at any point. Each area is its own PR with atomic commits, and each ends by rerunning its scenarios against `pre-post-lab`.

## Critical files

- `src/types.ts`: the `RunReport`, `health`, `Change` and `coverage` types.
- `src/run.ts`: the verdict and the status gate.
- `src/browser.ts`: the error probe and fixed-point settle.
- `src/baseline.ts`: the `DevServer`, persistent worktree and logs.
- `src/comparison.ts`: boot sequencing and provenance.
- `src/routes.ts`, `src/routes/{nextjs,imports,generic}.ts`: inventory, segment and stylesheet edges, selection policy.
- `src/diff.ts`, `src/shift.ts`, `src/diff-worker.ts`: noise mask, row alignment, regions.
- `src/report.ts`: grouping and provenance labels.
- `src/commands/{pr,detect,doctor}.ts`, `src/bin/cli.ts`: exit code 4 and drift checks.
- `skill/SKILL.md`.

## End-to-end verification

1. `pnpm test` (unit plus browser suites) at each commit, with new unit fixtures per area as listed.
2. A regression script over `~/pre-post-lab`: for each scenario branch, run `pr --local --dry-run -o out/<name>` with the built CLI and assert:
   - the verdict;
   - the exit code;
   - the selected and not-captured routes;
   - the change kinds;
   - image count;
   - no `localhost` in the markdown.

   This turns the findings table into an automated check. Run it before every release.
3. A final live (non-dry) pass on PRs #3, #4, #5, #11, #12 and #15 to confirm the published PR bodies.
