---
name: pre-post
description: Before/after screenshots for the current PR. Use when the user says "take before and after", "pre-post", "screenshot comparison", "visual diff", "PR screenshots", or after making visual UI changes.
version: 1.5.0
allowed-tools:
  - Bash(npx -y @juangadm/pre-post@1.5.0 *)
  - Bash(npx pre-post *)
  - Bash(pre-post *)
---

# pre-post

One command does everything: detects the routes this branch changed, screenshots them on
desktop, pixel-diffs them, uploads the images to a `pre-post-assets` branch, and
puts them at the top of the open PR description. The human reviews on GitHub.

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
npx -y @juangadm/pre-post@1.5.0 pr
```

The version is pinned on purpose: this file describes that release. If the run starts with
`Note:` lines about another version, relay them; they mean a copy of these instructions is
out of date.

If you have a folder the user can open from wherever they are following you (a scratchpad
or workspace directory in a hosted session), add `-o <that folder>/pre-post` so the images
land somewhere they can see. Add `--routes /a,/b` when the user names pages explicitly. Add
`--before https://production-url` only if the run reports it cannot work out the baseline
(it is then saved to `.pre-post.json` for next time).

## Video: Moments

Screenshots cannot show motion. When the diff changes something that **moves or reacts** —
a menu, dialog or drawer opening, a hover or focus state, a transition or animation, form
feedback, a toast, tabs — also record it as a **Moment**: one short interaction, played on
Pre and Post side by side in one synced clip. Static changes (copy, colour, spacing) need no
Moment; the screenshots cover them.

Write the Moments to a file outside the repo (the scratchpad, or `/tmp`) and pass it:

```bash
npx -y @juangadm/pre-post@1.5.0 pr --moments /tmp/moments.json
```

```json
{ "moments": [
  { "name": "Open the account menu", "route": "/settings",
    "steps": [{ "hover": "Account" }, { "click": "Account" }, { "wait": 400 }] }
] }
```

- **Steps**: `click`, `hover`, `press` (a key), `type` (`["Email", "ada@example.com"]`),
  `scroll` (text to scroll to, or pixels), `wait` (ms). Name targets by the text a person
  sees — the button label, the field label — taken from the code you changed. Only if plain
  words cannot say it, use `css=<selector>`. Add `"viewport": "mobile"` for mobile-only UI.
- **One interaction per Moment, under 15 seconds.** A reviewer should get it on first play.
  A flow is several Moments ("Open the menu", "Pick a plan"), not one long one.
- **Most important first; three at most** are recorded: new interactions, then changed
  ones, then pure motion. The rest are listed in the PR as not recorded.
- A step Pre cannot do is expected for a new feature: that pane says "Not in the old
  version" and the clip still ships. A step **Post** cannot do means the target text is
  wrong — check the exact label in the code, fix that Moment, and re-run once.
- Do not add Moments to `.pre-post.json` unless the user asks for them to run every time.

## What it posts

The visual changes go at the **top of the PR description**, in a delimited block that
re-runs replace in place — the author's own text is never touched. If the PR cannot be
edited (a fork, a read-only token) it falls back to a single sticky comment.

Moments come first, one clip each: they play inline when `gh` is 2.99 or newer and signed in
as a person; otherwise the PR shows the clip's last frame linking to it, with one line saying
how to make it play. Relay that line.

Each changed route shows **Pre beside Post**, per viewport, full pages in a `<details>`. No
overlay, no percentage. A page that moved says `Content shifted down 48px`; relay as written. A pure move
("Nothing else changed.") shows the full pages with no crop and no `<details>`, by design.

## Show the user

When anything changed, the command prints `Sheet: <path>`: one image with Pre beside Post for
every change. If you can send files to the user, send that one file, even when the PR was
updated. Someone following you from a phone sees it there before they open GitHub. Each clip
is printed as `Video: <path>`; send those too.

## Rules

- Run the command once. Do not open, read, or describe the screenshot files. The block in
  the PR description is the deliverable, and the sheet is the one image you pass along. Tell
  the user what the summary says, plus the PR link. Never paste the terminal output into the
  PR: ports, timings and percentages there are for you, not for a reviewer.
- Do not switch branches, start dev servers, or use a browser tool yourself. The command
  handles all three.
- Exit code 4 means a page rendered an error (a build error, a 500) instead of itself. No
  screenshots were published and the PR says so in one sentence. Relay that sentence; the
  branch needs fixing before a visual comparison means anything.
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
| `--moments <file>` | The change moves or reacts (see Video: Moments) |
| `--no-video` | Skip the Moments in `.pre-post.json` this once |
| `--header k=v` / `--cookie k=v` | The site needs auth headers or cookies |

To run on every PR without anyone invoking it, point the user to the GitHub Action guide
(https://github.com/juangadm/pre-post/blob/main/docs/github-action.md). It posts with GitHub's own token, which also covers work done in cloud sessions.

Login-protected sites: `npx -y @juangadm/pre-post@1.5.0 login https://site` opens a browser
once; the saved session is reused automatically.
