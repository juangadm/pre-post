# pre-post

## What This Is
A rebrand + feature fork of `vercel-labs/before-and-after`. Visual diff tool for PRs — captures pre/post screenshots of web pages. Used as a Claude Code skill or from the CLI.

## Goal
Ship a polished, rebranded version ("pre-post") with a distinct visual identity: triangle logo, Biro Script + Departure Mono typography, "PRE vs Post" naming throughout. Deploy on Vercel at `site-puce-rho.vercel.app`.

## Key Architecture
- `site/` — Next.js marketing site (App Router, Turbopack)
- `skill/` — Claude Code skill (screenshot capture + PR commenting)
- Fonts: Biro Script (PRE), Departure Mono (Post), IBM Plex Sans/Mono (body)
- Dev server: `cd site && ./node_modules/.bin/next dev --turbo -p 3099`

## CRITICAL: Fork Safety — NEVER touch upstream

### This is a fork of `vercel-labs/before-and-after`
- **Fork repo**: `juangadm/pre-post`
- **Upstream repo**: `vercel-labs/before-and-after` — NEVER edit, commit, or push here

### Step 0: VERIFY THE REPO BEFORE ANY EDITS
Before modifying ANY file, run `git remote -v` and confirm origin points to `juangadm/pre-post`. If origin points to `vercel-labs/before-and-after`, you are in the WRONG directory. STOP.
- `/private/tmp/before-and-after/` is the UPSTREAM clone — NEVER edit files here
- **Fork clone**: `/Users/juangabrieldelgadomontes/My Drive/4. Gen AI/pre-post/`
- Always work in the fork clone directory above

### GitHub CLI
- `gh pr create --repo juangadm/pre-post` — always pass `--repo`
- `git push origin` — only push to origin (the fork), never upstream
- `gh` defaults to upstream in forks — always specify `--repo`

## Lessons
- Always verify `git remote -v` before any edit — working directory ≠ correct repo
- The fork has different fonts/layout than upstream — read the fork's files, not upstream's
- OG image is screenshotted from `/components/og` at 1200x630 using Playwright
