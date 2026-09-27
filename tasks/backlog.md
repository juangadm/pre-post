# Pre-Post TODO

Resolved by the 1.0 rewrite (see docs/internal/optimization-plan.md): auth-protected deployments
(`pre-post login`, `VERCEL_AUTOMATION_BYPASS_SECRET`, clear 401 hints), route detection via
the import graph, Vite support, GitHub-native storage on `pre-post-assets`, sticky PR
comment, pixel diff with crops.

## Later
- [x] Video: Moments — short interactions recorded as synced Pre | Post clips (1.5.0, docs/video.md)
- [x] GitHub Action mode on top of `pre-post pr` for zero-touch PRs (`action.yml`)
- [x] `pre-post prune` on a schedule (workflow in docs/storage.md)

## Site / Hero

- [ ] Mobile layout check — stacked or scaled workspace view
- [ ] Consider reduced-motion: skip animations, show static workspace + PR side by side

## Follow-on from the trustworthiness pass

- [ ] A pre-post-testbed repo for the live-PR matrix (import-graph fan-out,
      layout file, new route, deleted route, maxRoutes cap, dynamic route). Not
      this repo: every live run writes to pre-post-assets permanently, and
      site/ is the marketing site.
- [ ] Replace the assets branch with native GitHub attachments once there is a
      documented API. gh 2.99.0 added `--attach` for issues, PRs and comments,
      but it drives the undocumented /upload/policies/assets endpoint, which
      does not accept a PAT. Adopting it today would mean shelling out to
      gh >= 2.99, and gh is currently optional — GH_TOKEN alone is enough.
      Worth revisiting: it would remove the assets branch, prune, and the
      "images live in git history forever" caveat entirely.

## Video follow-ups

- [ ] Verify `gh --attach` end to end on a live PR once gh is 2.99+ here (built from
      vercel-labs' documented flow; the spike could not run it on gh 2.83.1).
- [ ] Deterministic frame stepping (CDP virtual time) so clips are identical run to run.
      CSS transitions follow the compositor clock, so the fake clock alone cannot do it.
- [ ] MP4/H.264 when a system ffmpeg with libx264 is present, if Safari reports come in.
- [ ] Coordinate the two sides: once Post has done a step, Pre need not search the full 3s.
