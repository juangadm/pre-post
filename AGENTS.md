# AGENTS.md

Guidelines for AI agents working on this project.

## What this is

`pre-post` is a CLI (and Claude Code skill) that produces before/after screenshots for pull
requests: route detection from the git diff, deterministic Playwright captures, a pixel
diff, publishing to a `pre-post-assets` branch through the GitHub API, and one sticky PR
comment. Forked from `vercel-labs/before-and-after`.

The design goal is that an agent runs **one command** (`pre-post pr`) and reads a short
summary. Never add steps that put screenshots or page content into model context.

## Layout

```
src/
  bin/cli.ts          argument parsing and dispatch only
  commands/pr.ts      the one-shot pipeline (resolve → detect → capture → diff → publish → comment)
  commands/compare.ts two-URL / two-image mode
  commands/login.ts   headed browser login, saves a session per host
  commands/prune.ts   deletes assets for long-closed PRs
  commands/doctor.ts  the same checks pr enforces, reported
  commands/detect.ts  route detection as compact JSON
  errors.ts           typed errors (NeedsHumanError = exit 3); thrown at the source, mapped once in the CLI
  config.ts           .pre-post.json and resolveSettings (defaults < config < CLI flags)
  pkg.ts              cached package.json reads
  run.ts              capture+diff for a list of route×viewport tasks (concurrent)
  browser.ts          Playwright launch chain, per-viewport contexts, settle logic, capture
  diff.ts             pixelmatch + pngjs: ratio, bounding box, highlight, crops
  diff-worker.ts / diff-pool.ts   worker-thread pool for diffs
  routes.ts           framework adapter table + repo-aware detection (monorepo app root, import graph, samples)
  routes/nextjs.ts    Next.js file → route rules (pure functions, heavily unit-tested)
  routes/vite.ts      Vite: React Router declarations + file-based pages
  routes/generic.ts   Remix/SvelteKit/generic fallback
  routes/imports.ts   regex import graph with tsconfig alias resolution
  github.ts           REST client: PR lookup, Git Data API publish, sticky comment, prune
  report.ts           PR comment markdown + terminal summary
  doctor.ts           browser install, dev server probe, auth hints, NeedsHumanError
  sessions.ts         saved login sessions and resolveAuth (config headers, CLI headers, Vercel bypass, cookies)
  git.ts              git subprocess helpers
tests/unit            no browser needed
tests/integration     CLI; browser cases gated by TEST_BROWSER=true
tests/browser         capture tests, gated by TEST_BROWSER=true
skill/SKILL.md        the Claude Code skill (keep it short)
site/                 marketing site (Next.js), independent of the CLI
docs/optimization-plan.md   why things are the way they are
```

## Rules

- Determinism first: any change to `browser.ts` must keep identical pages at 0 changed pixels.
- Keep `SKILL.md` under ~50 lines; the CLI is where behavior lives.
- Never commit screenshots to the PR branch; publishing goes through `github.ts`.
- Errors a human must act on are `NeedsHumanError` with a single actionable sentence.
- `pnpm build && pnpm test:unit` before committing. Run `TEST_BROWSER=true pnpm test` when
  touching capture, diff, or the CLI.
- Verify `git remote -v` points at `juangadm/pre-post` before editing (fork safety).
