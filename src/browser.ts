/**
 * Browser automation via Playwright (playwright-core + Chromium headless shell).
 *
 * One browser per process, a fresh context per capture, and a small page pool.
 * Captures are deterministic: the page's own timeline is held still and
 * advanced by a fixed budget, reduced motion, animations finished, caret
 * hidden, fonts and images settled, layout stable.
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { AuthOptions, CaptureResult, PageError, ViewportSize } from './types.js';
import { BrowserNotFoundError, HttpStatusError, NavigationError, isVercelResponse } from './errors.js';


const require = createRequire(import.meta.url);

/** Every capture sees the same wall clock, so dates and "x minutes ago" never drift. */
export const FIXED_TIME = new Date('2026-01-15T12:00:00.000Z');

/**
 * How much of the page's own timeline to run before capturing.
 *
 * The clock is frozen while the page loads, so this is the *only* time a
 * timer-driven animation gets, and it is the same on both sides of a
 * comparison however fast each host answered. Long enough for entrance
 * animations to land, short enough to stay cheap.
 */
export const TIMELINE_BUDGET_MS = 600;

/**
 * How far past the budget the timeline may run while the page is still
 * animating.
 *
 * A fixed budget lands a longer animation on whatever frame it reaches. The
 * lab site's dithered image reveals over 1000ms, so at 600ms every capture
 * was mid-reveal, and which frame each side reached depended on where on the
 * page the image sat — a 48px move put Pre and Post on different frames and
 * published the difference as a change. Running on until the page stops
 * asking for frames lets a finite animation finish on both sides; the cap
 * keeps a page that animates forever from holding the capture.
 */
export const TIMELINE_MAX_MS = 3000;

/** Page time between checks for "still animating". */
const IDLE_CHECK_MS = 100;

/** One animation frame of that budget. */
const FRAME_MS = 16;

/** Real-time gap between layout-stability polls (page timers are frozen). */
const STABILITY_POLL_MS = 30;

/** Hosts that are always served from this machine. */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'];

const MAX_CONCURRENT_PAGES = Number(process.env.PRE_POST_CONCURRENCY) || 6;
const NAVIGATION_TIMEOUT = 30_000;

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;
let browserLabel = '';

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
 * Proxy settings for the capture browser, from the environment.
 *
 * Node's fetch and Chromium each ignore the standard proxy variables unless
 * told, so on a corporate network or in a sandboxed container the probes can
 * succeed while every capture times out.
 *
 * Playwright appends `<-loopback>` to Chromium's bypass list whenever a launch
 * proxy is set, which forces localhost *through* the proxy however NO_PROXY is
 * written. A proxy that refuses localhost then serves its own error page on
 * both sides of a comparison, the diff comes out byte-identical, and the run
 * reports "no visual changes" for a PR that changed plenty. So loopback is
 * named in the bypass list and the forcing is switched off at launch.
 */
export function proxyFromEnv(env: NodeJS.ProcessEnv = process.env): { server: string; bypass?: string } | undefined {
  const server = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!server) return undefined;
  const noProxy = env.NO_PROXY || env.no_proxy;
  // Playwright wants a comma-separated bypass list and always resolves
  // loopback directly, so only non-empty custom entries are worth passing.
  const entries = (noProxy ?? '').split(',').map(h => h.trim()).filter(Boolean);
  // Loopback is always direct: it is a dev server on this machine, never
  // something the proxy could route to.
  for (const host of LOOPBACK_HOSTS) if (!entries.includes(host)) entries.push(host);
  return { server, bypass: entries.join(',') };
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
  const proxy = proxyFromEnv();
  // Checked in Playwright's own process, so it has to be set here rather than
  // passed to the browser. Without it the bypass list above is ignored for
  // loopback.
  if (proxy) process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1';
  const customPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (customPath) {
    try {
      const b = await chromium.launch({ headless, executablePath: customPath, args: LAUNCH_ARGS, proxy });
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
    { label: 'bundled', options: { headless, args: LAUNCH_ARGS, proxy } },
  ];
  if (headless) {
    for (const cachedPath of findCachedChromium()) {
      strategies.push({ label: `cached (${cachedPath})`, options: { headless, executablePath: cachedPath, args: LAUNCH_ARGS, proxy } });
    }
  }
  strategies.push({ label: 'system chrome', options: { headless, channel: 'chrome', args: LAUNCH_ARGS, proxy } });
  strategies.push({ label: 'system edge', options: { headless, channel: 'msedge', args: LAUNCH_ARGS, proxy } });

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

/**
 * Install a browser through playwright-core's CLI. Resolves true on success.
 *
 * Asynchronous so a first run's download overlaps the dev servers booting
 * instead of freezing the process until it finishes.
 */
export function installBrowser(kind: BrowserKind): Promise<boolean> {
  const cli = path.join(playwrightCoreDir(), 'cli.js');
  console.error(`Installing ${kind} (one-time, ~${kind === 'chromium' ? '170' : '80'} MB)...`);
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cli, 'install', kind], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', () => resolve(false));
    child.on('close', code => resolve(code === 0));
  });
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
  const installed = await installBrowser(opts.headless === false ? 'chromium' : 'chromium-headless-shell');
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
  if (browser) return browser;
  // Captures start concurrently, so the launch has to be shared from the first
  // call rather than from the first one to finish — otherwise every caller
  // sees a null `browser` and launches a Chromium of its own, and all but the
  // last are left running with nothing referencing them.
  if (!launching) {
    launching = launchBrowserOrInstall()
      .then(b => {
        browser = b;
        b.on('disconnected', () => { browser = null; launching = null; });
        return b;
      })
      .catch(err => { launching = null; throw err; });
  }
  return launching;
}

