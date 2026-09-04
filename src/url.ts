/**
 * URL helpers shared by the capture layer and the command pipeline.
 *
 * Kept out of run.ts so browser.ts can ask "is this loopback?" without
 * importing the module that imports it.
 */

/** Add a scheme to a bare URL (http for loopback hosts, https otherwise) and drop trailing slashes. */
const LOOPBACK = /^(?:(?:https?|file):\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i;

/** Is this URL served from the machine running the command? */
export function isLocalUrl(url: string): boolean {
  return LOOPBACK.test(url);
}

export function normalizeUrl(url: string): string {
  const withScheme = /^(https?|file):\/\//i.test(url)
    ? url
    : isLocalUrl(url) ? `http://${url}` : `https://${url}`;
  return withScheme.replace(/\/+$/, '');
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function joinUrl(base: string, route: string): string {
  return base.replace(/\/+$/, '') + (route.startsWith('/') ? route : `/${route}`);
}
