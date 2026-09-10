import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { copyEnvFiles, detectPackageManager, freePort, isOriginKey, onPath, pointEnvFilesAt, resolvePackageManager, rewriteEnvOrigins, serveBaseCommit, serveWorkingTree, servableDir, setupStep, turboDependencyBuild } from '../../src/baseline';
import { devScript } from '../../src/pkg';
import { execSync } from 'child_process';

let dir: string;
const write = (rel: string, content: string) => {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-baseline-')));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('detectPackageManager', () => {
  it('defaults to npm when there is no lockfile', () => {
    expect(detectPackageManager(dir).bin).toBe('npm');
  });

  it('reads the lockfile in the app directory', () => {
    write('app/pnpm-lock.yaml', '');
    expect(detectPackageManager(path.join(dir, 'app')).bin).toBe('pnpm');
  });

  it('falls back to the repo root lockfile for a subdirectory app', () => {
    write('mono/yarn.lock', '');
    write('mono/site/package.json', '{}');
    expect(detectPackageManager(path.join(dir, 'mono/site'), path.join(dir, 'mono')).bin).toBe('yarn');
  });

  it('passes extra args through npm with a -- separator, and directly for pnpm', () => {
    write('npmapp/package-lock.json', '');
    write('pnpmapp/pnpm-lock.yaml', '');
    expect(detectPackageManager(path.join(dir, 'npmapp')).run('dev', ['--port', '1'])).toEqual(['run', 'dev', '--', '--port', '1']);
    expect(detectPackageManager(path.join(dir, 'pnpmapp')).run('dev', ['--port', '1'])).toEqual(['run', 'dev', '--port', '1']);
  });

  it('lets the packageManager field beat a stale lockfile', () => {
    write('declared/package-lock.json', '');
    write('declared/package.json', JSON.stringify({ packageManager: 'pnpm@10.33.0' }));
    expect(detectPackageManager(path.join(dir, 'declared')).bin).toBe('pnpm');
  });

  it('ignores a packageManager field naming something unknown', () => {
    write('odd/yarn.lock', '');
    write('odd/package.json', JSON.stringify({ packageManager: 'cnpm@1.0.0' }));
    expect(detectPackageManager(path.join(dir, 'odd')).bin).toBe('yarn');
  });
});

