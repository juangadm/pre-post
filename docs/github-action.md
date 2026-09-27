# GitHub Action

Runs pre-post on every push to a PR and posts with the job's own token. Nobody sets up
anything per person, and there are no secrets to add. Good for teams, and for work done in
cloud agent sessions.

Add `.github/workflows/pre-post.yml`:

```yaml
name: pre-post
on: pull_request
permissions: { contents: write, pull-requests: write }
concurrency: { group: 'pre-post-${{ github.event.pull_request.number }}', cancel-in-progress: true }
jobs:
  pre-post:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { ref: '${{ github.event.pull_request.head.sha }}', fetch-depth: 0 }
      - uses: juangadm/pre-post@v1
```

The runner builds the base commit and the PR's commit and serves both (`--local`), the same
way pre-post does on a laptop with nothing deployed. No preview deployment is involved, so
Vercel's Deployment Protection never gets in the way.

## Good to know

- **Your app must start with its dev script without secrets.** If it needs environment
  variables, give them to the job with `env:`.
- **pnpm or yarn** comes from the `packageManager` field in package.json. Without one, set it
  up before the pre-post step (e.g. `pnpm/action-setup`), as any other job would.
- **Fork PRs are skipped:** their token cannot write, so there is nowhere to post.
- **Flags** go in `with: { args: '--mobile' }`.
- **The run's images**, including `sheet.png`, are kept as a workflow artifact even when
  posting fails.
- **Videos ([Moments](video.md))** are recorded when `.pre-post.json` has `"moments"`. With
  the job's own token they are linked from the PR, not played in it: GitHub only lets a
  person's login or a classic personal access token attach video. To play them inline, store
  a classic token with `repo` scope as a secret and pass it:
  `with: { github-token: '${{ secrets.PRE_POST_TOKEN }}' }`.
- **Pinned:** `@v1` runs the pre-post version released with that tag, never whatever npm
  calls `latest`.

To keep the assets branch tidy on a schedule, see [Screenshot storage](storage.md).
