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
production ("Pre") and on the local dev server ("Post") at desktop and mobile, pixel-diffs
them, uploads the images to a `pre-post-assets` branch, and posts or updates a single
comment on the open PR. The human reviews on GitHub.

## Run

```bash
npx -y @juangadm/pre-post@latest pr
```

Add `--before https://production-url` the first time in a repo (it is saved to
`.pre-post.json`). Add `--routes /a,/b` when the user names pages explicitly.

## Rules

- Run the command once. Do not open, read, or describe the screenshot files; the PR
  comment is the deliverable. Report the summary the command prints, plus the comment link.
- Do not start dev servers, switch branches, or use a browser tool yourself.
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