describe('onPath', () => {
  it('finds a binary that is there and not one that is not', () => {
    const bin = path.join(dir, 'fakebin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'somepm'), '');
    expect(onPath('somepm', { PATH: bin })).toBe(true);
    expect(onPath('otherpm', { PATH: bin })).toBe(false);
  });

  it('is not fooled by a directory of the same name', () => {
    const bin = path.join(dir, 'dirbin');
    fs.mkdirSync(path.join(bin, 'pnpm'), { recursive: true });
    expect(onPath('pnpm', { PATH: bin })).toBe(false);
  });

  it('says no when PATH is empty', () => {
    expect(onPath('npm', { PATH: '' })).toBe(false);
  });
});

describe('resolvePackageManager', () => {
  const app = () => path.join(dir, 'resolve');
  const setup = () => { write('resolve/pnpm-lock.yaml', ''); return app(); };

  it('runs what the repo declares when it is installed', () => {
    const choice = resolvePackageManager(setup(), undefined, () => true);
    expect(choice.pm?.bin).toBe('pnpm');
    // Identity, not just the name: the caller tells "we fell back" by `pm !== declared`.
    expect(choice.pm).toBe(choice.declared);
  });

  // The reported failure: a repo declaring pnpm, on a machine without it.
  it('falls back to npm and remembers what was asked for', () => {
    const choice = resolvePackageManager(setup(), undefined, bin => bin === 'npm');
    expect(choice.pm?.bin).toBe('npm');
    expect(choice.declared.bin).toBe('pnpm');
    expect(choice.pm).not.toBe(choice.declared);
  });

  it('reports that nothing can install when npm is missing too', () => {
    const choice = resolvePackageManager(setup(), undefined, () => false);
    expect(choice.pm).toBe(null);
    expect(choice.declared.bin).toBe('pnpm');
  });
});

describe('devScript', () => {
  it('prefers dev', () => {
    write('a/package.json', JSON.stringify({ scripts: { dev: 'next dev', start: 'next start' } }));
    expect(devScript(path.join(dir, 'a'))).toBe('dev');
  });

  it('falls back to start when there is no dev script', () => {
    write('b/package.json', JSON.stringify({ scripts: { start: 'serve' } }));
    expect(devScript(path.join(dir, 'b'))).toBe('start');
  });

  it('returns null when nothing can start a server', () => {
    write('c/package.json', JSON.stringify({ scripts: { test: 'vitest' } }));
    expect(devScript(path.join(dir, 'c'))).toBeNull();
    expect(devScript(path.join(dir, 'nope'))).toBeNull();
  });
});

describe('freePort', () => {
  it('returns a usable port, and a different one each time', async () => {
    const a = await freePort();
    const b = await freePort();
    expect(a).toBeGreaterThan(1023);
    expect(b).toBeGreaterThan(1023);
  });
});

describe('servableDir', () => {
  it('prefers the detected app directory when it can start a server', () => {
    write('mono2/site/package.json', JSON.stringify({ scripts: { dev: 'next dev' } }));
    write('mono2/package.json', JSON.stringify({ scripts: { dev: 'other' } }));
    expect(servableDir(path.join(dir, 'mono2'), 'site')).toEqual({ dir: path.join(dir, 'mono2/site'), script: 'dev' });
  });

  it('finds the app next door when the detected directory has no dev script', () => {
    // A PR touching only the CLI resolves to the repo root, which cannot serve.
    write('cli/package.json', JSON.stringify({ scripts: { build: 'tsc', test: 'vitest' } }));
    write('cli/site/package.json', JSON.stringify({ scripts: { dev: 'next dev' } }));
    expect(servableDir(path.join(dir, 'cli'), undefined)).toEqual({ dir: path.join(dir, 'cli/site'), script: 'dev' });
  });

  it('returns null when nothing in the tree can start a server', () => {
    write('lib/package.json', JSON.stringify({ scripts: { build: 'tsc' } }));
    expect(servableDir(path.join(dir, 'lib'), undefined)).toBeNull();
  });
});

/**
 * Serving locally fails in four distinct ways and callers treat every one as
 * "try the next option". Without a reason the run goes quiet and reports no
 * baseline with nothing for a human to act on.
 */
describe('serveBaseCommit skip reasons', () => {
  let repo: string;
  afterAll(() => { if (repo) fs.rmSync(repo, { recursive: true, force: true }); });

  it('says the tree cannot be served when no dev script exists', async () => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-skip-')));
    const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: repo, stdio: 'pipe' });
    git('init -q -b main');
    git('config user.email t@example.com');
    git('config user.name t');
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'no-scripts' }));
    git('add -A');
    git('commit -q -m init');
    const sha = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf-8' }).trim();

    const logs: string[] = [];
    const result = await serveBaseCommit({ repoRoot: repo, sha, log: m => logs.push(m) });
    expect(result).toBeNull();
    expect(logs.join('\n')).toMatch(/Could not serve base commit .*dev, serve or start script/);
  });

  it('reports a worktree it cannot check out', async () => {
    const logs: string[] = [];
    const result = await serveBaseCommit({ repoRoot: repo, sha: '0'.repeat(40), log: m => logs.push(m) });
    expect(result).toBeNull();
    expect(logs.join('\n')).toMatch(/worktree checkout failed/);
  });

  /**
   * Serving the working tree installs into the caller's own checkout, not a
   * throwaway. Substituting npm there would write a node_modules their pnpm
   * cannot use — taking screenshots must not cost someone their install.
   */
  it('will not substitute npm into the caller\'s own checkout', async () => {
    const own = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-own-')));
    fs.writeFileSync(path.join(own, 'pnpm-lock.yaml'), '');
    fs.writeFileSync(path.join(own, 'package.json'), JSON.stringify({ name: 'app', scripts: { dev: 'node -e 0' } }));
    // No node_modules, and a machine with npm but no pnpm.
    const logs: string[] = [];
    const result = await serveWorkingTree({ repoRoot: own, log: m => logs.push(m), pathHas: bin => bin === 'npm' });
    expect(result).toBeNull();
    expect(logs.join('\n')).toMatch(/pnpm is not on PATH.*would leave a node_modules/);
    expect(fs.existsSync(path.join(own, 'node_modules'))).toBe(false);
    fs.rmSync(own, { recursive: true, force: true });
  });
});

