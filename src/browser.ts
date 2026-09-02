/**
 * Browser automation via Playwright (playwright-core + Chromium headless shell).
 *
 * One browser per process, one context per viewport/auth combination, and a
 * small page pool. Captures are deterministic: fixed clock, reduced motion,
 * animations finished, caret hidden, fonts and images settled, layout stable.
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import { AuthOptions, CaptureResult, ViewportSize } from './types.js';
import { BrowserNotFoundError, HttpStatusError, NavigationError, isVercelResponse } from './errors.js';

const require = createRequire(import.meta.url);

/** Every capture sees the same wall clock, so dates and "x minutes ago" never drift. */
export const FIXED_TIME = new Date('2026-01-15T12:00:00.000Z');

const MAX_CONCURRENT_PAGES = Number(process.env.PRE_POST_CONCURRENCY) || 6;
const NAVIGATION_TIMEOUT = 30_000;

let browser: Browser | null = null;
let browserLabel = '';
const contexts = new Map<string, Promise<BrowserContext>>();

let activePages = 0;
const pageQueue: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (activePages >= MAX_CONCURRENT_PAGES) {
    await new Promise<void>(resolve => pageQueue.push(resolve));
  }
  activePages++;
}

function releaseSlot(): void {
  activePages--;
  const next = pageQueue.shift();
  if (next) next();
}

export interface ScreenshotOptions {
  viewport: ViewportSize;
  fullPage?: boolean;
  maxHeight?: number;
  scale?: number;
  selector?: string;
  settleTimeout?: number;
  wait?: number;
  auth?: AuthOptions;
}

// ============================================================
// Launch
// ============================================================

/** Directory of the playwright-core package (for its CLI and browsers.json). */
export function playwrightCoreDir(): string {
  return path.dirname(require.resolve('playwright-core/package.json'));
}

/**
 * Scan Playwright's browser cache for installed Chromium executables.
 */
