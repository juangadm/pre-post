import { describe, it, expect } from 'vitest';
import http from 'http';
import path from 'path';
import { captureScreenshot, captureBeforeAfter } from '../../src/capture';
import { closeBrowser } from '../../src/browser';
import { diffImages } from '../../src/diff';
import { isChanged } from '../../src/run';
import { CONFIG_DEFAULTS } from '../../src/config';
import fs from 'fs';

const TEST_PAGES = path.resolve(__dirname, '../fixtures/pages');

// Browser tests require Playwright browsers to be installed
// Set TEST_BROWSER=true to enable
const playwrightAvailable = process.env.TEST_BROWSER === 'true';

function fileUrl(relativePath: string): string {
  return `file://${path.join(TEST_PAGES, relativePath)}`;
}

function isValidPng(buf: Buffer): boolean {
  return buf.length > 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4E &&
    buf[3] === 0x47;
}

function getPngDimensions(buf: Buffer): { width: number; height: number } {
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

describe('captureScreenshot', () => {
  it.skipIf(!playwrightAvailable)('captures screenshot from file:// URL', async () => {
    const result = await captureScreenshot({
      url: fileUrl('css-card/before.html'),
    });
    expect(result.image).toBeInstanceOf(Buffer);
    expect(result.image.length).toBeGreaterThan(1000);
    expect(isValidPng(result.image)).toBe(true);
    expect(result.url).toContain('css-card/before.html');
  });

  it.skipIf(!playwrightAvailable)('captures full page screenshot', async () => {
    const result = await captureScreenshot({
      url: fileUrl('responsive-layout/after.html'),
      fullPage: true,
    });
    expect(isValidPng(result.image)).toBe(true);
    const dims = getPngDimensions(result.image);
    // With deviceScaleFactor: 2, dimensions are 2x viewport
    expect(dims.height).toBeGreaterThanOrEqual(result.viewport.height * 2);
  });

  it.skipIf(!playwrightAvailable)('scrolls element into view when selector provided', async () => {
    const result = await captureScreenshot({
      url: fileUrl('css-card/before.html'),
      selector: '.card',
    });
    expect(isValidPng(result.image)).toBe(true);
    expect(result.selector).toBe('.card');
  });

  it.skipIf(!playwrightAvailable)('applies desktop viewport by default', async () => {
    const result = await captureScreenshot({
      url: fileUrl('css-card/before.html'),
    });
    expect(result.viewport).toEqual({ width: 1280, height: 800 });
  });

  it.skipIf(!playwrightAvailable)('applies mobile viewport when configured', async () => {
    const result = await captureScreenshot({
      url: fileUrl('css-card/before.html'),
      viewport: 'mobile',
    });
    expect(result.viewport).toEqual({ width: 375, height: 812 });
    const dims = getPngDimensions(result.image);
    // deviceScaleFactor: 2 → 750px width
    expect(dims.width).toBe(750);
  });

  it.skipIf(!playwrightAvailable)('applies tablet viewport when configured', async () => {
    const result = await captureScreenshot({
      url: fileUrl('css-card/before.html'),
      viewport: 'tablet',
    });
    expect(result.viewport).toEqual({ width: 768, height: 1024 });
  });

  it.skipIf(!playwrightAvailable)('applies custom viewport dimensions', async () => {
    const result = await captureScreenshot({
      url: fileUrl('css-card/before.html'),
      viewport: { width: 1920, height: 1080 },
    });
    expect(result.viewport).toEqual({ width: 1920, height: 1080 });
    const dims = getPngDimensions(result.image);
    // deviceScaleFactor: 2 → 3840px width
    expect(dims.width).toBe(3840);
  });

  it.skipIf(!playwrightAvailable)('captures at 2x scale (retina)', async () => {
    const result = await captureScreenshot({
      url: fileUrl('css-card/before.html'),
      viewport: { width: 400, height: 300 },
    });
    expect(result.viewport).toEqual({ width: 400, height: 300 });
    const dims = getPngDimensions(result.image);
    // deviceScaleFactor: 2 → double the dimensions
    expect(dims.width).toBe(800);
    expect(dims.height).toBe(600);
  });
});

describe('captureBeforeAfter', () => {
  it.skipIf(!playwrightAvailable)('captures before and after as a pair from string URLs', async () => {
    const result = await captureBeforeAfter({
      before: fileUrl('css-card/before.html'),
      after: fileUrl('css-card/after.html'),
    });
    expect(isValidPng(result.before.image)).toBe(true);
    expect(isValidPng(result.after.image)).toBe(true);
    expect(result.before.url).toContain('before.html');
    expect(result.after.url).toContain('after.html');
  });

  it.skipIf(!playwrightAvailable)('captures before and after with shared viewport', async () => {
    const result = await captureBeforeAfter({
      before: fileUrl('css-card/before.html'),
      after: fileUrl('css-card/after.html'),
      viewport: 'mobile',
    });
    expect(result.before.viewport).toEqual({ width: 375, height: 812 });
    expect(result.after.viewport).toEqual({ width: 375, height: 812 });
  });

  it.skipIf(!playwrightAvailable)('captures before and after with individual options', async () => {
    const result = await captureBeforeAfter({
      before: {
        url: fileUrl('css-card/before.html'),
        selector: '.card',
      },
      after: {
        url: fileUrl('css-card/after.html'),
        selector: '.card',
      },
    });
    expect(result.before.selector).toBe('.card');
    expect(result.after.selector).toBe('.card');
    expect(isValidPng(result.before.image)).toBe(true);
    expect(isValidPng(result.after.image)).toBe(true);
  });
});

/**
 * Playwright routes loopback through the launch proxy even when NO_PROXY lists
 * localhost, so a proxy that refuses localhost used to render its own error
 * page for both sides of a comparison — and the run reported "no visual
 * changes" for a PR that changed plenty. Loopback must ignore the proxy.
 */
describe('loopback capture with a proxy configured', () => {
  it.skipIf(!playwrightAvailable)('ignores the proxy for localhost and renders the real page', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>real page</title><body style="background:#0af">hello');
    });
    await new Promise<void>(r => server.listen(0, r));
    const port = (server.address() as { port: number }).port;

    // A proxy that is not listening at all: any request routed through it fails.
    const saved = { https: process.env.HTTPS_PROXY, http: process.env.HTTP_PROXY, no: process.env.NO_PROXY };
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
    process.env.HTTP_PROXY = 'http://127.0.0.1:1';
    delete process.env.NO_PROXY;
    try {
      await closeBrowser();
      const result = await captureScreenshot({ url: `http://localhost:${port}/` });
      expect(result.status).toBe(200);
      expect(isValidPng(result.image)).toBe(true);
    } finally {
      await closeBrowser();
      process.env.HTTPS_PROXY = saved.https ?? '';
      process.env.HTTP_PROXY = saved.http ?? '';
      if (saved.no === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = saved.no;
      if (!saved.https) delete process.env.HTTPS_PROXY;
      if (!saved.http) delete process.env.HTTP_PROXY;
      server.close();
    }
  });
});

