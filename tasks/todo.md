# TODO

Updated 2026-09-27. Finished fix passes (1.1–1.4 field tests, stress tests, Codex rounds)
are in git history: `git log -- tasks/todo.md`.

## Now: ship 1.5.0 (video Moments) — PR #46

- [x] Build Moments: record, align, composite, encode, attach inline (plan:
      ~/.claude/plans/zippy-purring-token.md, spike: docs/internal/video-spike.md)
- [x] /simplify pass and Codex review fixes
- [x] Live on PR #46: 3 clips attached with gh 2.101, all play inline (Chromium)
- [ ] Check the clips play on an iPhone / Safari (open PR #46 on your phone)
- [ ] Merge PR #46 with "Rebase and merge"
- [ ] `npm publish` 1.5.0 (manual, browser 2FA), then `npm view @juangadm/pre-post version`
- [ ] Reinstall the skill after publishing: `npx skills add juangadm/pre-post -y`
      (old copies in ~/.claude/skills and ~/.claude/commands were moved to the Trash)

## Later

- [ ] Persistent baseline worktree (~9s per run saved). An optimisation, not a fix.
- Video follow-ups live in tasks/backlog.md.

## Numbers from the Moments build

- One Moment: ~3.9s recording (3.25s is the clip) + ~1s composite. Three in parallel: 6.5s.
- Clips: 100–220 KB for 2–3.5s. A step Pre cannot do costs up to 3s of searching.