function findCachedChromium(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const cacheDir = process.env.PLAYWRIGHT_BROWSERS_PATH
    || (process.platform === 'darwin'
      ? path.join(home, 'Library', 'Caches', 'ms-playwright')
      : process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ms-playwright')
        : path.join(home, '.cache', 'ms-playwright'));

  let entries: string[];
  try {
    entries = fs.readdirSync(cacheDir);
  } catch {
    return [];
  }

  const subpaths: string[] = process.platform === 'darwin'
    ? [
        path.join('chrome-mac', 'headless_shell'),
        path.join('chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        path.join('chrome-mac-arm64', 'headless_shell'),
        path.join('chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      ]
    : process.platform === 'win32'
      ? [path.join('chrome-win', 'headless_shell.exe'), path.join('chrome-win', 'chrome.exe')]
      : [
          path.join('chrome-linux', 'headless_shell'),
          path.join('chrome-headless-shell-linux64', 'chrome-headless-shell'),
          path.join('chrome-linux', 'chrome'),
        ];

  // Prefer headless shell builds, newest first.
  const sorted = entries
    .filter(e => e.startsWith('chromium'))
    .sort((a, b) => (b.includes('headless') ? 1 : 0) - (a.includes('headless') ? 1 : 0) || b.localeCompare(a));

  const candidates: string[] = [];
  for (const entry of sorted) {
    for (const sub of subpaths) {
      const full = path.join(cacheDir, entry, sub);
      if (fs.existsSync(full)) candidates.push(full);
    }
  }
  return candidates;
}

const LAUNCH_ARGS = [
  '--disable-dev-shm-usage',
  '--hide-scrollbars',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--force-color-profile=srgb',
  '--font-render-hinting=none',
];

export interface LaunchOptions {
  headless?: boolean;
}

/**
 * Launch Chromium with a fallback chain:
 * 1. Explicit custom path (PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) — override, fails hard
 * 2. Bundled Playwright Chromium (headless shell when headless)
 * 3. Any Chromium build found in Playwright's cache
 * 4. System Chrome / Edge
 */
export async function launchBrowser(opts: LaunchOptions = {}): Promise<Browser> {
  const headless = opts.headless ?? true;
  const customPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (customPath) {
    try {
      const b = await chromium.launch({ headless, executablePath: customPath, args: LAUNCH_ARGS });
      browserLabel = `custom (${customPath})`;
      return b;
    } catch (err) {
      throw new Error(
        `Failed to launch Chromium at custom path: ${customPath}\n` +
        `  ${(err as Error).message}\n\n` +
        'Either fix the path or unset PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to use auto-detection.'
      );
    }
  }

  const strategies: Array<{ label: string; options: Parameters<typeof chromium.launch>[0] }> = [
    { label: 'bundled', options: { headless, args: LAUNCH_ARGS } },
  ];
  if (headless) {
    for (const cachedPath of findCachedChromium()) {
      strategies.push({ label: `cached (${cachedPath})`, options: { headless, executablePath: cachedPath, args: LAUNCH_ARGS } });
    }
  }
  strategies.push({ label: 'system chrome', options: { headless, channel: 'chrome', args: LAUNCH_ARGS } });
  strategies.push({ label: 'system edge', options: { headless, channel: 'msedge', args: LAUNCH_ARGS } });

  let lastError: Error | null = null;
  for (const { label, options } of strategies) {
    try {
      const b = await chromium.launch(options);
      browserLabel = label;
      return b;
    } catch (err) {
      lastError = err as Error;
    }
  }

  throw new BrowserNotFoundError(lastError);
}

export type BrowserKind = 'chromium-headless-shell' | 'chromium';

/** Install a browser through playwright-core's CLI. Returns true on success. */
export function installBrowser(kind: BrowserKind): boolean {
  const cli = path.join(playwrightCoreDir(), 'cli.js');
  console.error(`Installing ${kind} (one-time, ~${kind === 'chromium' ? '170' : '80'} MB)...`);
  return spawnSync(process.execPath, [cli, 'install', kind], { stdio: 'inherit' }).status === 0;
}

/**
 * Launch, installing the right browser first if none is found.
 * Throws BrowserNotFoundError (with `installed` set) when it still cannot launch.
 */
export async function launchBrowserOrInstall(opts: LaunchOptions = {}): Promise<Browser> {
  try {
    return await launchBrowser(opts);
  } catch (err) {
    if (!(err instanceof BrowserNotFoundError)) throw err;
  }
  const installed = installBrowser(opts.headless === false ? 'chromium' : 'chromium-headless-shell');
  if (!installed) throw new BrowserNotFoundError(null, false);
  try {
    return await launchBrowser(opts);
  } catch (err) {
    if (err instanceof BrowserNotFoundError) throw new BrowserNotFoundError(err.cause, true);
    throw err;
  }
}

/** The process-wide headless browser, launched (and installed) on first use. */
export async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await launchBrowserOrInstall();
    browser.on('disconnected', () => { browser = null; contexts.clear(); });
  }
  return browser;
}

export function browserDescription(): string {
  return browserLabel;
}

// ============================================================
// Contexts
// ============================================================

function contextKey(viewport: ViewportSize, scale: number, auth?: AuthOptions): string {
  return `${viewport.width}x${viewport.height}@${scale}|${auth ? JSON.stringify(auth) : ''}`;
}

const INIT_SCRIPT = `
  (() => {
    // Deterministic pseudo-random for pages that seed layout from Math.random().
    let seed = 42;
    Math.random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    // No smooth scrolling: scrollTo() must land immediately.
    const style = document.createElement('style');
    style.setAttribute('data-pre-post', '');
    style.textContent = 'html, body, * { scroll-behavior: auto !important; } ::-webkit-scrollbar { display: none !important; }';
    const attach = () => { (document.head || document.documentElement).appendChild(style); };
    if (document.head) attach(); else document.addEventListener('DOMContentLoaded', attach, { once: true });
  })();
`;

async function getContext(viewport: ViewportSize, scale: number, auth?: AuthOptions): Promise<BrowserContext> {
  const key = contextKey(viewport, scale, auth);
  let pending = contexts.get(key);
  if (!pending) {
    pending = (async () => {
      const b = await getBrowser();
      const ctx = await b.newContext({
        viewport,
        deviceScaleFactor: scale,
        reducedMotion: 'reduce',
        colorScheme: 'light',
        locale: 'en-US',
        timezoneId: 'UTC',
        ignoreHTTPSErrors: true,
        serviceWorkers: 'block',
        extraHTTPHeaders: auth?.headers,
        bypassCSP: true,
      });
      await ctx.clock.setFixedTime(FIXED_TIME);
      await ctx.addInitScript(INIT_SCRIPT);
      if (auth?.cookies?.length) {
        await ctx.addCookies(auth.cookies.map(c => ({
          name: c.name,
          value: c.value,
          ...(c.url ? { url: c.url } : { domain: c.domain!, path: c.path || '/' }),
        })));
      }
      ctx.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);
      ctx.setDefaultTimeout(10_000);
      return ctx;
    })();
    contexts.set(key, pending);
  }
  return pending;
}

