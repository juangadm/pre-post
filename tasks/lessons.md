# Lessons

Patterns worth not repeating. Each one cost something real.

## A bound is not automatically a safety property

Reviewing the install-output capture, I noted that `execFileSync` caps each
stream at 1 MiB and concluded the buffering "cannot run away". True, and the
wrong conclusion: exceeding that cap kills the child with ENOBUFS, which the
same code reads as a failed install. Capturing the log to explain a failure had
introduced a new way to cause one. Codex caught it on #36.

**Why:** I asked "can this consume unbounded memory?" and stopped at "no". The
question that mattered was "what happens at the bound?"

**How to apply:** when a limit makes an efficiency worry go away, ask what the
system does when the limit is hit. A cap that turns a slow path into a failing
path has not solved the problem, it has changed its shape.

## Verify overlay/selector behaviour against a running app, never from memory

I hid Next's dev badge by hiding the `nextjs-portal` host. Measuring against
Next 16.0.10 showed the badge (`#devtools-indicator`) and the build-error
dialog (`[data-nextjs-dialog-overlay]`) share that one shadow root, so the hide
was suppressing real build errors too. Two probes — one healthy page, one
deliberately broken — settled in minutes what no amount of reasoning would have.

**Why:** framework dev UI is internal, undocumented, and changes between minor
versions. Any selector list written from memory is a guess.

**How to apply:** `site/` runs on `next dev --turbo -p 3099`. Break a file,
probe the DOM in both states, restore. Record the version measured against in
the comment, so the next reader knows when the evidence expires.

## `git apply --cached --unidiff-zero` silently misapplies context-bearing hunks

Splitting one working tree into atomic commits, I staged hunks with
`--unidiff-zero` on patches that carried context lines. That flag disables the
context safety check, so hunks landed in the wrong commits: three of seven
commits did not compile, and one carried a change belonging to another.

**Why:** `--unidiff-zero` is only for genuinely zero-context (`-U0`) patches.
With context present it does not verify placement.

**How to apply:** generate with `-U1` and apply *without* `--unidiff-zero`. Then
prove it: materialise each staged tree in a scratch worktree and refuse the
commit unless `tsc -p tsconfig.pkg.json` passes. Atomic commits are only worth
splitting for if every one of them builds — otherwise `git bisect` is a lie.

## A sleeping laptop is not a hung process

Diagnosing the "font 500", two runs took 16 and 18 minutes and a dev server sat
at "Starting..." for five. It looked like the bug. `pmset -g log` showed the
machine had been asleep on battery; process ages of 44 minutes for servers
started 3 minutes earlier gave it away.

**Why:** I read wall-clock symptoms as program behaviour without checking the
machine was running.

**How to apply:** long local measurements run under `caffeinate -dimsu`. When a
timing looks impossible, check `pmset -g log` before theorising.

## Measure the failure before building the plan's fix

The approved plan had a persistent baseline worktree (for a slow cleanup) and a
capture-twice noise mask (for dither noise). Measuring first showed the cleanup
was the browser's shutdown and that each side renders identically on its own —
both planned fixes would have shipped complexity that solved nothing.

**How to apply:** the plan names the invariant; the fix comes from a
measurement of the actual failure. Say so when the evidence overrides the plan.

## Scope to what the user will judge

Mid-way the user said animations need not be perfect (video support is coming);
screenshots and the report's errors are what matter. Stopped at a capped
idle-settle instead of chasing the last 68px of animation residue.

**How to apply:** when a sub-problem turns into a research project, check it
against the user's stated goal before going deeper.

## Run what CI runs before saying it passes

On #44 I reported "all tests pass" from `tests/unit` and `tests/browser`, and
CI failed twice. Once on a race only Linux shows (killed processes answer
signal 0 until reaped), once in `tests/integration`, which I never ran — its
error-path tests used an empty repo, and an empty diff had just become a
legitimate no-op.

**Why:** "the tests" meant the suites I happened to know about, not the
workflow file.

**How to apply:** before pushing, read `.github/workflows/ci.yml` and run its
steps in order (`tsc`, `test:unit`, `build`, `test:browser`, which includes
integration). A test that checks process state once, right after a kill,
must poll with a deadline instead.

## A dry run is not a no-op for local state

Testing Moments with `pre-post pr --dry-run --before http://127.0.0.1:4711`, the run saved
that fixture URL into the repo's `.pre-post.json` — `--before` persists by design, and
`--dry-run` only means "do not write to GitHub". Caught in `git status` before committing.

**Why:** I read "dry run" as "touches nothing" without checking what else the flags do.

**How to apply:** after any exploratory CLI run inside this repo, run `git status` and
revert config the run wrote. Prefer pointing test runs at a scratch repo, or pass the
sides in a way that does not persist (`--after` alone, or `--local`).

## Moments are part of the visual diff, not a separate pillar

Sketching the landing-page IA, I gave Moments its own step and suggested a dedicated demo.
The user corrected: pre-post is one visual diff, either static (screenshot) or dynamic
(clip). Moments is a mode of that diff, not a headline feature.

**Why:** I over-weighted the newest feature because it was freshest in the git log.

**How to apply:** in copy, docs and IA, present capture as one thing with two modes —
static and motion. Never lead with or break out a feature just because it shipped last.

## Accessible means plain words, not audience callouts

For the landing page I wrote "For developers, and everyone else" sections and a plain/technical
two-layer structure. The user wanted neither: just write everything in plain, jargon-free
language. Don't segment readers or name "non-developers".

**How to apply:** when asked to make copy accessible, rewrite the words (pages, not routes;
live site, not baseline) instead of adding sections or layers aimed at a type of reader.

## Lead copy with the value, not the mechanism

My landing copy described what pre-post does (detects, captures, posts). The user wanted it to
lead with what you get: visual proof in every PR, agents that show their work, changes you can
see and review right away, and speed (seconds, where agents driving a browser take minutes).
Reviewers get half a line, so they want the rest of their team using it.

**How to apply:** headline and first lines = user value, in the user's plain voice. Mechanism
goes on How it works. Avoid tidy AI-sounding parallel lists; write it the way a person talks.
