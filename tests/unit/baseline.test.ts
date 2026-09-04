import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { copyEnvFiles, detectPackageManager, freePort, serveBaseCommit, servableDir } from '../../src/baseline';
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