// ============================================================
// Settle
// ============================================================

/**
 * In-page settle: fonts loaded, images decoded, and layout stable across
 * consecutive animation frames. Bounded by `timeout` ms.
 */
async function settlePage(page: Page, timeout: number, options: { network?: boolean } = {}): Promise<void> {
  const settled = page.evaluate(async (timeoutMs: number) => {
    const start = performance.now();
    const remaining = () => Math.max(0, timeoutMs - (performance.now() - start));
    const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
    const frame = () => new Promise<void>(r => requestAnimationFrame(() => r()));
    const withCap = <T,>(p: Promise<T>, ms: number) => Promise.race([p, sleep(ms)]);

    if (document.fonts?.ready) await withCap(document.fonts.ready, Math.min(2500, remaining()));

    const pending = Array.from(document.images).filter(img => !img.complete);
    if (pending.length) {
      await withCap(
        Promise.allSettled(pending.map(img => img.decode().catch(() => undefined))),
        Math.min(3000, remaining()),
      );
    }

    const signature = () => {
      const de = document.documentElement;
      return `${de.scrollHeight}:${de.scrollWidth}:${document.body?.childElementCount ?? 0}:${document.getElementsByTagName('*').length}`;
    };
    let last = signature();
    let stable = 0;
    while (stable < 2 && remaining() > 0) {
      await frame();
      await frame();
      const now = signature();
      if (now === last) stable++;
      else { stable = 0; last = now; }
    }
  }, timeout);

  const quiet = options.network === false ? Promise.resolve() : waitForNetworkQuiet(page, 150, Math.min(timeout, 2500));
  await Promise.all([settled, quiet]);
}

/**
 * Resolve once no request has been in flight for `quietMs`, or after `cap` ms.
 * Cheaper than Playwright's networkidle (which insists on a 500 ms window)
 * and tolerant of dev servers that keep sockets open.
 */
function waitForNetworkQuiet(page: Page, quietMs: number, cap: number): Promise<void> {
  const tracker = inflight.get(page);
  if (!tracker) return Promise.resolve();
  return new Promise<void>(resolve => {
    let timer: NodeJS.Timeout | null = null;
    const done = () => {
      if (timer) clearTimeout(timer);
      clearTimeout(hardStop);
      tracker.listeners.delete(check);
      resolve();
    };
    const check = () => {
      if (timer) clearTimeout(timer);
      timer = tracker.count === 0 ? setTimeout(done, quietMs) : null;
    };
    const hardStop = setTimeout(done, cap);
    tracker.listeners.add(check);
    check();
  });
}

interface InflightTracker {
  count: number;
  listeners: Set<() => void>;
}

const inflight = new WeakMap<Page, InflightTracker>();

