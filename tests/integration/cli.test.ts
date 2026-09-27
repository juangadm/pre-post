import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { PNG } from 'pngjs';

const CLI_PATH = path.resolve(__dirname, '../../dist/bin/cli.js');
const TEST_PAGES = path.resolve(__dirname, '../fixtures/pages');
const playwrightAvailable = process.env.TEST_BROWSER === 'true';

/** Async so the in-process fixture servers stay responsive while the CLI runs. */
function runCli(args: string[], cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise(resolve => {
    execFile('node', [CLI_PATH, ...args], { cwd, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const e = error as { code?: number } | null;
      resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: e ? (typeof e.code === 'number' ? e.code : 1) : 0 });
    });
  });
}

/** Serve <name>/<variant>.html as /<name>. */
function serveFixtures(variant: 'before' | 'after'): Promise<{ url: string; close: () => void }> {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const name = (req.url || '/').split('?')[0].replace(/^\/+/, '') || 'css-card';
      const file = name === 'identical' ? path.join(TEST_PAGES, 'identical', 'page.html') : path.join(TEST_PAGES, name, `${variant}.html`);
      if (!fs.existsSync(file)) { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<h1>404</h1>'); return; }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://localhost:${port}`, close: () => server.close() });
    });
  });
}

describe('CLI', () => {
  it('prints help', async () => {
    const { stdout, exitCode } = await runCli(['--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('pre-post pr');
    expect(stdout).toContain('--dry-run');
    expect(stdout).toContain('pre-post login');
  });

  it('prints the version', async () => {
    const { stdout } = await runCli(['--version']);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('requires two arguments in compare mode', async () => {
    const { exitCode } = await runCli(['https://example.com']);
    expect(exitCode).toBe(2);
  });

  it('detect prints JSON', async () => {
    const { stdout, exitCode } = await runCli(['detect']);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty('framework');
    expect(parsed).toHaveProperty('routes');
  });

  it('pr --dry-run stops with one instruction when there is nothing to capture', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-cli-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: root });
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/web.git'], { cwd: root });
      // One changed file, so there is a page to capture and the run gets as
      // far as choosing its two sides.
      fs.writeFileSync(path.join(root, 'index.html'), '<h1>hi</h1>');
      const { exitCode, stderr } = await runCli(['pr', '--dry-run'], root);
      expect(exitCode).toBe(3);
      // With no deployment and no dev server there is no "Post" side at all, so
      // that is the one thing to fix — naming the baseline first would send the
      // reader to solve the second problem.
      expect(stderr).toMatch(/dev server/i);
      expect(stderr).toContain('--after');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('pr --dry-run asks for a baseline once a Post side exists', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-cli-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: root });
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/web.git'], { cwd: root });
      fs.writeFileSync(path.join(root, 'index.html'), '<h1>hi</h1>');
      // --after supplies Post; nothing supplies Pre, and there is no PR to build one from.
      const { exitCode, stderr } = await runCli(['pr', '--dry-run', '--after', 'http://localhost:9', '--no-local-baseline'], root);
      expect(exitCode).toBe(3);
      expect(stderr).toContain('--before');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // A branch that changed nothing affects no page: nothing is served, nothing
  // is captured, and the run says so instead of comparing the home page.
  it('pr --dry-run on an unchanged branch captures nothing and says so', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-cli-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: root });
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/web.git'], { cwd: root });
      const { exitCode, stdout, stderr } = await runCli(['pr', '--dry-run'], root);
      expect(exitCode).toBe(0);
      expect(stderr).toContain('nothing to capture');
      expect(stdout).toContain('**No pages affected**');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  describe('image mode', () => {
    it('diffs two PNG files without a browser', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-img-'));
      try {
        const a = new PNG({ width: 20, height: 20 });
        const b = new PNG({ width: 20, height: 20 });
        a.data.fill(255);
        b.data.fill(255);
        b.data[0] = 0; b.data[1] = 0; b.data[2] = 0;
        fs.writeFileSync(path.join(dir, 'a.png'), PNG.sync.write(a));
        fs.writeFileSync(path.join(dir, 'b.png'), PNG.sync.write(b));
        const { stdout, exitCode } = await runCli([path.join(dir, 'a.png'), path.join(dir, 'b.png'), '--json', '-o', dir]);
        expect(exitCode).toBe(0);
        const result = JSON.parse(stdout);
        expect(result.outcomes[0].status).toBe('changed');
        expect(fs.existsSync(path.join(dir, 'diff.png'))).toBe(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('URL mode (browser)', () => {
    let before: { url: string; close: () => void };
    let after: { url: string; close: () => void };
    beforeAll(async () => {
      before = await serveFixtures('before');
      after = await serveFixtures('after');
    });
    afterAll(() => {
      before?.close();
      after?.close();
    });

    it.skipIf(!playwrightAvailable)('captures, diffs, and reports per route and viewport', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-url-'));
      try {
        const { stdout, exitCode } = await runCli(['compare', '--before', before.url, '--after', after.url, '--routes', '/button-color,/identical,/missing', '--responsive', '--full', '--json', '-o', dir]);
        expect(exitCode).toBe(0);
        const result = JSON.parse(stdout);
        const byKey = new Map(result.outcomes.map((o: any) => [`${o.route}|${o.viewport}`, o]));
        expect((byKey.get('/button-color|desktop') as any).status).toBe('changed');
        expect((byKey.get('/identical|desktop') as any).status).toBe('unchanged');
        expect((byKey.get('/missing|mobile') as any).status).toBe('error');
        expect(fs.existsSync(path.join(dir, 'button-color-desktop-before-crop.png'))).toBe(true);
        const png = PNG.sync.read(fs.readFileSync(path.join(dir, 'button-color-mobile-after.png')));
        expect(png.width).toBe(750); // 375 CSS px at 2x
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    // A deployment-triggered job also fires for pushes to main. With no open PR
    // there is nobody to show the images to, so the run must not make any.
    it.skipIf(!playwrightAvailable)('pr --require-pr exits 0 without capturing when GitHub has no open PR', async () => {
      const asked: string[] = [];
      const api = http.createServer((req, res) => {
        asked.push(req.url || '');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('[]');
      });
      await new Promise<void>(r => api.listen(0, r));
      const apiUrl = `http://localhost:${(api.address() as { port: number }).port}`;
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-nopr-'));
      const out = path.join(root, 'out');
      try {
        execFileSync('git', ['init', '-q', '-b', 'feature'], { cwd: root });
        // A commit, so there is a branch name for the lookup to ask GitHub about.
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: root });
        execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/web.git'], { cwd: root });
        const env = { ...process.env, GH_TOKEN: 'ok', GITHUB_API_URL: apiUrl };
        delete env.PRE_POST_GH_TOKEN;
        const { stdout, stderr, exitCode } = await runCli(
          ['pr', '--require-pr', '--before', before.url, '--after', after.url, '--routes', '/button-color', '--json', '-o', out], root, env);
        expect(exitCode).toBe(0);
        expect(JSON.parse(stdout).delivery.status).toBe('no-pr');
        expect(asked.some(u => u.includes('/pulls?'))).toBe(true);
        expect(stderr).not.toContain('Capturing');
        expect(fs.existsSync(out)).toBe(false);
      } finally {
        api.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    // With no token at all nothing asked GitHub, so "no open PR" would be a
    // guess. The run must not exit 0 on it; it captures and says what to set.
    it.skipIf(!playwrightAvailable)('pr --require-pr without a token does not claim there is no PR', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-notoken-'));
      const out = path.join(root, 'out');
      // A PATH holding node and git only, so no gh login can supply a token.
      const bin = path.join(root, 'bin');
      fs.mkdirSync(bin);
      fs.symlinkSync(process.execPath, path.join(bin, 'node'));
      fs.symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), path.join(bin, 'git'));
      try {
        execFileSync('git', ['init', '-q', '-b', 'feature'], { cwd: root });
        execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/web.git'], { cwd: root });
        const env: NodeJS.ProcessEnv = { ...process.env, PATH: bin };
        for (const k of ['PRE_POST_GH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_ACTIONS']) delete env[k];
        const { stdout, exitCode } = await runCli(
          ['pr', '--require-pr', '--before', before.url, '--after', after.url, '--routes', '/button-color', '--json', '-o', out], root, env);
        expect(exitCode).toBe(3);
        const result = JSON.parse(stdout);
        expect(result.delivery.status).toBe('skipped');
        expect(result.delivery.hint).toContain('PRE_POST_GH_TOKEN');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    // A hosted agent sandbox hands the run a GitHub token the API refuses.
    // Stopping there left the user with nothing; the run must capture anyway,
    // publish nothing, and end with the one sentence that fixes it.
    it.skipIf(!playwrightAvailable)('pr captures and exits 3 with the fix when GitHub refuses the token', async () => {
      const api = http.createServer((_req, res) => {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Bad credentials' }));
      });
      await new Promise<void>(r => api.listen(0, r));
      const apiUrl = `http://localhost:${(api.address() as { port: number }).port}`;
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-refused-'));
      const out = path.join(root, 'out');
      try {
        execFileSync('git', ['init', '-q'], { cwd: root });
        execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/web.git'], { cwd: root });
        const env = { ...process.env, GH_TOKEN: 'refused', GITHUB_API_URL: apiUrl };
        delete env.PRE_POST_GH_TOKEN;
        delete env.GITHUB_ACTIONS;
        const { stdout, stderr, exitCode } = await runCli(
          ['pr', '--before', before.url, '--after', after.url, '--routes', '/button-color', '--json', '-o', out], root, env);
        expect(exitCode).toBe(3);
        const result = JSON.parse(stdout);
        expect(result.delivery.status).toBe('skipped');
        expect(result.delivery.hint).toContain('GH_TOKEN');
        expect(stderr).toContain(result.delivery.hint);
        expect(result.outcomes[0].status).toBe('changed');
        expect(fs.existsSync(path.join(out, 'button-color-desktop-before-crop.png'))).toBe(true);
        expect(result.sheetPath).toBe(path.join(out, 'sheet.png'));
        expect(fs.existsSync(result.sheetPath)).toBe(true);
      } finally {
        api.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
