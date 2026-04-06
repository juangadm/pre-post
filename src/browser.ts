/**
 * Browser automation via Playwright.
 * Launches headless Chromium for screenshot capture.
 */

import { chromium, Browser, Page } from 'playwright';
import { ViewportSize } from './types.js';
import fs from 'fs';
import path from 'path';

let browser: Browser | null = null;

const MAX_CONCURRENT_PAGES = Number(process.env.PRE_POST_CONCURRENCY) || 4;
let activePages = 0;
const pageQueue: Array<(value: void) => void> = [];

/**
 * Get the shared Browser instance (creating it if needed).
 * Used by video.ts to create fresh pages without animation-killing CSS.
 */
export async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await launchBrowser();
  }
  return browser;
}

/**
 * Acquire a page from the pool. Blocks if MAX_CONCURRENT_PAGES are in use.
 * Each page gets its own viewport and deviceScaleFactor.
 */
export async function acquirePage(viewport: ViewportSize): Promise<Page> {
  if (activePages >= MAX_CONCURRENT_PAGES) {
    await new Promise<void>(resolve => pageQueue.push(resolve));
  }
  activePages++;
  const b = await getBrowser();
  return b.newPage({ viewport, deviceScaleFactor: 2 });
}

/**
 * Release a page back to the pool (closes it).
 */
export async function releasePage(pg: Page): Promise<void> {
  activePages--;
  if (!pg.isClosed()) await pg.close();
  const next = pageQueue.shift();
  if (next) next();
}

export interface ScreenshotOptions {
  viewport: ViewportSize;
  fullPage?: boolean;
  selector?: string;
}

/**
 * Scan Playwright's cache directory for any installed Chromium executables.
 * Returns paths to try, in order of preference.
 */
function findCachedChromium(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const cacheDir = process.env.PLAYWRIGHT_BROWSERS_PATH
    || path.join(home, '.cache', 'ms-playwright');

  let entries: string[];
  try {
    entries = fs.readdirSync(cacheDir);
  } catch {
    return [];
  }

  const knownSubpaths: string[] = [];
  if (process.platform === 'darwin') {
    knownSubpaths.push(path.join('chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
  } else if (process.platform === 'win32') {
    knownSubpaths.push(path.join('chrome-win', 'chrome.exe'));
  } else {
    knownSubpaths.push(
      path.join('chrome-linux', 'chrome'),
      path.join('chrome-headless-shell-linux64', 'chrome-headless-shell'),
    );
  }

  const candidates: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith('chromium')) continue;

    for (const sub of knownSubpaths) {
      const fullPath = path.join(cacheDir, entry, sub);
      if (fs.existsSync(fullPath)) candidates.push(fullPath);
    }
  }

  return candidates;
}

/**
 * Launch Chromium with a fallback chain:
 * 1. Explicit custom path (PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) — treated as override, fails hard
 * 2. System Chrome
 * 3. Bundled Playwright Chromium
 * 4. Any Chromium build found in Playwright's cache
 */
async function launchBrowser(): Promise<Browser> {
  // If user explicitly set a custom path, treat it as an override — don't fallback
  const customPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (customPath) {
    try {
      return await chromium.launch({ headless: true, executablePath: customPath });
    } catch (err) {
      throw new Error(
        `Failed to launch Chromium at custom path: ${customPath}\n` +
        `  ${(err as Error).message}\n\n` +
        'Either fix the path or unset PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to use auto-detection.'
      );
    }
  }

  // Auto-detection: try each strategy in order
  const strategies: Array<{ label: string; options: Parameters<typeof chromium.launch>[0] }> = [
    { label: 'System Chrome', options: { headless: true, channel: 'chrome' } },
    { label: 'Bundled Playwright Chromium', options: { headless: true } },
  ];

  for (const cachedPath of findCachedChromium()) {
    strategies.push({ label: `Cached (${cachedPath})`, options: { headless: true, executablePath: cachedPath } });
  }

  for (const { options } of strategies) {
    try {
      return await chromium.launch(options);
    } catch { /* try next */ }
  }

  throw new Error(
    'No usable Chromium found.\n' +
    '  1. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome\n' +
    '  2. Or run: npx playwright install chromium\n' +
    '  3. For pre-captured images: pre-post before.png after.png --markdown'
  );
}

/**
 * Capture a screenshot using Playwright.
 * Acquires a page from the pool, captures, and releases.
 * Safe to call concurrently — pool limits parallelism.
 */
export async function captureScreenshot(
  url: string,
  options: ScreenshotOptions
): Promise<Buffer> {
  const pg = await acquirePage(options.viewport);

  try {
    await pg.goto(url, { waitUntil: 'domcontentloaded' });
    await Promise.race([
      pg.waitForLoadState('networkidle'),
      pg.waitForTimeout(3000),
    ]);

    // Disable animations and transitions for consistent captures
    await pg.addStyleTag({
      content: '*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }',
    });

    // Wait for web fonts (capped at 2s to avoid slow CDN hangs)
    await Promise.race([
      pg.evaluate(() => document.fonts.ready),
      pg.waitForTimeout(2000),
    ]);

    // If selector specified, scroll it into view
    if (options.selector) {
      const locator = pg.locator(options.selector);
      const count = await locator.count();
      if (count === 0) {
        throw new Error(`Element not found: ${options.selector}`);
      }
      await locator.first().scrollIntoViewIfNeeded();
    }

    const screenshot = await pg.screenshot({ fullPage: options.fullPage ?? false });
    return Buffer.from(screenshot);
  } finally {
    await releasePage(pg);
  }
}

/**
 * Close the browser session and clean up resources.
 */
export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
  activePages = 0;
  pageQueue.length = 0;
}

/**
 * Read a pre-captured screenshot from disk.
 * Used in MCP mode where Playwright MCP saves files directly.
 */
export function readScreenshot(filepath: string): Buffer {
  if (!fs.existsSync(filepath)) {
    throw new Error(`Screenshot not found: ${filepath}`);
  }
  return fs.readFileSync(filepath);
}