/**
 * A page that animates on its own timers used to be captured at whatever frame
 * the network happened to deliver, so the same unchanged page read as changed
 * whenever one side was slower than the other. Capture time must not be an
 * input to what gets captured.
 */
describe('timer-driven animation', () => {
  const animated = fileUrl('animated-timeline/page.html');

  it.skipIf(!playwrightAvailable)('captures the same frame however long after load it is captured', async () => {
    const first = await captureScreenshot({ url: animated, fullPage: true });
    await new Promise(resolve => setTimeout(resolve, 1200));
    const second = await captureScreenshot({ url: animated, fullPage: true });
    expect(diffImages(first.image, second.image).changedPixels).toBe(0);
  });

  it.skipIf(!playwrightAvailable)('finds a selector whose element is mounted by a timer', async () => {
    // The selector is resolved after the timeline has run, not before: with the
    // clock held, an element that mounts on a timer does not exist until then.
    const result = await captureScreenshot({ url: fileUrl('late-mount/page.html'), selector: '.card' });
    expect(isValidPng(result.image)).toBe(true);
    expect(result.selector).toBe('.card');
  });

  it.skipIf(!playwrightAvailable)('still moves the page forward when asked to wait', async () => {
    // Guards the test above against passing because the fixture stopped
    // animating: --wait runs the page's timeline on, so this must differ.
    const settled = await captureScreenshot({ url: animated, fullPage: true });
    const later = await captureScreenshot({ url: animated, fullPage: true, wait: 1500 });
    expect(diffImages(settled.image, later.image).changedPixels).toBeGreaterThan(0);
  });
});