export function browserDescription(): string {
  return browserLabel;
}

// ============================================================
// Contexts
// ============================================================

/**
 * Purely decorative dev-server chrome, safe to hide from page CSS.
 *
 * An error overlay is deliberately NOT in this list. Vite reports a failed
 * transform by pushing `vite-error-overlay` onto a document that still answers
 * 200, so hiding it would publish the blank or stale page underneath — and
 * report "no visual changes" when both sides are equally broken, which is the
 * one answer that makes a reviewer stop looking.
 *
 * Next's dev indicator is not here either, because page CSS cannot reach it:
 * it lives inside `nextjs-portal`'s shadow root, alongside the error dialog.
 * Hiding the host would take the dialog with it. See `hideDevIndicator`.
 */
const DEV_OVERLAY_SELECTORS = [
  '#__next-build-watcher',
  'next-route-announcer',
];

/**
 * Hide Next's dev-tools badge without hiding its error dialog.
 *
 * Both render into the same `nextjs-portal` shadow root — measured against
 * Next 16.0.10, a healthy page has only `#devtools-indicator` there and a
 * broken one adds `[data-nextjs-dialog-overlay]` beside it — so the host
 * element cannot be used to tell them apart. Reaching into the shadow root is
 * what lets the badge go while the dialog stays.
 *
 * The badge matters because on the local strategy both sides are dev servers,
 * so it ships in every image published to the PR — something production never
 * shows. It is position: fixed, so a layout shift moves the page under it and
 * leaves it behind, counting as residual change the branch never made.
 *
 * Runs once, just before the screenshot, rather than from the init script: the
 * portal is mounted after hydration, so there is nothing to find at document
 * start.
 */
async function hideDevIndicator(page: Page): Promise<void> {
  await page.evaluate(() => {
    const hosts = Array.prototype.slice.call(document.querySelectorAll('nextjs-portal')) as Element[];
    for (const host of hosts) {
      const root = host.shadowRoot;
      if (!root || root.querySelector('[data-pre-post-hidden]')) continue;
      const style = document.createElement('style');
      style.setAttribute('data-pre-post-hidden', '');
      style.textContent = '#devtools-indicator, [data-nextjs-toast] { display: none !important; }';
      root.appendChild(style);
    }
  }).catch(() => undefined);
}

/**
 * Read the framework's error overlay, if the page is showing one.
 *
 * The overlay is the only reliable sign that a dev server is serving an error
 * instead of the page. HTTP status is not enough: measured against Next
 * 16.0.7 (Turbopack), a syntax error in one page is pushed to *every* open
 * page, so `/about` answers 200 while showing the Build Error dialog, and a
 * client component throwing in an effect is a 200 with a Runtime Error
 * dialog. Both use `[data-nextjs-dialog-overlay]` inside `nextjs-portal`'s
 * shadow root, with the label in `#nextjs__container_errors_label` and the
 * message in `#nextjs__container_errors_desc`; a healthy page has neither.
 *
 * Vite pushes `vite-error-overlay` onto a page that still answers 200; its
 * `.message-body` holds the message (from Vite's overlay template, not
 * measured here).
 *
 * Returns plain strings so it can run inside `page.evaluate`.
 */
