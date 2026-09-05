import { describe, it, expect, afterAll } from 'vitest';
import http from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { runTasks } from '../../src/run';
import { closeBrowser } from '../../src/browser';
import { CONFIG_DEFAULTS } from '../../src/config';

const playwrightAvailable = process.env.TEST_BROWSER === 'true';

const PAGE = '<!doctype html><html><head><title>Real Site</title></head><body style="font:16px system-ui;padding:40px"><h1>The actual site</h1><p>Content that should be compared.</p></body></html>';
const LOGIN = '<!doctype html><html><head><title>Login – Vercel</title></head><body style="font:16px system-ui;padding:40px"><h1>Log in</h1><form><input type="password"></form></body></html>';

/** A server that answers every path with the page. */
function serveSite(): Promise<http.Server> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  return new Promise(resolve => server.listen(0, () => resolve(server)));
}

/**
 * A server shaped like deployment protection: a redirect to a login path that
 * answers 200. That 200 is the whole problem — the status guard cannot see it.
 */
function serveWall(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/login')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(LOGIN);
    }
    res.writeHead(307, { location: `/login?next=${encodeURIComponent(req.url ?? '/')}` });
    res.end();
  });
  return new Promise(resolve => server.listen(0, () => resolve(server)));
}

const port = (s: http.Server) => (s.address() as { port: number }).port;

describe('a side behind a sign-in wall', () => {
  const servers: http.Server[] = [];
  afterAll(async () => {
    for (const s of servers) s.close();
    await closeBrowser();
  });

  it.skipIf(!playwrightAvailable)('is reported as never captured, not as a visual change', async () => {
    const site = await serveSite();
    const wall = await serveWall();
    servers.push(site, wall);

    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-wall-'));
    const { outcomes } = await runTasks(
      [{
        route: '/',
        resolvedRoute: '/',
        viewport: 'desktop',
        size: { width: 1280, height: 800 },
        beforeUrl: `http://127.0.0.1:${port(site)}/`,
        afterUrl: `http://127.0.0.1:${port(wall)}/`,
      }],
      { outputDir, ...CONFIG_DEFAULTS },
    );

    expect(outcomes).toHaveLength(1);
    const [outcome] = outcomes;
    // The failure this guards against is `status: 'changed'` with a percentage:
    // a login page diffed against the site and published as a visual change.
    expect(outcome.status).toBe('error');
    expect(outcome.changedRatio).toBeUndefined();
    expect(outcome.blocked?.side).toBe('after');
    expect(outcome.blocked?.finalUrl).toContain('/login');
    expect(outcome.error).toContain('sign-in page');
  });

  it.skipIf(!playwrightAvailable)('still compares two sides that both reach the site', async () => {
    const a = await serveSite();
    const b = await serveSite();
    servers.push(a, b);

    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-wall-'));
    const { outcomes } = await runTasks(
      [{
        route: '/',
        resolvedRoute: '/',
        viewport: 'desktop',
        size: { width: 1280, height: 800 },
        beforeUrl: `http://127.0.0.1:${port(a)}/`,
        afterUrl: `http://127.0.0.1:${port(b)}/`,
      }],
      { outputDir, ...CONFIG_DEFAULTS },
    );

    expect(outcomes[0].blocked).toBeUndefined();
    expect(outcomes[0].status).toBe('unchanged');
  });
});
