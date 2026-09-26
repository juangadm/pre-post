# Contributing

```bash
pnpm install
pnpm build
pnpm test:unit
TEST_BROWSER=true pnpm test        # needs a Chromium; npx playwright-core install chromium-headless-shell
```

- `src/` is the CLI, `skill/` the Claude Code skill, `site/` the marketing site.
  [AGENTS.md](AGENTS.md) maps every file.
- Design notes explaining past decisions live in [docs/internal](docs/internal).

**Use pnpm, not npm.** pnpm builds a symlinked `node_modules` that npm cannot read, so
`npm install` over it fails with `Cannot read properties of null (reading 'edgesOut')`. Run
`rm -rf node_modules site/node_modules` before switching either way. npm also installs the CLI
only — `site/` is a pnpm workspace member.
