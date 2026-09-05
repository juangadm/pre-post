import { describe, it, expect, afterAll } from 'vitest';
import http from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { runTasks } from '../../src/run';
import { closeBrowser } from '../../src/browser';
import { CONFIG_DEFAULTS } from '../../src/config';
import { looksLikeDifferentSites } from '../../src/sameness';
import { runCompare } from '../../src/commands/compare';
import { NeedsHumanError } from '../../src/errors';

const playwrightAvailable = process.env.TEST_BROWSER === 'true';

const wrap = (title: string, body: string, bg: string, fg: string) =>
  `<!doctype html><html><head><title>${title}</title></head>` +
  `<body style="font:16px system-ui;padding:40px;background:${bg};color:${fg}">${body}</body></html>`;

const SITE_BODY = `<h1>pre-post</h1>
  <p>Before and after screenshots for pull requests: route detection from the git diff,
  deterministic Playwright captures, a pixel diff, and one block at the top of the description.</p>
  <ul><li>Route detection</li><li>Deterministic captures</li><li>Pixel diff</li><li>Publishing assets</li></ul>`;

const OTHER_BODY = `<h1>Ledgerly</h1>
  <p>Accounting that closes the books before you do. Ledgerly reconciles every ledger and bank
  feed nightly, so month-end is a review rather than a rebuild.</p>
  <ul><li>Reconciliation</li><li>Close checklist</li><li>Audit trail</li><li>Immutable history</li></ul>`;

const serve = (html: string): Promise<http.Server> => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  return new Promise(resolve => server.listen(0, () => resolve(server)));
};

const port = (s: http.Server) => (s.address() as { port: number }).port;

const compare = async (a: http.Server, b: http.Server) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-sameness-'));
  return runTasks(
    ['desktop', 'mobile'].map(viewport => ({
      route: '/',
      resolvedRoute: '/',
      viewport,
      size: viewport === 'desktop' ? { width: 1280, height: 800 } : { width: 390, height: 844 },
      beforeUrl: `http://127.0.0.1:${port(a)}/`,
      afterUrl: `http://127.0.0.1:${port(b)}/`,
    })),
    { outputDir, ...CONFIG_DEFAULTS },
  );
};

describe('telling a different site from a changed one', () => {
  const servers: http.Server[] = [];
  afterAll(async () => {
    for (const s of servers) s.close();
    await closeBrowser();
  });

  it.skipIf(!playwrightAvailable)('calls two unrelated sites what they are', async () => {
    const site = await serve(wrap('pre-post', SITE_BODY, '#fff', '#111'));
    const other = await serve(wrap('Ledgerly', OTHER_BODY, '#fff', '#111'));
    servers.push(site, other);

    const { outcomes, verdict } = await compare(site, other);
    expect(looksLikeDifferentSites(outcomes)).toBe(true);
    expect(verdict?.kind).toBe('different-sites');
    // The point of the check: the pixel ratio does not give this away. Two
    // mostly-white pages differ in only a few percent of their pixels, which is
    // why a "~100% changed" rule would never have caught it.
    for (const o of outcomes) expect(o.changedRatio ?? 0).toBeLessThan(0.5);
  });

  it.skipIf(!playwrightAvailable)('does not cry wolf over a redesign of the same site', async () => {
    // Same words, inverted palette: the case that reads ~100% changed.
    const light = await serve(wrap('pre-post', SITE_BODY, '#ffffff', '#111111'));
    const dark = await serve(wrap('pre-post', SITE_BODY, '#0b0f19', '#e9edf5'));
    servers.push(light, dark);

    const { outcomes, verdict } = await compare(light, dark);
    expect(looksLikeDifferentSites(outcomes)).toBe(false);
    expect(verdict).toBe(null);
    // Guards the assertion above against passing because the redesign stopped
    // being a redesign: it has to be a large visual change and still pass.
    expect(Math.max(...outcomes.map(o => o.changedRatio ?? 0))).toBeGreaterThan(0.5);
  });

  /**
   * The single-route case: `--routes /`, or the `/` fallback when the diff
   * names none. A branch that rewrites every word on that one page must still
   * publish — the two viewports of it are one page's evidence, not two pages
   * agreeing, and the title still names the site.
   */
  it.skipIf(!playwrightAvailable)('publishes a one-page copy rewrite instead of rejecting it', async () => {
    const before = await serve(wrap('pre-post', SITE_BODY, '#fff', '#111'));
    const rewritten = await serve(wrap('pre-post', OTHER_BODY, '#fff', '#111'));
    servers.push(before, rewritten);

    const { outcomes, verdict } = await compare(before, rewritten);
    // The body text genuinely shares nothing — the guard is the title, and the
    // fact that one route cannot corroborate itself across viewports.
    for (const o of outcomes) expect(o.textOverlap).toBeLessThan(0.1);
    expect(outcomes.every(o => (o.titleOverlap ?? 0) > 0.1)).toBe(true);
    expect(looksLikeDifferentSites(outcomes)).toBe(false);
    expect(verdict).toBe(null);
  });

  /**
   * The hole this move closed. Both gates used to be written out in `pr`, so
   * the two-URL mode had neither and printed a confident percentage for two
   * unrelated sites. The verdict now comes back with the outcomes, so a caller
   * cannot get the numbers without the reason not to trust them.
   */
  it.skipIf(!playwrightAvailable)('stops the two-URL mode too, not just pr', async () => {
    const site = await serve(wrap('pre-post', SITE_BODY, '#fff', '#111'));
    const other = await serve(wrap('Ledgerly', OTHER_BODY, '#fff', '#111'));
    servers.push(site, other);

    await expect(runCompare({
      before: `http://127.0.0.1:${port(site)}/`,
      after: `http://127.0.0.1:${port(other)}/`,
      output: fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-compare-')),
    })).rejects.toThrow(NeedsHumanError);
  });

  it.skipIf(!playwrightAvailable)('still compares two URLs that are the same site', async () => {
    const a = await serve(wrap('pre-post', SITE_BODY, '#fff', '#111'));
    const b = await serve(wrap('pre-post', SITE_BODY, '#0b0f19', '#e9edf5'));
    servers.push(a, b);

    const result = await runCompare({
      before: `http://127.0.0.1:${port(a)}/`,
      after: `http://127.0.0.1:${port(b)}/`,
      output: fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-compare-')),
    });
    expect(result.outcomes[0].status).toBe('changed');
  });

  it.skipIf(!playwrightAvailable)('is quiet about the same site captured twice', async () => {
    const a = await serve(wrap('pre-post', SITE_BODY, '#fff', '#111'));
    const b = await serve(wrap('pre-post', SITE_BODY, '#fff', '#111'));
    servers.push(a, b);

    const { outcomes, verdict } = await compare(a, b);
    expect(looksLikeDifferentSites(outcomes)).toBe(false);
    expect(verdict).toBe(null);
    for (const o of outcomes) expect(o.textOverlap).toBe(1);
  });
});