function readErrorOverlay(): { kind: string; message?: string; text?: string } | null {
  const firstLine = (s: string | null | undefined) => (s ?? '').trim().split('\n')[0].trim() || undefined;
  const hosts = Array.prototype.slice.call(document.querySelectorAll('nextjs-portal')) as Element[];
  for (const host of hosts) {
    const root = host.shadowRoot;
    const overlay = root?.querySelector('[data-nextjs-dialog-overlay]');
    if (!root || !overlay) continue;
    return {
      kind: firstLine(root.querySelector('#nextjs__container_errors_label')?.textContent) ?? 'Error',
      message: firstLine(root.querySelector('#nextjs__container_errors_desc')?.textContent),
      // innerText, not textContent: it keeps the dialog's line breaks, so the
      // source location stays on a line of its own instead of being glued to
      // the message before it.
      text: (overlay as HTMLElement).innerText ?? '',
    };
  }
  const vite = document.querySelector('vite-error-overlay');
  if (vite) {
    const root = vite.shadowRoot;
    return { kind: 'Build Error', message: firstLine(root?.querySelector('.message-body')?.textContent) };
  }
  return null;
}

/** "./app/work/page.tsx (8:5)" on a line of its own, as Next's dialog prints a source location. */
const SOURCE_LOCATION = /^(?:\.\/)?((?:[\w@\[\]().-]+\/)*[\w@\[\]().-]+\.(?:[cm]?[jt]sx?|css|scss|sass|less|mdx?|vue|svelte|astro)) \((\d+):(\d+)\)/m;

/** The overlay's raw strings, turned into the error a report can phrase. */
export function pageErrorFrom(raw: { kind: string; message?: string; text?: string } | null): PageError | undefined {
  if (!raw) return undefined;
  const at = raw.text?.match(SOURCE_LOCATION);
  return {
    kind: raw.kind,
    message: raw.message?.slice(0, 200),
    location: at ? `${at[1]} (${at[2]}:${at[3]})` : undefined,
  };
}

const INIT_SCRIPT = `
  (() => {
    // Count animation-frame requests, so the capture can tell a page that is
    // still animating from one that has settled. Wraps whatever
    // requestAnimationFrame is installed (the paused clock's, in practice).
    window.__prePostFrames = 0;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => { window.__prePostFrames++; return raf(callback); };
    // Deterministic pseudo-random for pages that seed layout from Math.random().
    let seed = 42;
    Math.random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    // No smooth scrolling: scrollTo() must land immediately.
    const style = document.createElement('style');
    style.setAttribute('data-pre-post', '');
    style.textContent = 'html, body, * { scroll-behavior: auto !important; }'
      + ' ::-webkit-scrollbar { display: none !important; }'
      + ' ${DEV_OVERLAY_SELECTORS.join(', ')} { display: none !important; }';
    const attach = () => { (document.head || document.documentElement).appendChild(style); };
    if (document.head) attach(); else document.addEventListener('DOMContentLoaded', attach, { once: true });
  })();
`;

/**
 * A context per capture, not per viewport.
 *
 * Playwright's clock belongs to the browser context and is replayed into every
 * page opened in it, so pages that share a context do not share a starting
 * point: the second page inherits the timeline the first one ran. An animated
 * page then lands on a different frame depending on how many captures came
 * before it. One context per capture makes every page start from the same
 * paused instant — and keeps storage and caches from leaking between the two
 * sides of a comparison.
 */
async function createContext(viewport: ViewportSize, scale: number, auth?: AuthOptions): Promise<BrowserContext> {
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
  // Fake the page's timers and hold them still. `setFixedTime` would only pin
  // what the page *reads* from Date.now(); setTimeout, setInterval and
  // requestAnimationFrame would keep firing, so a timer-driven animation would
  // land on whatever frame the network happened to deliver. With the clock
  // installed and paused, the page's timeline does not move until
  // `advanceTimeline` moves it — by the same amount on both sides.
  await ctx.clock.install({ time: FIXED_TIME });
  await ctx.clock.pauseAt(FIXED_TIME);
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
}

// ============================================================
// Settle
// ============================================================

/**
 * Wait for everything that arrives on the *real* clock: fonts, images, the
 * network, and the layout work that hydration does. The page's own timers stay
 * frozen throughout, so waiting longer here — on a slow host, a cold cache, a
 * busy machine — never advances an animation. Bounded by `timeout` ms.
 */
