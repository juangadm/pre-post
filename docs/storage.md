# Screenshot storage

Every real run adds one commit to the `pre-post-assets` branch holding that run's images —
roughly 100–200 KB for a small PR, and again on every re-run. As a rough guide, 20 PRs a
week at 3 runs each is about 9 MB a week, or ~450 MB a year.

**Treat anything captured as permanent**, and think twice before pointing pre-post at a
preview holding real data.

## Pruning

```bash
pre-post prune --days 90
```

Removes folders for PRs closed more than 90 days ago, and runs made before a PR was opened
once they are that old.

- **`prune` tidies the branch; it does not shrink the repository.** It commits a deletion,
  so the images stay in history and every link already posted in a PR keeps working.
  Actually reclaiming the space means rewriting the branch's history, which also breaks the
  images in older PRs — so that is left as your call.
- **A plain `git clone` downloads every branch**, screenshots included. Teammates who never
  look at them can skip the branch in an existing clone (git 2.29+):

  ```bash
  git config --add remote.origin.fetch '^refs/heads/pre-post-assets'
  ```

## Weekly prune workflow

```yaml
# .github/workflows/pre-post-prune.yml
on:
  schedule: [{ cron: '17 6 * * 1' }]   # Mondays
  workflow_dispatch:
permissions: { contents: write, pull-requests: read }
jobs:
  prune:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx -y @juangadm/pre-post@latest prune --days 90
        env: { GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}' }
```