/**
 * The calibration ladder.
 *
 * Every rung is one deliberate visual change of increasing painted area; every
 * noise fixture renders identically on both sides. Together they place the
 * change threshold: real changes must all land above it and no-ops must all
 * land at zero. Without this the threshold is a constant nobody can defend.
 */
describe('change threshold calibration', () => {
  const SCALE = CONFIG_DEFAULTS.scale;
  const AREA = CONFIG_DEFAULTS.minChangedArea;
  const dirs = fs.existsSync(TEST_PAGES) ? fs.readdirSync(TEST_PAGES) : [];
  const rungs = dirs.filter(d => d.startsWith('rung-')).sort();
  const noise = dirs.filter(d => d.startsWith('noise-')).sort();
  // The ladder's other axis. Every rung varies painted area at full contrast;
  // these vary contrast at a fixed, large area. Without them the pixel
  // threshold is unmeasured, which is how a #ffffff -> #e6e6e6 card covering a
  // sixth of the viewport once reported zero changed pixels.
  const contrast = dirs.filter(d => d.startsWith('contrast-')).sort();

  async function measure(name: string): Promise<number> {
    const [before, after] = await Promise.all([
      captureScreenshot({ url: fileUrl(`${name}/before.html`), fullPage: true, scale: SCALE }),
      captureScreenshot({ url: fileUrl(`${name}/after.html`), fullPage: true, scale: SCALE }),
    ]);
    return diffImages(before.image, after.image).changedPixels / (SCALE * SCALE);
  }

  it.skipIf(!playwrightAvailable)('reports every no-op as no change', async () => {
    expect(noise.length).toBeGreaterThan(0);
    for (const name of noise) {
      const area = await measure(name);
      expect(area, `${name} should render identically`).toBe(0);
    }
  });

  it.skipIf(!playwrightAvailable)('reports every deliberate change as changed', async () => {
    expect(rungs.length).toBeGreaterThan(0);
    for (const name of rungs) {
      const area = await measure(name);
      expect(
        isChanged(
          { changedPixels: area * SCALE * SCALE, changedRatio: 0 },
          { minChangedArea: AREA, threshold: CONFIG_DEFAULTS.threshold, scale: SCALE },
        ),
        `${name} covers ${area.toFixed(0)} CSS px², threshold is ${AREA}`,
      ).toBe(true);
    }
  });

  it.skipIf(!playwrightAvailable)('reports a low-contrast change as changed', async () => {
    expect(contrast.length).toBeGreaterThan(0);
    for (const name of contrast) {
      // contrast-05 is a 5/255 delta — under the threshold by design, and named
      // so the ladder records where the floor is rather than pretending to have
      // none. Everything above it must register.
      if (name === 'contrast-05') continue;
      const area = await measure(name);
      expect(area, `${name} should not vanish into the pixel threshold`).toBeGreaterThan(0);
    }
  });

  it.skipIf(!playwrightAvailable)('keeps the threshold clear of the smallest real change', async () => {
    // The smallest rung is a recoloured 16px icon. The threshold must sit well
    // under it, because missing a real change is far worse than reporting a
    // marginal one.
    const areas = await Promise.all(rungs.map(measure));
    expect(Math.min(...areas)).toBeGreaterThan(AREA * 2);
  });
});
