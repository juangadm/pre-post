import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { reusableInstall, reuseInstall } from '../../src/baseline';

let repo: string;
let base: string;
const write = (rel: string, content: string) => {
  const file = path.join(repo, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-reuse-')));
  git('init -q -b main');
  git('config user.email t@t');
  git('config user.name t');
  write('package.json', JSON.stringify({ name: 'root', private: true }));
  write('package-lock.json', '{"lockfileVersion":3}');
  write('apps/web/package.json', JSON.stringify({ name: 'web', scripts: { dev: 'next dev' } }));
  write('apps/web/page.tsx', 'export default () => <h1>Pre</h1>;');
  write('.gitignore', 'node_modules\n');
  git('add -A');
  git('commit -qm base');
  base = git('rev-parse HEAD');
  // Installed in this checkout, with a workspace link that must stay relative.
  write('node_modules/react/index.js', 'module.exports = 1;');
  fs.mkdirSync(path.join(repo, 'apps/web/node_modules'), { recursive: true });
  fs.symlinkSync('../../../node_modules/react', path.join(repo, 'apps/web/node_modules/react'));
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('reusableInstall', () => {
  it('reuses when only code changed since the base', async () => {
    write('apps/web/page.tsx', 'export default () => <h1>Post</h1>;');
    expect((await reusableInstall(repo, base))?.sort()).toEqual(['.', 'apps/web']);
  });

  it('installs fresh when the lockfile changed, even uncommitted', async () => {
    write('package-lock.json', '{"lockfileVersion":3,"packages":{}}');
    expect(await reusableInstall(repo, base)).toBeNull();
  });

  it('installs fresh when any package.json changed', async () => {
    write('apps/web/package.json', JSON.stringify({ name: 'web', dependencies: { next: '16' } }));
    expect(await reusableInstall(repo, base)).toBeNull();
  });

  it('installs fresh when the base has no lockfile to prove the trees match', async () => {
    git('rm -q package-lock.json');
    git('commit -qm unlock');
    expect(await reusableInstall(repo, git('rev-parse HEAD'))).toBeNull();
  });

  // A generator in an install hook reads files no install input covers, so the
  // copied node_modules could hold code generated from the branch.
  it('installs fresh when the branch added an install input it has not committed', async () => {
    write('packages/ui/package.json', JSON.stringify({ name: 'ui' }));
    expect(await reusableInstall(repo, base)).toBeNull();
  });

  it('installs fresh when a package runs its own install hook', async () => {
    write('apps/web/package.json', JSON.stringify({ name: 'web', scripts: { dev: 'next dev', postinstall: 'prisma generate' } }));
    git('commit -qam hook');
    expect(await reusableInstall(repo, git('rev-parse HEAD'))).toBeNull();
  });

  it('installs fresh when node_modules holds a generated Prisma client', async () => {
    write('node_modules/.prisma/client/index.js', 'generated');
    expect(await reusableInstall(repo, base)).toBeNull();
  });

  it('skips package directories this checkout never installed', async () => {
    fs.rmSync(path.join(repo, 'apps/web/node_modules'), { recursive: true });
    expect(await reusableInstall(repo, base)).toEqual(['.']);
  });
});

describe('reuseInstall', () => {
  it('copies each node_modules into the worktree as its own tree, links kept relative', async () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-reuse-wt-'));
    fs.mkdirSync(path.join(worktree, 'apps/web'), { recursive: true });
    try {
      expect(await reuseInstall(repo, worktree, ['.', 'apps/web'])).toBe(true);
      const link = path.join(worktree, 'apps/web/node_modules/react');
      expect(fs.readlinkSync(link)).toBe('../../../node_modules/react');
      expect(fs.realpathSync(link)).toBe(fs.realpathSync(path.join(worktree, 'node_modules/react')));
      // A copy, not a link back: writing to it leaves this checkout alone.
      expect(fs.lstatSync(path.join(worktree, 'node_modules')).isSymbolicLink()).toBe(false);
      fs.writeFileSync(path.join(worktree, 'node_modules/react/index.js'), 'changed');
      expect(fs.readFileSync(path.join(repo, 'node_modules/react/index.js'), 'utf-8')).toBe('module.exports = 1;');
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true });
    }
  });
});
