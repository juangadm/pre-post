# Fix pass from the six-PR field test (juangadm/juangabriel, #60–65)

Source: field report against @juangadm/pre-post 1.1.0. All six runs used the
`local` strategy and were ~65s each; the failures below are correctness and
honesty problems, not speed.

## P0 — the only real blocker
- [x] Local baseline install dies on ERESOLVE. `npm install` is run bare, so a
      React 19 repo with one unmigrated peer dep (vaul@0.9.9) never gets a
      baseline. Catch ERESOLVE and retry once with `--legacy-peer-deps`.

## P1
- [x] That failure is silent and misdirects: it returns a quiet null (no
      comparison, clean exit) and says "Run it in <repo> to see why" when the
      install actually ran in a throwaway worktree. Apply docs/portability.md
      §1's rule — never a clean exit for a run that compared nothing — and say
      where it really ran, with the manager's own output.
- [x] Stale installed skill at ~/.claude/commands/pre-post.md documents a CLI
      that no longer exists and shadows skill/SKILL.md.

## P2
- [x] `--help` hides half the change rule: `--threshold` is only one arm, and
      `minChangedArea` is absent entirely.
- [x] The percentage printed beside "shifted down 80px" is uncompensated.
      Report the residual after alignment instead.
- [x] Next's dev badge ships in published images (both sides are dev servers on
      the local path). Hide framework dev overlays at capture time.

## P3
- [x] Log says `Comment: <url>` for a run that edits the PR description.
- [x] Local files are `-pre`/`-post`; published are `-before`/`-after`.

## Do not regress
crop-to-changed-region; shift detection; determinism; teardown on the error path.

## Review

**P0 — ERESOLVE.** `PackageManager` gained an optional `installLoosely` argv (npm only:
pnpm, yarn and bun warn on an unsatisfiable peer instead of aborting). `installDeps` runs
the declared install, and retries once with `--legacy-peer-deps` only when the output
carries npm's own `ERESOLVE` code. Verified against a real tree — react@19.2.0 +
vaul@0.9.9 — outside the test suite: bare `npm install` fails, the retry reports
`added 504 packages`, `loosened: true`.

**P1 — silent and misdirecting.** The install's stdout+stderr is captured now instead of
`stdio: 'ignore'`, and a failure raises `BaselineInstallError extends NeedsHumanError`
(exit 3) instead of returning a quiet null that fell through to "no baseline" — or, on a
repo with a configured production URL, to comparing against that instead. The message
carries npm's own last 24 lines, and says the install ran in a throwaway worktree rather
than naming the reader's checkout as the place to reproduce it. `localPair` stops the Post
dev server before the throw escapes, and `runPr` closes the browser when resolution throws.
Verified end to end with a repo whose base commit depends on a nonexistent package:
`BaselineInstallError`, real 404 output, no retry, no leftover worktree.

**P1 — stale installed skill.** `~/.claude/commands/pre-post.md` (247 lines describing
`pre-post compare --before-base` and `scripts/upload-and-copy.sh`, neither of which exists)
replaced with the current `skill/SKILL.md`. Previous content kept at
`~/.claude/commands/pre-post.md.stale-bak`.

**P2 — hidden change rule.** `--threshold` is now described as one of two arms, and
`--min-changed-area` is both documented and wired as a real flag (it was already a
`Settings` field with no way to set it from the CLI). README already had both right.

**P2 — shift percentage.** `RouteShift` carries `residualRatio`, and the per-route log
line reads `shifted down 80px, 1.41% once aligned (19.86% raw)` instead of quoting the
uncompensated number next to the move that caused it.

**P2 — dev badge.** The capture init script now hides `nextjs-portal`,
`#__next-build-watcher`, `[data-nextjs-toast]`, `next-route-announcer` and Vite's error
overlay, so a `position: fixed` artefact of dev-server rendering stops shipping in
published images and stops counting as residual after alignment.

**P3.** `PrRunResult.commentKind` records whether the description or a comment was updated,
and the summary line names it. Local files are `-before`/`-after`/`-before-crop`/
`-after-crop`, matching the published assets and `ArtifactSet`.

**Not touched, as scoped:** the `explicit` and `deployed` strategies (untested in the field
run), and `mixed`, which is structurally unreachable without `--before`.

**Verification.** 352 unit tests (16 new in `tests/unit/install.test.ts`), 28 browser tests,
8 integration tests — all green. `tsc -p tsconfig.pkg.json` clean.

## Cleanup pass

- `artifactSuffix()` in `types.ts` is now the single kind→filename mapping, used by both
  the capture and the publish. Renaming literals had only aligned three of five kinds:
  crops were still `-before-crop` on disk and `-cropBefore` published. `PUBLISHED_KINDS`
  derives from `ARTIFACT_KINDS` instead of restating it.
- `PackageManager.installLoosely` became `retry: { argv, when }`, so the retry argv and the
  predicate that selects it cannot drift apart; `BaselineInstallError` names the flag from
  the argv that ran rather than a hardcoded copy.
- `InstallResult.loosened` dropped — it was `ok && attempts.length > 1`.
- Message assembly moved out of `super()` into `installFailureMessage`.
- A successful install no longer splits its log to keep 24 lines nothing reads.
- Dev overlay selectors lifted to a named `DEV_OVERLAY_SELECTORS`.
- `residualRatio`'s nine-line comment cut to one; the log reads the value already in scope.
- One test asserts the real manager table wires npm's retry up, not just that `installDeps`
  branches on a fixture.

**Skipped.** Folding `commentUrl`/`commentKind` into `published: { target, url }` — a
breaking change to an existing public field, outside this diff. Making `serveLocally`'s
failure channel uniform and moving the fallback policy into `localPair` — a real finding
(the dev-server boot timeout at the end of `serveLocally` still returns null and can fall
through to `config.before`, the same hole this pass closed for installs), but fixing it
changes behaviour and belongs in its own change, not a cleanup pass.

## Codex review round (PR #36)

Four findings, all accepted.

- **P1, one actionable sentence.** The install error carried three sentences plus 24 log
  lines, against the `AGENTS.md` rule that a `NeedsHumanError` is one sentence. Output
  moved to `log()`; the error is the remedy only. `90a4b76`
- **P1, error overlays.** Hiding `vite-error-overlay` would have published the blank page
  under a failed transform on a still-200 document. The same hazard was in the Next path
  and I had missed it: measured against 16.0.10, the badge and the build-error dialog share
  one `nextjs-portal` shadow root, so hiding the host took the dialog with it. Now reaches
  into the shadow root for `#devtools-indicator` alone, just before the screenshot.
  Verified broken-build state keeps the dialog at `display: flex`. `11e15de`
- **P2, ENOBUFS.** A regression I introduced — see `lessons.md`. `ba9d44a`
- **P2, legacy label.** An absent `commentKind` now keeps the old `Comment:` output.
  `a9a8fe7`

Pushed back on one point in-thread: Codex suggested an error overlay should make the
capture fail. For Next it need not — a broken build answers 500, which `runTask` already
records. Vite is the dangerous case because it stays at 200, and there the fix is simply
not to hide the evidence.
