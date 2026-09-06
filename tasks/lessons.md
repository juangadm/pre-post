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
