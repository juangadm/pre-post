---
name: pre-post
description: Before/after screenshots for the current PR. Use when the user says "take before and after", "pre-post", "screenshot comparison", "visual diff", "PR screenshots", or after making visual UI changes.
allowed-tools:
  - Bash(npx -y @juangadm/pre-post@latest *)
  - Bash(npx pre-post *)
  - Bash(pre-post *)
---

# pre-post

One command does everything: detects the routes this branch changed, screenshots them on
desktop, pixel-diffs them, uploads the images to a `pre-post-assets` branch, and
posts or updates a single comment on the open PR. The human reviews on GitHub.

It picks both sides itself:

- **Post** (this branch) — the PR's preview deployment when one exists, read from the GitHub
  Deployments API or, for providers that only comment (Vercel's GitHub app does), from the
  deployment bot's PR comment. Otherwise a dev server: one already running, or one it starts
  and stops itself.
- **Pre** (the baseline) — `before` from `.pre-post.json`, otherwise the production
  deployment for the commit this branch forked from, otherwise that base commit itself,
  checked out into a throwaway worktree and served locally.

Both sides always come from the same kind of environment. Pairing a deployment against a
dev server would compare different builds — a dev server renders Next.js's dev badge that
production never shows — so a diff would carry changes the branch never made.

So on a PR with a preview deployment, no dev server and no checkout are needed — anyone on
the team can run it against anyone's PR. With nothing deployed and nothing running, it
serves both sides itself.

The last baseline needs no network at all, so the tool still works inside a sandbox, a CI
container, or behind an egress allowlist where no deployment URL is reachable. It also
compares against exactly what the branch forked from, rendered in the same environment as
the Post side. Pass `--no-local-baseline` to turn it off.

## Run

```bash
npx -y @juangadm/pre-post@latest pr
```

If you have a folder the user can open from wherever they are following you (a scratchpad
or workspace directory in a hosted session), add `-o <that folder>/pre-post` so the images
land somewhere they can see. Add `--routes /a,/b` when the user names pages explicitly. Add
`--before https://production-url` only if the run reports it cannot work out the baseline
(it is then saved to `.pre-post.json` for next time).

## What it posts

The visual changes go at the **top of the PR description**, in a delimited block that
re-runs replace in place — the author's own text is never touched. If the PR cannot be
edited (a fork, a read-only token) it falls back to a single sticky comment.

Each changed route shows **Pre beside Post**, per viewport, full pages in a `<details>`. No
overlay, no percentage. A page that moved says `Content shifted down 48px`; relay as written. A pure move
("Nothing else changed.") shows the full pages with no crop and no `<details>`, by design.

## Show the user

When anything changed, the command prints `Sheet: <path>`: one image with Pre beside Post for
every change. If you can send files to the user, send that one file, even when the PR was
updated. Someone following you from a phone sees it there before they open GitHub.

## Rules

- Run the command once. Do not open, read, or describe the screenshot files. The PR
  comment is the deliverable, and the sheet is the one image you pass along. Report the
  summary the command prints, plus the comment link.
- Do not switch branches, start dev servers, or use a browser tool yourself. The command
  handles all three.
- Exit code 3 means a human must do one thing (set a token, start the dev server, pass
  `--before`). Relay that one sentence verbatim and stop. If GitHub refused the token, the
  screenshots were still taken: send the sheet first, then relay the sentence. Never ask the
  user to paste a token into the chat; the sentence names where it goes.
- Do not use `--dry-run` unless the user asks to preview without posting.
- If the summary lists routes that "need a sample URL", ask the user for one example URL per
  dynamic route and add it under `"samples"` in `.pre-post.json`, then re-run.

## Options worth knowing

| Flag | Use when |
|------|----------|
| `--routes /a,/b` | The user names the pages |
| `-r`, `--responsive` | Desktop and mobile (default is desktop only) |
| `--viewport-only` | First screen only instead of full page |
| `--pr <n>` | The branch has several PRs or the lookup fails |
| `--dry-run` | Preview locally, post nothing |
| `--header k=v` / `--cookie k=v` | The site needs auth headers or cookies |

Login-protected sites: `npx -y @juangadm/pre-post@latest login https://site` opens a browser
once; the saved session is reused automatically.
