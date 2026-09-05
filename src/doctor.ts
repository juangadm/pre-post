/**
 * Preflight: browser present, GitHub auth, dev server, target reachability.
 * Fixes what it can (installs the headless shell) and otherwise stops with
 * exactly one sentence telling the human what to do.
 */

import { getBrowser, launchBrowserOrInstall } from './browser.js';
import { hostOf } from './url.js';
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

/**
 * Ports worth asking, most likely first: the winner is the earliest that
 * answers, so order is only ever a tie-break between two live servers.
 *
 * Order is not what keeps AirPlay out — `looksLikeDevServer` is, on every
 * platform and at any position. 5000 sits last because on macOS it usually
 * belongs to AirPlay Receiver rather than to a dev server, so it is the
 * weakest guess in the list, not because being last protects anything. 7000,
 * its sibling, is left out entirely: no framework defaults to it, so it has
 * nothing to weigh against the noise.
 */
const DEV_PORTS = [3000, 3001, 3002, 5173, 5174, 4173, 4321, 8080, 8000, 4200, 5000];

/** An HTML document. `probeUrl` has already lowercased and dropped parameters. */
function isHtml(contentType?: string): boolean {
  return contentType === 'text/html' || contentType === 'application/xhtml+xml';
}

/**
 * Is this a dev server, or just something listening?
 *
 * A reachable socket used to be enough, and it is not: on macOS, AirPlay
 * Receiver holds port 5000 and answers every request 403 with no body. The
 * probe adopted it, the 403 was read as access control, and the run advised
 * signing in to a system service — in place of "no dev server is running",
 * which is the one thing that was true. It bit precisely when nothing else was
 * listening, the case the message exists to describe.
 *
 * So the bar is a plausible *app* response, not a reachable port:
 *
 * - 401/403 never qualifies. That is a wall or a stranger; either way there is
 *   no site behind it to capture, and inferring a dev server from one is how
 *   the above happened.
 * - A redirect does. Locale prefixes and trailing slashes make it ordinary, and
 *   there is no body to inspect, so the status is all there is to go on. If it
 *   leads somewhere sign-in shaped, `landing.ts` catches that at capture time
 *   with a message about the wall rather than about ports.
 * - Anything else has to have served an HTML document. This deliberately keeps
 *   a 404 or a 500 that renders a page: a dev server with no `/` route, or one
 *   with a compile error, is still the dev server, and refusing it would send
 *   someone hunting for a server they are already running.
 */
export function looksLikeDevServer(result: ProbeResult): boolean {
  const { status, contentType } = result;
  if (status === null) return false;
  if (status === 401 || status === 403) return false;
  if (status >= 300 && status < 400) return true;
  return isHtml(contentType);
}

export interface DevServerScan {
  /** Base URL of the dev server, or null when none of the ports had one. */
  url: string | null;
  /** Ports that answered but are not serving a site — worth naming, not using. */
  ignored: Array<{ port: number; status: number }>;
}

/**
 * Probe the usual ports and say what was found *and* what was passed over.
 *
 * `doctor` reports the ignored ports because "nothing on the usual ports" is
 * confusing when something is plainly listening on one of them.
 */
export async function scanDevServers(ports: number[] = DEV_PORTS): Promise<DevServerScan> {
  const results = await Promise.all(ports.map(async port => ({
    port,
    ...(await probeUrl(`http://localhost:${port}/`, {}, { timeoutMs: 1500, redirect: 'manual' })),
  })));
  const scan: DevServerScan = { url: null, ignored: [] };
  for (const result of results) {
    if (looksLikeDevServer(result)) scan.url ??= `http://localhost:${result.port}`;
    else if (result.status !== null) scan.ignored.push({ port: result.port, status: result.status });
  }
  return scan;
}

/** Find a running local dev server. Returns its base URL or null. */
export async function detectDevServer(ports: number[] = DEV_PORTS): Promise<string | null> {
  return (await scanDevServers(ports)).url;
}

export interface ProbeResult {
  /** HTTP status, or null when the host could not be reached at all */
  status: number | null;
  vercel: boolean;
  /** Response Content-Type, lowercased and without parameters. */
  contentType?: string;
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
    const contentType = res.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    return { status: res.status, vercel: isVercelResponse(res.headers), contentType: contentType || undefined };
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