async function settlePage(page: Page, timeout: number, options: { network?: boolean } = {}): Promise<void> {
  const deadline = Date.now() + timeout;
  const left = () => Math.max(0, deadline - Date.now());

  // Fonts and images resolve off the loading pipeline, not off page timers.
  await withDeadline(page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
    const pending = Array.from(document.images).filter(img => !img.complete);
    if (pending.length) await Promise.allSettled(pending.map(img => img.decode().catch(() => undefined)));
  }), Math.min(3500, left()));

  if (options.network !== false) await waitForNetworkQuiet(page, 150, Math.min(left(), 2500));

  await waitForStableLayout(page, left());
}

/** Resolve when `p` settles or `ms` elapses, whichever comes first. */
async function withDeadline<T>(p: Promise<T>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    p.catch(() => undefined),
    new Promise<void>(resolve => { timer = setTimeout(resolve, ms); }),
  ]);
  if (timer) clearTimeout(timer);
}

/** Cheap description of the page's structure; changes while it is still building itself. */
const LAYOUT_SIGNATURE = `(() => {
  const de = document.documentElement;
  return de.scrollHeight + ':' + de.scrollWidth + ':' + (document.body ? document.body.childElementCount : 0) + ':' + document.getElementsByTagName('*').length;
})()`;

/**
 * Poll until the page stops restructuring itself. Polled from here rather than
 * from a requestAnimationFrame loop in the page: page timers are frozen, so an
 * in-page loop would never get a second frame.
 */
async function waitForStableLayout(page: Page, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  let last: string | null = null;
  let stable = 0;
  while (stable < 2 && Date.now() < deadline) {
    const signature = await page.evaluate(LAYOUT_SIGNATURE).catch(() => last) as string | null;
    if (signature !== null && signature === last) stable++;
    else { stable = 0; last = signature; }
    if (stable < 2) await new Promise(resolve => setTimeout(resolve, STABILITY_POLL_MS));
  }
}

/**
 * Run the page's frozen timeline forward by `ms`, one frame at a time, so
 * timer- and rAF-driven animation advances the same amount on every capture.
 *
 * A timer callback that throws is the page's own bug, not a reason to fail the
 * screenshot: Playwright surfaces it here, so each frame is stepped separately
 * and an error only costs that frame.
 */
async function advanceTimeline(page: Page, ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += FRAME_MS) {
    await page.clock.runFor(Math.min(FRAME_MS, ms - elapsed)).catch(() => undefined);
  }
}

/**
 * Run the timeline for the fixed budget, then on until the page stops asking
 * for animation frames or `TIMELINE_MAX_MS` is reached.
 *
 * Both sides follow the same rule, so a finite animation ends on its last
 * frame on each; one that never ends runs to the cap on each.
 */
