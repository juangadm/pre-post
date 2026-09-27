import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { AddressInfo } from 'net';
import { recordMoments } from '../../src/video';
import { parseMoments } from '../../src/moments';
import { closeBrowser } from '../../src/browser';
import { ensureFfmpeg, MAX_CLIP_BYTES } from '../../src/ffmpeg';
import { layoutFor } from '../../src/compose';
import { MomentOutcome } from '../../src/types';

const playwrightAvailable = process.env.TEST_BROWSER === 'true';
const FIXTURES = path.resolve(__dirname, '../fixtures/pages/moments');

function serve(dir: string): Promise<http.Server> {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const file = path.join(dir, (req.url ?? '/').split('?')[0]);
      if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end(fs.readFileSync(file));
    }).listen(0, '127.0.0.1', () => resolve(server));
  });
}

const urlOf = (s: http.Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

/** One decoded frame near the end of a clip, as PNG dimensions. */
function lastFrameSize(ffmpeg: string, webm: string, seconds: number): { width: number; height: number } {
  const png = webm.replace(/\.webm$/, '.check.png');
  const res = spawnSync(ffmpeg, ['-loglevel', 'error', '-y', '-ss', String(Math.max(0, seconds - 0.2)), '-i', webm, '-frames:v', '1', png]);
  expect(res.status).toBe(0);
  const buf = fs.readFileSync(png);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe.skipIf(!playwrightAvailable)('recordMoments', () => {
  let pre: http.Server;
  let post: http.Server;
  let out: string;
  let results: MomentOutcome[];
  let ffmpeg: string;

  beforeAll(async () => {
    [pre, post] = await Promise.all([serve(path.join(FIXTURES, 'pre')), serve(path.join(FIXTURES, 'post'))]);
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-video-'));
    ffmpeg = await ensureFfmpeg();
    const moments = parseMoments([
      { name: 'Open the account menu', route: '/menu.html', steps: [{ hover: 'Account' }, { click: 'Account' }, { press: 'Escape' }] },
      { name: 'Switch to dark theme', route: '/menu.html', steps: [{ click: 'Account' }, { click: 'Theme' }] },
      { name: 'Open settings', route: '/menu.html', steps: [{ click: 'Settings' }] },
      { name: 'New page', route: '/nope.html', viewport: 'mobile', steps: [] },
      // Same name as the first: must not share its file.
      { name: 'Open the account menu', route: '/menu.html', steps: [] },
    ], 'test');
    results = await recordMoments(moments, { before: urlOf(pre), after: urlOf(post), outputDir: out });
  }, 120_000);

  afterAll(async () => {
    await closeBrowser();
    pre?.close();
    post?.close();
  });

  it('records a clip both sides can play, as a small WebM with a poster', () => {
    const m = results[0];
    expect(m.status).toBe('recorded');
    expect(m.preNote).toBeUndefined();
    const head = fs.readFileSync(m.file!).subarray(0, 4);
    expect(head.toString('hex')).toBe('1a45dfa3'); // EBML: a Matroska/WebM file
    expect(m.bytes).toBeLessThan(MAX_CLIP_BYTES);
    expect(fs.existsSync(m.poster!)).toBe(true);
    // Lead-in + three steps with their breaths + tail: a few seconds, not more.
    expect(m.durationMs).toBeGreaterThan(2500);
    expect(m.durationMs).toBeLessThan(8000);
    const layout = layoutFor({ width: 1280, height: 800 });
    expect(lastFrameSize(ffmpeg, m.file!, m.durationMs! / 1000)).toEqual({ width: layout.width, height: layout.height });
  });

  it('shows a step Pre cannot do as new, and still ships the clip', () => {
    const m = results[1];
    expect(m.status).toBe('recorded');
    expect(m.preNote).toBe('Couldn\'t find “Theme” on Pre, so it is shown as new.');
  });

  it('gives no clip, only the sentence, when Post cannot do a step', () => {
    expect(results[2]).toMatchObject({ status: 'error', error: 'Couldn\'t find “Settings” on Post (step 1).' });
    expect(results[2].file).toBeUndefined();
  });

  it('records a load-only Moment from before navigation, into a file of its own', () => {
    const m = results[4];
    expect(m.status).toBe('recorded');
    expect(m.durationMs).toBeGreaterThanOrEqual(3000);
    expect(m.file).not.toBe(results[0].file);
    expect(new Set(results.filter(r => r.file).map(r => r.file)).size).toBe(results.filter(r => r.file).length);
  });

  it('says so when the page is missing on Post', () => {
    expect(results[3]).toMatchObject({ status: 'error', error: 'Post answered HTTP 404 for /nope.html.' });
  });
});
