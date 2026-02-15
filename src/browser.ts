/**
 * Browser automation via Playwright.
 * Launches headless Chromium for screenshot capture.
 */

import { chromium, Browser, Page } from 'playwright';
import { ViewportSize } from './types.js';
import fs from 'fs';
import path from 'path';

let browser: Browser | null = null;
let page: Page | null = null;

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

  if (!fs.existsSync(cacheDir)) return [];

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
 * Get or create a Playwright page with the given viewport.
 * Reuses the browser instance across calls for performance.
 */
async function getPage(viewport: ViewportSize): Promise<Page> {
  if (!browser) {
    browser = await launchBrowser();
  }
  if (!page) {
    page = await browser.newPage({
      viewport,
      deviceScaleFactor: 2,
    });
  } else {
    await page.setViewportSize(viewport);
  }
  return page;
}

/**
 * Capture a screenshot using Playwright.
 * Returns the screenshot as a Buffer.
 */
export async function captureScreenshot(
  url: string,
  options: ScreenshotOptions
): Promise<Buffer> {
  const pg = await getPage(options.viewport);

  await pg.goto(url, { waitUntil: 'networkidle' });

  // Disable animations and transitions for consistent captures
  await pg.addStyleTag({
    content: '*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }',
  });

  // Wait for web fonts to finish loading
  await pg.evaluate(() => document.fonts.ready);

  // If selector specified, scroll it into view
  if (options.selector) {
    const locator = pg.locator(options.selector);
    const count = await locator.count();
    if (count === 0) {
      throw new Error(`Element not found: ${options.selector}`);
    }
    await locator.first().scrollIntoViewIfNeeded();
    await pg.waitForTimeout(200);
  }

  const screenshot = await pg.screenshot({ fullPage: options.fullPage ?? false });
  return Buffer.from(screenshot);
}

/**
 * Close the browser session and clean up resources.
 */
export async function closeBrowser(): Promise<void> {
  if (page) {
    await page.close();
    page = null;
  }
  if (browser) {
    await browser.close();
    browser = null;
  }
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