async function advanceUntilIdle(page: Page): Promise<void> {
  const frames = () => page.evaluate('window.__prePostFrames || 0').catch(() => 0) as Promise<number>;
  await advanceTimeline(page, TIMELINE_BUDGET_MS);
  for (let spent = TIMELINE_BUDGET_MS; spent < TIMELINE_MAX_MS; spent += IDLE_CHECK_MS) {
    const before = await frames();
    await advanceTimeline(page, IDLE_CHECK_MS);
    if (await frames() === before) return;
  }
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
 *
 * Driven from here, a step at a time: the scrolling itself is real, but the
 * frames that let observers and rAF callbacks run come out of the frozen
 * timeline, so two identical pages take the same path down and back.
 */
async function primeLazyContent(page: Page, maxHeight: number): Promise<void> {
  const positions = await page.evaluate((limitPx: number) => {
    const step = Math.max(200, window.innerHeight);
    const limit = Math.min(document.documentElement.scrollHeight, limitPx);
    const ys: number[] = [];
    for (let y = step; y < limit + step; y += step) ys.push(y);
    return ys;
  }, maxHeight);

  for (const y of positions) {
    await page.evaluate((to: number) => window.scrollTo(0, to), y);
    await advanceTimeline(page, FRAME_MS * 2);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await advanceTimeline(page, FRAME_MS);
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

  await acquireSlot();
  // Creating the context and the page sits inside the try, so a failure there
  // still releases the slot and closes what was opened. Leaking a slot would
  // eventually stall every later capture waiting for one.
  let ctx: BrowserContext | undefined;
  let page: Page | undefined;
  try {
    ctx = await createContext(options.viewport, scale, options.auth);
    page = await ctx.newPage();
    trackRequests(page);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(err => {
      throw new NavigationError(classifyNavigationError(err), url, err);
    });
    const status = response?.status();
    const vercel = response ? isVercelResponse({ get: n => response.headers()[n] ?? null }) : false;
    if (status === 401 || status === 403) throw new HttpStatusError(status, url, vercel);

    await settlePage(page, settleTimeout);

    if (options.fullPage) {
      await primeLazyContent(page, maxHeight);
      await settlePage(page, Math.min(settleTimeout, 2000));
    }

    // The page is loaded and quiet; now run its own timeline until it stops
    // animating, so whatever it animates ends on the same frame here as on
    // the other side.
    await advanceUntilIdle(page);
    // Timers that just fired may have asked for more content; let it arrive.
    await settlePage(page, Math.min(settleTimeout, 2000));

    // Only now look for the selector: an element mounted by a timer does not
    // exist until that timer has fired, and with the clock held that is not
    // until the budget above has run.
    if (options.selector) {
      const locator = page.locator(options.selector);
      if ((await locator.count()) === 0) throw new Error(`Element not found: ${options.selector}`);
      await locator.first().scrollIntoViewIfNeeded();
      await advanceTimeline(page, FRAME_MS * 2);
    }

    // `--wait` means "give this page longer": real time for anything still in
    // flight, and the same again on the page's timeline for anything animating.
    if (options.wait) {
      await page.waitForTimeout(options.wait);
      await advanceTimeline(page, options.wait);
    }

    let clip: { x: number; y: number; width: number; height: number } | undefined;
    if (options.fullPage) {
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      if (height > maxHeight) clip = { x: 0, y: 0, width: options.viewport.width, height: maxHeight };
    }

    // Where the browser actually ended up: a sign-in wall answers with 200
    // after a redirect, so the status says nothing.
    const finalUrl = page.url();

    await hideDevIndicator(page);

    const image = await page.screenshot({
      type: 'png',
      fullPage: options.fullPage ?? false,
      animations: 'disabled',
      caret: 'hide',
      clip,
      timeout: 20_000,
    });

    // What the page calls itself, and what it says: the title recognises a
    // sign-in wall that answered 200, the text tells a redesign of this site
    // from a different site altogether. One round trip, and strictly after the
    // screenshot — reading the page must not be able to influence the pixels
    // the run is about to compare.
    //
    // The error overlay is read in the same trip. It is not hidden for the
    // screenshot (see DEV_OVERLAY_SELECTORS), so what this finds is exactly
    // what the image shows.
    const { title, text, overlay } = await page
      .evaluate(`({ title: document.title, text: document.body?.innerText ?? '', overlay: (${readErrorOverlay.toString()})() })`)
      .catch(() => ({ title: '', text: '', overlay: null })) as { title: string; text: string; overlay: Parameters<typeof pageErrorFrom>[0] };

    return {
      image,
      viewport: options.viewport,
      url,
      status,
      finalUrl,
      title,
      text,
      vercel,
      pageError: pageErrorFrom(overlay),
      selector: options.selector,
      durationMs: Date.now() - started,
    };
  } finally {
    await page?.close().catch(() => undefined);
    await ctx?.close().catch(() => undefined);
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
 * How long a graceful browser shutdown may take before the run stops waiting.
 *
 * Playwright's close waits on the browser process with no limit, and a
 * full Chrome — what runs when no headless shell is installed — sometimes
 * takes minutes to exit: measured at 12–31s across a stress test, and once
 * at exactly 300s, all spent after the last screenshot was taken. Nothing is
 * leaked by moving on: Playwright SIGKILLs every browser it launched when
 * this process exits.
 */
export const BROWSER_CLOSE_TIMEOUT_MS = 5_000;

/**
 * Close the browser session and clean up resources.
 */
export async function closeBrowser(): Promise<void> {
  const b = browser;
  browser = null;
  launching = null;
  activePages = 0;
  pageQueue.length = 0;
  if (!b) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    b.close().catch(() => undefined),
    new Promise<void>(resolve => { timer = setTimeout(resolve, BROWSER_CLOSE_TIMEOUT_MS); timer.unref(); }),
  ]);
  clearTimeout(timer);
}
