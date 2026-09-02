/**
 * Preflight: browser present, GitHub auth, dev server, target reachability.
 * Fixes what it can (installs the headless shell) and otherwise stops with
 * exactly one sentence telling the human what to do.
 */

import { getBrowser, launchBrowserOrInstall } from './browser.js';
import { hostOf } from './run.js';
import { BrowserNotFoundError, HttpStatusError, NeedsHumanError, isVercelResponse } from './errors.js';
export { NeedsHumanError } from './errors.js';

const INSTALL_HINT = 'Run: npx playwright-core install chromium-headless-shell   (or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH), then re-run.';

function explainBrowserFailure(err: unknown): never {
  if (err instanceof BrowserNotFoundError) {
    throw new NeedsHumanError(
      err.installed
        ? `Chromium was installed but cannot launch. ${INSTALL_HINT}`
        : `Chromium could not be installed automatically. ${INSTALL_HINT}`,
    );
  }
  throw err;
}

/**
 * Launch (and install if needed) the shared headless browser. The instance
 * stays open for the captures that follow, so this is the launch, not a probe.
 */
export async function ensureBrowser(): Promise<void> {
  try {
    await getBrowser();
  } catch (err) {
    explainBrowserFailure(err);
  }
}

/** Headed browser for `pre-post login`; caller owns and closes it. */
export async function launchHeadedBrowser() {
  try {
    return await launchBrowserOrInstall({ headless: false });
  } catch (err) {
    explainBrowserFailure(err);
  }
}

const DEV_PORTS = [3000, 3001, 3002, 5173, 5174, 4173, 4321, 8080, 8000, 5000, 4200];

/**
 * Find a running local dev server. Returns its base URL or null.
 */
export async function detectDevServer(ports: number[] = DEV_PORTS): Promise<string | null> {
  const results = await Promise.all(ports.map(async p => ({ p, ...(await probeUrl(`http://localhost:${p}/`, {}, { timeoutMs: 1500, redirect: 'manual' })) })));
  const hit = results.find(r => r.status !== null);
  return hit ? `http://localhost:${hit.p}` : null;
}

export interface ProbeResult {
  /** HTTP status, or null when the host could not be reached at all */
  status: number | null;
  vercel: boolean;
}

/**
 * Probe a base URL with the headers we will use for capture.
 */
export async function probeUrl(
  url: string,
  headers: Record<string, string> = {},
  options: { timeoutMs?: number; redirect?: RequestRedirect } = {},
): Promise<ProbeResult> {
  try {
    const res = await fetch(url, { method: 'GET', headers, redirect: options.redirect ?? 'follow', signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) });
    return { status: res.status, vercel: isVercelResponse(res.headers) };
  } catch {
    return { status: null, vercel: false };
  }
}

/**
 * Explain a 401/403 in one actionable sentence. Accepts a probe result or the typed capture error.
 */
export function authHint(target: HttpStatusError | { url: string; vercel: boolean }): string {
  const { url, vercel } = target;
  const host = hostOf(url);
  if (vercel || host.endsWith('.vercel.app')) {
    return `${host} is protected by Vercel Deployment Protection. Either set VERCEL_AUTOMATION_BYPASS_SECRET (Project → Settings → Deployment Protection → Protection Bypass for Automation) or run: npx pre-post login ${url}`;
  }
  return `${host} requires a login. Run: npx pre-post login ${url}  (opens a browser once, saves the session locally)`;
}