describe('copyEnvFiles', () => {
  let from: string;
  let to: string;
  beforeAll(() => {
    from = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-envsrc-')));
    to = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-envdst-')));
    fs.writeFileSync(path.join(from, '.env'), 'API_KEY=secret\n');
    fs.writeFileSync(path.join(from, '.env.local'), 'DB=postgres://local\n');
    fs.mkdirSync(path.join(from, 'apps', 'web'), { recursive: true });
    fs.writeFileSync(path.join(from, 'apps', 'web', '.env'), 'SCOPED=1\n');
  });
  afterAll(() => {
    fs.rmSync(from, { recursive: true, force: true });
    fs.rmSync(to, { recursive: true, force: true });
  });

  it('copies root env files and the app dir ones', () => {
    const copied = copyEnvFiles(from, to, path.join('apps', 'web'));
    expect(copied).toContain('.env');
    expect(copied).toContain('.env.local');
    expect(fs.readFileSync(path.join(to, '.env'), 'utf-8')).toBe('API_KEY=secret\n');
    expect(fs.readFileSync(path.join(to, 'apps', 'web', '.env'), 'utf-8')).toBe('SCOPED=1\n');
  });

  it('skips files that are absent and never reports values', () => {
    const copied = copyEnvFiles(from, to);
    expect(copied).not.toContain('.env.development');
    expect(copied.join(' ')).not.toMatch(/secret|postgres/);
  });

  it('refuses to write outside the destination', () => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-esc-')));
    const dest = path.join(parent, 'worktree');
    fs.mkdirSync(dest);
    try {
      const copied = copyEnvFiles(from, dest, path.join('..', '..'));
      // The root-level copies land inside dest and are fine; the traversing
      // prefix must contribute nothing.
      expect(copied.some(p => p.includes('..'))).toBe(false);
      expect(fs.existsSync(path.join(parent, '.env'))).toBe(false);
      expect(fs.existsSync(path.join(dest, '.env'))).toBe(true);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe('origin env vars', () => {
  it('recognises the names that mean "this app\'s own address"', () => {
    for (const key of ['BETTER_AUTH_URL', 'NEXTAUTH_URL', 'AUTH_URL', 'NEXT_PUBLIC_APP_URL', 'PUBLIC_SITE_URL', 'APP_ORIGIN', 'VITE_APP_BASE_URL']) {
      expect(isOriginKey(key)).toBe(true);
    }
  });

  it('leaves alone the names that address something else', () => {
    for (const key of ['DATABASE_URL', 'REDIS_URL', 'NEXT_PUBLIC_API_URL', 'STRIPE_WEBHOOK_URL', 'AUTH_SECRET', 'URLS']) {
      expect(isOriginKey(key)).toBe(false);
    }
  });

  it('leaves alone the generic names, which are as often a backend or a path prefix', () => {
    for (const key of ['BASE_URL', 'VITE_BASE_URL', 'PUBLIC_URL', 'SERVER_URL', 'HOST_URL', 'URL', 'NEXT_PUBLIC_URL']) {
      expect(isOriginKey(key)).toBe(false);
    }
  });

  it('substitutes the port and keeps everything else byte for byte', () => {
    const src = [
      '# baseline',
      'BETTER_AUTH_URL=http://localhost:3000',
      'NEXT_PUBLIC_APP_URL="http://localhost:3000"',
      'export AUTH_URL = http://localhost:3000  # dev',
      'DATABASE_URL=postgres://localhost:5432/app',
      'AUTH_SECRET=shhh',
      '',
    ].join('\n');
    const { text, keys } = rewriteEnvOrigins(src, 'http://localhost:51234');
    expect(keys).toEqual(['BETTER_AUTH_URL', 'NEXT_PUBLIC_APP_URL', 'AUTH_URL']);
    expect(text).toContain('BETTER_AUTH_URL=http://localhost:51234');
    expect(text).toContain('NEXT_PUBLIC_APP_URL="http://localhost:51234"');
    expect(text).toContain('export AUTH_URL = http://localhost:51234');
    expect(text).toContain('DATABASE_URL=postgres://localhost:5432/app');
    expect(text).toContain('AUTH_SECRET=shhh');
  });

  it('rewrites the worktree copies in place, root and app dir, and names no values', () => {
    const tree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-point-')));
    try {
      fs.writeFileSync(path.join(tree, '.env'), 'NEXTAUTH_URL=http://localhost:3000\nAUTH_SECRET=shhh\n');
      fs.mkdirSync(path.join(tree, 'apps', 'web'), { recursive: true });
      fs.writeFileSync(path.join(tree, 'apps', 'web', '.env.local'), 'NEXT_PUBLIC_APP_URL=http://localhost:3000\n');
      const keys = pointEnvFilesAt(tree, 'http://localhost:4321', path.join('apps', 'web'));
      expect(keys.sort()).toEqual(['NEXTAUTH_URL', 'NEXT_PUBLIC_APP_URL']);
      expect(keys.join(' ')).not.toMatch(/shhh|localhost/);
      expect(fs.readFileSync(path.join(tree, '.env'), 'utf-8')).toBe('NEXTAUTH_URL=http://localhost:4321\nAUTH_SECRET=shhh\n');
      expect(fs.readFileSync(path.join(tree, 'apps', 'web', '.env.local'), 'utf-8')).toBe('NEXT_PUBLIC_APP_URL=http://localhost:4321\n');
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
    }
  });

  it('refuses to write outside the worktree', () => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-point-esc-')));
    try {
      fs.writeFileSync(path.join(parent, '.env'), 'AUTH_URL=http://localhost:3000\n');
      fs.mkdirSync(path.join(parent, 'worktree'));
      expect(pointEnvFilesAt(path.join(parent, 'worktree'), 'http://localhost:4321', path.join('..', '..'))).toEqual([]);
      expect(fs.readFileSync(path.join(parent, '.env'), 'utf-8')).toContain(':3000');
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe('the setup step between install and dev', () => {
  let tree: string;
  const app = () => path.join(tree, 'apps', 'web');
  beforeAll(() => {
    tree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-setup-')));
    fs.mkdirSync(path.join(tree, 'apps', 'web'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'apps', 'web', 'package.json'), JSON.stringify({ name: 'web' }));
  });
  afterAll(() => fs.rmSync(tree, { recursive: true, force: true }));

  const installTurbo = () => {
    const bin = path.join(tree, 'node_modules', '.bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'turbo.cmd' : 'turbo'), '');
  };

  it('is nothing without a turbo.json', () => {
    expect(turboDependencyBuild(tree, app())).toBeNull();
  });

  it('builds the app\'s dependencies and not the app itself', () => {
    fs.writeFileSync(path.join(tree, 'turbo.json'), '{}');
    installTurbo();
    const step = turboDependencyBuild(tree, app())!;
    expect(step.argv).toEqual(['run', 'build', '--filter=web^...']);
    // turbo is a repo-wide tool, so it runs from the root, not the app.
    expect(step.cwd).toBe(tree);
    expect(step.bin).toContain(path.join('node_modules', '.bin'));
  });

  it('is nothing for a single-package repo, whose dev script is the whole build', () => {
    expect(turboDependencyBuild(tree, tree)).toBeNull();
  });

  it('is nothing when turbo is configured but not installed', () => {
    fs.rmSync(path.join(tree, 'node_modules'), { recursive: true, force: true });
    expect(turboDependencyBuild(tree, app())).toBeNull();
    installTurbo();
  });

  it('lets a configured command win, run in the app directory, through a shell', () => {
    const step = setupStep(tree, app(), '  pnpm run build:deps  ')!;
    expect(step).toMatchObject({ bin: 'pnpm run build:deps', argv: [], cwd: app(), shell: true });
    expect(setupStep(tree, app())!.label).toMatch(/^turbo /);
  });
});
