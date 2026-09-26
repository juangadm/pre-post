# pre-post

**See the change before you read the diff.**

pre-post puts before/after screenshots of every page your branch touched at the top of the
pull request. One command finds the changed routes, captures Pre and Post, highlights what
moved, and updates the PR description. No setup, no pasting images.

```
$ npx -y @juangadm/pre-post@latest pr

Routes (nextjs-app, 41ms): /, /pricing
Capturing 4 screenshots (2 route(s) × 1 viewport(s)) ...
  changed  /pricing @ desktop (0.64%, 2036ms)
  same     / @ desktop (0.00%, 2211ms)
Updated PR description: https://github.com/acme/web/pull/42
```

## Get started

Pick one. None of them installs anything permanently.

**In Claude Code**: install the skill once, then say `/pre-post` after a UI change.

```bash
npx skills add juangadm/pre-post -y
```

**In a terminal**: run it on a branch with an open PR.

```bash
npx -y @juangadm/pre-post@latest pr
```

**On every PR, automatically**: add the [GitHub Action](docs/github-action.md). No tokens or
secrets needed.

### You'll need

- **Node 20+**
- **A GitHub token** with write access: `gh auth login`, or set `GH_TOKEN`
- **An open PR**: without one, pre-post prints the markdown for you to paste

The first run downloads a small browser (~80 MB). Stuck? Run
`npx -y @juangadm/pre-post@latest doctor`.

## Everyday commands

```bash
pre-post pr                              # screenshot this branch's PR
pre-post pr --routes /pricing,/docs      # only these pages
pre-post pr -r                           # desktop and mobile
pre-post pr --before https://acme.com    # set the "before" site (remembered)
pre-post pr --dry-run                    # try it without posting
pre-post login https://staging.acme.com  # sign in once for protected sites
pre-post doctor                          # check your setup
```

If pre-post needs something from you, it stops with one sentence saying exactly what.

## How it decides what "before" is

Post (your branch) is the PR's preview deployment, or a local dev server. Pre is the
production site your branch forked from. When nothing is deployed, pre-post builds the base
commit itself, so it works in CI and in sandboxes too. It never guesses: if it can't find a
trustworthy baseline, it tells you which flag to pass.

Screenshots are stored on a `pre-post-assets` branch in your own repo, so only people who can
see the repo can see them. Nothing is committed to your PR branch.

## Learn more

| | |
|---|---|
| [How it works](docs/how-it-works.md) | How Pre and Post are chosen, capture, diffing, layout shifts |
| [GitHub Action](docs/github-action.md) | Run on every PR with no per-person setup |
| [Reference](docs/reference.md) | All commands, exit codes, `.pre-post.json`, environment variables |
| [Screenshot storage](docs/storage.md) | How much space it uses and how to prune it |
| [Contributing](CONTRIBUTING.md) | Build and test locally |

## Credits

Forked from [before-and-after](https://github.com/vercel-labs/before-and-after) by James
Clements / Vercel Labs. MIT licensed.
