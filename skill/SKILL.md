---
name: pre-post
description: Before/after screenshots for the current PR. Use when the user says "take before and after", "pre-post", "screenshot comparison", "visual diff", "PR screenshots", or after making visual UI changes.
allowed-tools:
  - Bash(npx -y @juangadm/pre-post@latest *)
  - Bash(npx pre-post *)
  - Bash(pre-post *)
---

# pre-post

One command does everything: detects the routes this branch changed, screenshots them at
desktop and mobile, pixel-diffs them, uploads the images to a `pre-post-assets` branch, and
posts or updates a single comment on the open PR. The human reviews on GitHub.

It picks both sides itself:

- **Post** (this branch) — the PR's preview deployment when one exists (Vercel, Cloudflare
  Pages, Netlify and Render all report these to GitHub), otherwise a local dev server.
- **Pre** (the baseline) — `before` from `.pre-post.json`, otherwise the production
  deployment for the commit this branch forked from, otherwise that base commit itself,
  checked out into a throwaway worktree and served locally.

So on a PR with a preview deployment, no dev server and no checkout are needed — anyone on
the team can run it against anyone's PR.

The last baseline needs no network at all, so the tool still works inside a sandbox, a CI
container, or behind an egress allowlist where no deployment URL is reachable. It also
compares against exactly what the branch forked from, rendered in the same environment as
the Post side. Pass `--no-local-baseline` to turn it off.

## Run

```bash
npx -y @juangadm/pre-post@latest pr
```

Add `--routes /a,/b` when the user names pages explicitly. Add
`--before https://production-url` only if the run reports it cannot work out the baseline
(it is then saved to `.pre-post.json` for next time).

## What it posts

The visual changes go at the **top of the PR description**, in a delimited block that
re-runs replace in place — the author's own text is never touched. If the PR cannot be
edited (a fork, a read-only token) it falls back to a single sticky comment.

Each changed route shows **Pre beside Post**, per viewport, with the full pages folded into
a `<details>`. That pairing is the comparison; there is no diff overlay and no percentage.

## Rules

- Run the command once. Do not open, read, or describe the screenshot files; the PR
  comment is the deliverable. Report the summary the command prints, plus the comment link.
- Do not switch branches or use a browser tool yourself. Do not start a dev server unless
  the command asks for one — with a preview deployment it does not need it.
- Exit code 3 means a human must do one thing (log in, start the dev server, pass
  `--before`). Relay that one sentence verbatim and stop.
- Do not use `--dry-run` unless the user asks to preview without posting.
- If the summary lists routes that "need a sample URL", ask the user for one example URL per
  dynamic route and add it under `"samples"` in `.pre-post.json`, then re-run.

## Options worth knowing

| Flag | Use when |
|------|----------|
| `--routes /a,/b` | The user names the pages |
| `--viewports desktop` | Desktop only (default is desktop + mobile) |
| `--viewport-only` | First screen only instead of full page |
| `--pr <n>` | The branch has several PRs or the lookup fails |
| `--dry-run` | Preview locally, post nothing |
| `--header k=v` / `--cookie k=v` | The site needs auth headers or cookies |

Login-protected sites: `npx -y @juangadm/pre-post@latest login https://site` opens a browser
once; the saved session is reused automatically.
