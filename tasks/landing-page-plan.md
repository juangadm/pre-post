# Landing page: sidebar docs shell

Status: plan, not started. The visual rebrand is a separate, later pass. This one keeps the
current fonts, colours and logo and changes only structure, copy and layout.

## Goal

1. The home page gets as short as jm.sv/before-and-after: a sentence, the hero, one install box.
2. Everything else moves into a few pages behind an Agentation-style left sidebar that shows
   on every page, the home page included.
3. Moving between pages feels like one page: no reload, no flash, nothing shifts.
4. The copy is written in plain words with no developer jargon, so anyone can follow it.
   It shows that pre-post makes PRs easy to review and leaves a record of every change.

## What Agentation actually does (read from its DOM and CSS)

- **Framework:** Next.js 15. `body` holds `nav.mobile-nav`, `nav.side-nav` and `main.main-content`
  as siblings. The nav sits outside `main`, in the root layout, so client-side navigation
  swaps only `main` and the sidebar never re-mounts.
- **Sidebar:** `position: fixed; top: 3.25rem; bottom: 1rem; width: 11rem;`
  `left: max(1rem, 50% - 30.75rem)`, which pins it to the left edge of a centred 61.5rem frame.
  Inside: the logo, then a scroll area (`overflow-y: auto`, hidden scrollbar, mask-image fade
  at the top and bottom edges), then a meta row (`v3.1.2 · GitHub icon`).
- **Links:** 12px, grey `#737373`; hover goes darker; active is `#222` plus a heavier weight
  (via variable-font `wght`, so the width doesn't jump). Section labels ("Tools",
  "Resources") are 11px, non-clickable.
- **Contents list on the active page:** under the active link it expands a list of that
  page's `h2`s. A 1.5px grey rail runs along it, and a dark indicator slides along the rail
  using CSS variables (`--active-top`, `--active-height`, `transform` transition 260ms).
  The current section gets `aria-current="location"` (scroll-spy).
- **Content column:** `.article` is `max-width: 36rem; margin: 0 auto; padding: 3.5rem 1.5rem 3rem`,
  a flex column with a 1.5rem gap. Between 981 and 1180px it moves to `margin-left: 13rem`
  to clear the sidebar. Below 980px the sidebar is hidden and a top bar with a hamburger
  takes over (its links expand with `grid-template-rows: 0fr → 1fr`).
- **Page anatomy:** a header (`h1` 20px/500 and a muted tagline), then `section`s with an
  `h2[id]`, 14px/22px body text, small muted notes, reference tables, and demo blocks with
  the same vertical margin.
- **Home (`.article-home`):** a copy-able install command at the very top, a visually hidden
  `h1`, the tagline, then short sections that each explain one idea in a few sentences.

## Information architecture

```
▲ pre-post
Overview            /
Install             /install
How it works        /how-it-works
  Detect              #detect
  Capture             #capture
  Share               #share
Commands            /commands
FAQ                 /faq
Resources
  Changelog ↗       GitHub releases
  GitHub ↗
v1.5.0 · npm
```

Five pages. No blog, search or API pages.

**The writing rule for every page: plain words, no jargon.** No page is aimed at a type
of reader, and none calls out "non-developers". Everything is simply written so anyone can
follow it. Short sentences, everyday words, one idea per line. Commands appear only where
you would type them, and every command gets a one-line plain explanation next to it.
Examples of swaps:

| Instead of | Say |
|---|---|
| routes | pages |
| merge base, import graph | what your change touched |
| baseline, production deployment | your live site |
| viewport | screen size (desktop, mobile) |
| pixel diff | compares the two pictures |
| sticky comment, PR description | at the top of the pull request |
| assets branch | kept in your own GitHub repo |

## Page by page (copy)

Voice: short, human, value first. One or two lines per idea. No jargon.

### Overview `/` (approved)

**The fastest visual proof for your PRs.**
Your coding agent captures every UI change in seconds, so you review faster and ship faster.

**How you use it**
1. Install it once by running this in your terminal: `npx skills add juangadm/pre-post -y`
2. Ask your coding agent to change your UI as usual
3. When it's done, type `/pre-post`
4. Open your PR. The before and after visuals are ready for you to compare and reviewers to approve.

### Install `/install` (draft)

**Install**
Run this once in your terminal:

`npx skills add juangadm/pre-post -y`

Then type `/pre-post` after any UI change.

**On every PR, automatically**
Add the GitHub Action. Nobody has to remember to run it.

**You'll need**
Node 20+, GitHub sign-in (`gh auth login`), and an open PR.
Stuck? Run `pre-post doctor`.

### How it works `/how-it-works` (draft)

**How it works**
Three steps, all automatic.

**Detect**
It finds every page your change touched. You don't list anything.

**Capture**
It shows each page before and after. A screenshot when something looks different, a short video when something moves.

**Share**
The visuals land at the top of your PR, ready to review. Run it again and they update.

### Commands `/commands` (draft)

**Commands**
You'll mostly just need the first one.

| Command | What it does |
|---|---|
| `pre-post pr` | Adds before and after visuals to your PR |
| `pre-post <url> <url>` | Compares any two sites |
| `pre-post login <url>` | Signs in once to a protected site |
| `pre-post doctor` | Checks your setup |
| `pre-post prune` | Deletes old visuals |