function trackRequests(page: Page): void {
  const tracker: InflightTracker = { count: 0, listeners: new Set() };
  inflight.set(page, tracker);
  const notify = () => { for (const l of tracker.listeners) l(); };
  page.on('request', req => {
    // WebSocket upgrades and event streams never "finish"; ignore them.
    if (req.resourceType() === 'websocket' || req.resourceType() === 'eventsource') return;
    tracker.count++;
    notify();
  });
  const finish = (req: { resourceType(): string }) => {
    if (req.resourceType() === 'websocket' || req.resourceType() === 'eventsource') return;
    tracker.count = Math.max(0, tracker.count - 1);
    notify();
  };
  page.on('requestfinished', finish);
  page.on('requestfailed', finish);
}

/**
 * Scroll through the page once so lazy-loaded and reveal-on-scroll content is
 * rendered before a full-page capture, then return to the top.
 */
async function primeLazyContent(page: Page, maxHeight: number): Promise<void> {
  await page.evaluate(async (limitPx: number) => {
    const frame = () => new Promise<void>(r => requestAnimationFrame(() => r()));
    const step = Math.max(200, window.innerHeight);
    const limit = Math.min(document.documentElement.scrollHeight, limitPx);
    for (let y = step; y < limit + step; y += step) {
      window.scrollTo(0, y);
      await frame();
      await frame();
    }
    window.scrollTo(0, 0);
    await frame();
  }, maxHeight);
}

// ============================================================
// Capture
// ============================================================

/**
 * Capture a screenshot. Safe to call concurrently — the page pool bounds parallelism.
 * Throws HttpStatusError for 401/403 (auth required); other statuses are returned
 * in the result so callers can decide (a 404 "before" for a new page is legitimate).
 */
export async function captureScreenshot(url: string, options: ScreenshotOptions): Promise<CaptureResult> {
  const started = Date.now();
  const scale = options.scale ?? 2;
  const settleTimeout = options.settleTimeout ?? 8000;
  const maxHeight = options.maxHeight ?? options.viewport.height * 3;

  const ctx = await getContext(options.viewport, scale, options.auth);
  await acquireSlot();
  const page = await ctx.newPage();
  trackRequests(page);
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(err => {
      throw new NavigationError(classifyNavigationError(err), url, err);
    });
    const status = response?.status();
    if (status === 401 || status === 403) throw new HttpStatusError(status, url, isVercelResponse({ get: n => response!.headers()[n] ?? null }));

    await settlePage(page, settleTimeout);

    if (options.fullPage) {
      await primeLazyContent(page, maxHeight);
      await settlePage(page, Math.min(settleTimeout, 2000), { network: false });
    }

    if (options.selector) {
      const locator = page.locator(options.selector);
      if ((await locator.count()) === 0) throw new Error(`Element not found: ${options.selector}`);
      await locator.first().scrollIntoViewIfNeeded();
    }

    if (options.wait) await page.waitForTimeout(options.wait);

    let clip: { x: number; y: number; width: number; height: number } | undefined;
    if (options.fullPage) {
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      if (height > maxHeight) clip = { x: 0, y: 0, width: options.viewport.width, height: maxHeight };
    }

    const image = await page.screenshot({
      type: 'png',
      fullPage: options.fullPage ?? false,
      animations: 'disabled',
      caret: 'hide',
      clip,
      timeout: 20_000,
    });

    return {
      image,
      viewport: options.viewport,
      url,
      status,
      selector: options.selector,
      durationMs: Date.now() - started,
    };
  } finally {
    await page.close().catch(() => undefined);
    releaseSlot();
  }
}

function classifyNavigationError(err: Error): NavigationError['kind'] {
  const msg = err.message || '';
  if (err.name === 'TimeoutError' || /Timeout .* exceeded/.test(msg)) return 'timeout';
  if (/ERR_CONNECTION_REFUSED/.test(msg)) return 'refused';
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND/.test(msg)) return 'dns';
  return 'other';
}

/**
 * Close the browser session and clean up resources.
 */
export async function closeBrowser(): Promise<void> {
  const b = browser;
  browser = null;
  contexts.clear();
  activePages = 0;
  pageQueue.length = 0;
  if (b) await b.close().catch(() => undefined);
}
