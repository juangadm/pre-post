/**
 * The address a project publishes as its own — the baseline of last resort.
 *
 * The Deployments API is the right source for "what is deployed", but it only
 * answers for hosts that record a GitHub Deployment. Vercel — the most common
 * host for the apps this tool is pointed at — records none: it reports a commit
 * status and a PR comment, which is why the preview side already needs a second
 * source. This is the second source for the *baseline*, and without it a repo on
 * that host has no deployed Pre at all and falls back to needing a dev server.
 *
 * Both sources here are conventions rather than configuration, so nothing new
 * has to be set up: the website on the GitHub repository, and `homepage` in
 * package.json. A URL pointing back at the source host is not a site, so those
 * are rejected — otherwise a library whose homepage is its own repo would be
 * screenshotted as if it were the app.
 */

import path from 'path';
import { GitHub } from './github.js';
import { readPackage } from './pkg.js';
import { isLocalUrl, normalizeUrl } from './url.js';

/** Hosts that serve source, not the built site. */
const CODE_HOSTS = /(^|\.)(github\.com|github\.io|gitlab\.com|bitbucket\.org|codeberg\.org|sr\.ht)$/i;

export interface PublishedSite {
  url: string;
  /** Human-readable provenance, for the line the run prints about Pre. */
  detail: string;
}

/**
 * Could this string be the deployed site?
 *
 * Deliberately strict: a wrong baseline produces a diff that is 100% changed on
 * every route and looks like a real result, so anything ambiguous is rejected
 * and the run falls through to a comparison it can vouch for.
 */
export function isPublishedSite(url: string | null | undefined): boolean {
  if (!url || typeof url !== 'string' || isLocalUrl(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(normalizeUrl(url.trim()));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  // A bare hostname with no dot ("intranet") is a guess, not an address.
  if (!parsed.hostname.includes('.')) return false;
  return !CODE_HOSTS.test(parsed.hostname);
}

/** `homepage` from the app's package.json, then the repository root's. */
export function homepageFromPackage(repoRoot: string, appPrefix?: string): PublishedSite | null {
  const dirs = appPrefix ? [path.join(repoRoot, appPrefix), repoRoot] : [repoRoot];
  for (const dir of dirs) {
    const homepage = readPackage(dir)?.homepage;
    if (isPublishedSite(homepage)) return { url: homepage, detail: 'production site, from homepage in package.json' };
  }
  return null;
}

/** The website field on the GitHub repository. */
export async function homepageFromRepo(gh: GitHub, ownerRepo: string): Promise<PublishedSite | null> {
  try {
    const repo = await gh.request<{ homepage?: string | null }>('GET', `/repos/${ownerRepo}`);
    return isPublishedSite(repo?.homepage)
      ? { url: repo!.homepage!, detail: 'production site, from the repository homepage' }
      : null;
  } catch {
    return null;
  }
}

/**
 * The project's published address, from the repository first.
 *
 * The GitHub field is the one a deploy host writes for you and a maintainer
 * keeps current; package.json's is hand-edited and more often a docs page.
 */
export async function publishedSiteUrl(
  gh: GitHub | null,
  ownerRepo: string,
  repoRoot: string,
  appPrefix?: string,
): Promise<PublishedSite | null> {
  if (gh) {
    const fromRepo = await homepageFromRepo(gh, ownerRepo);
    if (fromRepo) return fromRepo;
  }
  return homepageFromPackage(repoRoot, appPrefix);
}
