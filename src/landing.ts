/**
 * Did a capture reach the page it asked for, or land somewhere else?
 *
 * Deployment protection, corporate SSO and IP allow-lists answer a request for
 * a page with a sign-in screen, and they do it with HTTP 200 after a redirect —
 * so the 401/403 guard in `browser.ts` never sees them. Screenshotting that and
 * publishing the difference as a visual change is the worst failure this tool
 * has: confident, and wrong. It happened on a real run, twice, before anyone
 * noticed the "Post" screenshot was a login form.
 *
 * The test is deliberately narrow. A redirect on its own proves nothing — a
 * site legitimately sends `example.xyz` to `example.org`, or apex to `www` —
 * so only a redirect that ends somewhere *sign-in shaped* counts. Missing an
 * exotic auth wall is recoverable; refusing to run against a site that redirects
 * for ordinary reasons is not.
 */

/**
 * The registrable-ish part of a host, so `www.example.com` and `example.com`
 * read as one site. Two labels is a heuristic — it treats `a.co.uk` and
 * `b.co.uk` as the same site — but it is only ever used to make the sign-in
 * test *stricter*, never to reject anything on its own.
 */
export function siteOf(url: string): string {
  try {
    const { hostname } = new URL(url);
    const labels = hostname.split('.');
    return labels.length <= 2 ? hostname : labels.slice(-2).join('.');
  } catch {
    return '';
  }
}

/** Did the navigation end up on a different site than the one requested? */
export function leftTheSite(requested: string, final: string): boolean {
  const from = siteOf(requested);
  const to = siteOf(final);
  return Boolean(from && to && from !== to);
}

/** Words that appear in the URL or title of a sign-in page and little else. */
const SIGN_IN_URL = /(login|log-in|signin|sign-in|sso|oauth|authorize|authenticate)/i;
const SIGN_IN_TITLE = /(sign[ -]?in|log[ -]?in|authentication required|authorization required|access denied)/i;

/** Does this URL and title read as a sign-in page rather than a site's own page? */
export function looksLikeSignIn(url: string, title = ''): boolean {
  let path = '';
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch {
    return false;
  }
  return SIGN_IN_URL.test(path) || SIGN_IN_TITLE.test(title);
}

export interface Landing {
  /** Where the browser actually ended up. */
  finalUrl: string;
  /** True when the capture is of a sign-in wall, not of the requested page. */
  blocked: boolean;
  /** The wall is on another site entirely — usually an identity provider. */
  offSite: boolean;
}

/**
 * Judge where a capture landed.
 *
 * Blocked requires *both* that the browser moved and that where it moved to is
 * sign-in shaped: asking for `/login` and getting `/login` is not a wall, and
 * neither is a plain canonical-domain redirect.
 */
export function checkLanding(requested: string, finalUrl: string, title = ''): Landing {
  const moved = normalize(finalUrl) !== normalize(requested);
  return {
    finalUrl,
    blocked: moved && looksLikeSignIn(finalUrl, title),
    offSite: leftTheSite(requested, finalUrl),
  };
}

/** Ignore the trailing-slash and fragment differences a redirect adds for free. */
function normalize(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    if (u.pathname.endsWith('/') && u.pathname !== '/') u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * The one sentence a human needs. Names the fix, not the symptom.
 */
export function signInHint(url: string, vercel: boolean): string {
  if (vercel) {
    return `${url} answered with a sign-in page, so the site was never captured. ` +
      'Set VERCEL_AUTOMATION_BYPASS_SECRET (Vercel → Project → Settings → Deployment Protection → Protection Bypass for Automation) and re-run.';
  }
  return `${url} answered with a sign-in page, so the site was never captured. ` +
    `Run: npx pre-post login ${url}   (opens a browser once, saves the session locally)`;
}
