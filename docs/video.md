# Video: Moments

Screenshots show how a page looks. They cannot show a menu opening, a hover state, a
transition, or a form reacting. A **Moment** can: one short, named interaction, recorded
on Pre and Post and played **side by side in one clip**, in step.

```bash
pre-post pr --moments moments.json
```

```json
{ "moments": [
  { "name": "Open the account menu", "route": "/settings",
    "steps": [{ "hover": "Account" }, { "click": "Account" }, { "wait": 400 }, { "press": "Escape" }] },
  { "name": "Switch to dark theme", "route": "/settings",
    "steps": [{ "click": "Account" }, { "click": "Theme" }] },
  { "name": "Mobile nav", "route": "/", "viewport": "mobile",
    "steps": [{ "click": "Menu" }] }
] }
```

The same list can live under `"moments"` in `.pre-post.json` to run on every PR;
`--no-video` skips it for one run. With the Claude Code skill, you don't write any of
this: say "show the new dropdown" and Claude writes the Moments from the diff.

## Writing a Moment

| Step | Does |
|---|---|
| `{ "click": "Save" }` | Clicks what a person would call "Save" |
| `{ "hover": "Account" }` | Moves the pointer over it |
| `{ "type": ["Email", "ada@example.com"] }` | Types into the field labelled "Email", one key at a time |
| `{ "press": "Escape" }` | Presses a key |
| `{ "scroll": "Pricing" }` / `{ "scroll": 600 }` | Scrolls smoothly to the text, or by pixels |
| `{ "wait": 600 }` | Holds for 600 ms |

Targets are the words on screen: a button's label, a link's text, a field's label or
placeholder. pre-post tries, in order, an interactive element with exactly that accessible
name, a field with that label or placeholder, exact visible text, then the same things
loosely. It waits up to 3 s for the target to appear, since a menu item exists only once the
menu is open. When plain words cannot say it, `css=<selector>` is the escape hatch.

A Moment with no steps records the first 3 seconds of the page, for entrance animations.

## Keep them short

- **One interaction per Moment.** Aim for under 15 seconds, so a reviewer gets it on the
  first play. A flow is several Moments ("Open the menu", "Pick a plan", "See the
  confirmation"), not one long one.
- **There is no duration cap.** A clip is as long as its steps: 0.5 s of still page, each
  step and a 0.4 s pause after it, then 1 s on the result. Nothing records for minutes on
  its own. A clip over 30 s still ships, with one line suggesting you split it.
- **Three Moments per run.** In a big PR, video goes to the few changes a reviewer most needs
  to see move: new interactions, then changed ones, then pure motion. Order is priority.
  The rest are listed in the PR as not recorded, and every changed page still gets
  screenshots.

## What the clip shows

- PRE on the left, Post on the right, each scaled to at most 800 px wide (phones at their
  own width).
- **Step-aligned.** Each step starts at the same instant on both sides. The faster side holds
  on its last frame until the slower one catches up, so you compare the change, not load
  speed.
- The Moment's name, and the step in progress (`2/3 · Click “Account”`), under the panes. A
  marker shows where each click lands.
- **A step Pre cannot do** is the usual sign of a new feature. The Pre pane says "Not in the
  old version" and the clip still ships. A page Pre does not have at all shows "New page in
  this PR".
- **A step Post cannot do** gives no clip, only a sentence in the PR ("Couldn't find “Save”
  on Post (step 2)."), because the change under review could not be shown.

Recording runs on the page's real clock with its motion preferences left alone, the opposite
of screenshots, which freeze time so pixel diffs are stable.

## In the PR

Clips appear above the screenshots.

- **Inline player**: when `gh` 2.99 or newer is installed and signed in as a person (or with
  a classic token), clips upload as GitHub attachments and play right in the PR description.
- **Linked**: otherwise, including with the Actions `GITHUB_TOKEN`, which `gh --attach`
  refuses, the clip and its last frame go on the `pre-post-assets` branch. The PR shows the
  frame linking to the clip, plus one line on what would make it play inline. `pre-post
  doctor` reports which case you are in.

```bash
brew upgrade gh   # or see https://cli.github.com
```

## Format and size

WebM (VP8) at 30 fps, encoded with the ffmpeg Playwright installs for its own video (~2 MB,
downloaded on first use). No system install is needed. It plays in Chrome, Firefox, Edge and
Safari (macOS 14.1+, iOS 17.4+). A 3-second clip is about 120 KB. A clip over 8 MB is
re-encoded smaller, so it stays under GitHub's 10 MB limit for free plans.
