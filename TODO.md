# Pre-Post TODO

Resolved by the 1.0 rewrite (see docs/optimization-plan.md): auth-protected deployments
(`pre-post login`, `VERCEL_AUTOMATION_BYPASS_SECRET`, clear 401 hints), route detection via
the import graph, Vite support, GitHub-native storage on `pre-post-assets`, sticky PR
comment, pixel diff with crops.

## Later
- [ ] GIF/animated capture (parked; spec kept in git history)
- [ ] GitHub Action mode on top of `pre-post pr` for zero-touch PRs
- [ ] `pre-post prune` on a schedule

## Site / Hero

- [ ] Mobile layout check — stacked or scaled workspace view
- [ ] Consider reduced-motion: skip animations, show static workspace + PR side by side

## Follow-on from the trustworthiness pass

- [ ] Report layout shift as shift, not a repaint. A padding change near the top
      of a page moves everything below it, so the diff reads 60-90% for a change
      a designer calls "slightly roomier" — and CROP_MAX_RATIO drops the crop
      above 50%, so the most dramatic result gives the least useful output.
      Detect vertical displacement, report "content shifted down Npx", and diff
      the aligned images.
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

The GIF/video spec that used to live here described files that no longer exist
(src/video.ts, src/upload.ts). It is in the git history if it is ever wanted.