| Add | To |
|---|---|
| `--routes /pricing` | Pick the pages yourself |
| `-r` | Add mobile |
| `--dry-run` | Try it without touching your PR |

### FAQ `/faq` (draft)

**Is it really faster?**
Yes. Seconds, not the minutes agents take driving a browser. (Time a real run before shipping this.)

**Who can see the visuals?**
Only people who can see your code.

**What does it work with?**
Next.js and Vite out of the box. Anything else, name the pages with `--routes`.

**Does it cost anything?**
No. Free and open source.

Credit: a single small line in the site footer ("Originally forked from before-and-after").
No FAQ entry, no section.

## Code plan

### Layout shell (the part that makes it feel like one page)

- `site/app/layout.tsx`: render `<SideNav />` and `<MobileNav />` as siblings of `{children}`,
  and wrap the children in `<main>`. The App Router keeps a layout mounted across navigations,
  so the sidebar never re-renders from scratch.
- Every internal link uses `next/link`. That gives prefetching and soft navigation, with no
  document reload.
- The sidebar is `position: fixed` at a fixed width, and the content column has a fixed left
  offset at each breakpoint, so a page's height or content can't move either one.
- `html { scrollbar-gutter: stable }` stops the horizontal jump when a short page (no
  scrollbar) follows a long one.
- Fonts already go through `next/font`, so there's no swap shift.
- The contents list expands with `grid-template-rows: 0fr → 1fr`: pure CSS, no height
  measuring, and it only moves the sidebar's own contents.
- Anchor targets get `scroll-margin-top`, so section jumps land cleanly under the mobile bar.
- Optional, off at first: Next 16 `viewTransition` to cross-fade only the content column.

### Files

| File | Purpose |
|---|---|
| `site/lib/nav.ts` | Single source of truth: pages, labels, and each page's section anchors. The sidebar, mobile nav and sitemap all read it. Static, so it server-renders with no flash. |
| `site/components/docs/side-nav.tsx` | Client component. `usePathname()` picks the active link and renders its contents list. Holds the logo and the meta row. |
| `site/components/docs/toc.tsx` | Client component. An `IntersectionObserver` scroll-spy sets `aria-current` and the `--active-top`/`--active-height` variables for the sliding indicator. |
| `site/components/docs/mobile-nav.tsx` | Below 980px: top bar and hamburger; closes on route change. |
| `site/components/docs/page-header.tsx` | `h1` and tagline. |
| `site/components/docs/section.tsx` | `section` plus an `h2[id]` with a hover anchor. |
| `site/components/docs/install-tabs.tsx` | Claude Code / Terminal / Action tabs, with the ARIA tab pattern and a copy button. |
| `site/components/docs/ref-table.tsx` | A table for commands and flags. |
| `site/components/inline-code.tsx` | Replaces the 11 copies of the long inline-`code` class string. |
| `site/app/page.tsx` | Slimmed-down Overview. |
| `site/app/{install,how-it-works,commands,faq}/page.tsx` | New pages, each exporting `metadata` (title, description, canonical). |
| `site/app/sitemap.ts` | Adds the new routes from `nav.ts`. |

Reused as is: `hero.tsx`, `code.tsx`, `copy-button.tsx`, `logo.tsx`. We stay on Tailwind 3
with inline classes, matching the rest of the site.

### Breakpoints (Agentation's numbers, adapted to our 640px column)

- **≥ 1180px:** sidebar pinned to the left of a centred frame; content centred.
- **981–1179px:** sidebar at `left: 1rem`; content `margin-left: 13rem`.
- **≤ 980px:** no sidebar; mobile top bar; content at full width with a 16px gutter.

### Also fixed along the way (today's copy is stale)

- The page says "sticky comment". It's actually the top of the PR description, with a comment
  only as a fallback.
- The page says "desktop and mobile" by default. The default is desktop; `-r` adds mobile.
- The GitHub Action isn't mentioned anywhere on the site.

## Verification

- **Playwright e2e (`site`, `test:e2e`):**
  - The sidebar persists across navigation: tag the node with a JS property, click to another
    page, and assert the same node is still there.
  - No document reload: set a `window` marker, navigate, and assert it survives.
  - Zero layout shift: a `PerformanceObserver('layout-shift')` sums to 0 across
    Overview → Install → How it works → FAQ.
  - The active link and scroll-spy follow the page and the scroll position.
  - The mobile nav opens, closes, and closes on navigation.
  - Every internal link returns 200.
- Check desktop, 1024 and 375 widths by eye.
- Dogfood: run pre-post on the PR itself.

## Commit sequence (atomic)

1. Add the nav config
2. Add the side nav with the contents list and scroll-spy
3. Add the mobile nav
4. Mount the nav shell in the root layout
5. Add the InlineCode component and use it
6. Add the Install page
7. Add the How it works page
8. Add the Commands page
9. Add the FAQ page with JSON-LD
10. Slim the home page into the Overview
11. Add the new routes to the sitemap
12. Add e2e tests for navigation and layout stability

## Open decisions

- **Step 3 name:** "Comment" is no longer accurate, since it edits the PR description. I
  suggest **Share** (plain and friendly). **Publish** is the alternative.
- **Commands vs Reference** for the page name. I suggest **Commands**.

## Out of scope (next round)

Rebrand and look-and-feel, dark mode, and per-step demos.
