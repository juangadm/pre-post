/**
 * Deployment URLs from the GitHub Deployments API.
 *
 * Vercel, Cloudflare Pages, Netlify and Render all report their deploys to
 * GitHub against a commit, so one lookup covers every provider: no per-host
 * API tokens, and nothing to configure per repo.
 */

import { GitHub } from './github.js';

/**
 * Bots whose PR comments may be read for a preview URL. A comment is only
 * trusted when GitHub reports its author as one of these apps: anyone can post
 * a comment that looks like Vercel's, and following it would point a capture at
 * a URL a stranger chose.
 */
const TRUSTED_BOTS = new Set(['vercel[bot]', 'netlify[bot]']);

interface Deployment {
  id: number;
  environment: string;
  created_at: string;
}

interface DeploymentStatus {
  state: string;
  environment_url: string | null;
  created_at: string;
}

export interface DeploymentUrl {
  url: string;
  environment: string;
}

const PRODUCTION = /^prod/i;

/** How many deployments to inspect per commit; each costs one status request. */
const MAX_DEPLOYMENTS = 5;

/**
 * The newest successful deployment URL for a commit.
 *
 * `production: true` accepts only production environments (the baseline for
 * "Pre"); `false` accepts only the others, which is where every provider puts
 * per-PR previews. Neither falls back to the other kind — a preview standing in
 * for production would silently compare against the wrong thing.
 *
 * Returns null whenever the answer is not unambiguous, so callers fall through
 * to their next option. Never throws: a repo with no deployments, or a token
 * without `deployments: read`, is a normal outcome, not a failure.
 */
export async function deploymentUrlForSha(
  gh: GitHub,
  ownerRepo: string,
  sha: string,
  opts: { production: boolean },
): Promise<DeploymentUrl | null> {
  let deployments: Deployment[];
  try {
    deployments = await gh.request<Deployment[]>('GET', `/repos/${ownerRepo}/deployments?sha=${encodeURIComponent(sha)}&per_page=20`);
  } catch {
    return null;
  }
  if (!Array.isArray(deployments)) return null;

  const candidates = deployments
    .filter(d => PRODUCTION.test(d.environment || '') === opts.production)
    .slice(0, MAX_DEPLOYMENTS);

  for (const deployment of candidates) {
    let statuses: DeploymentStatus[];
    try {
      statuses = await gh.request<DeploymentStatus[]>('GET', `/repos/${ownerRepo}/deployments/${deployment.id}/statuses?per_page=20`);
    } catch {
      continue;
    }
    if (!Array.isArray(statuses)) continue;
    const ready = statuses.find(s => s.state === 'success' && s.environment_url);
    if (ready?.environment_url) return { url: ready.environment_url, environment: deployment.environment };
  }
  return null;
}


interface IssueComment {
  body: string | null;
  user: { login: string; type?: string } | null;
}

/** Vercel embeds this base64 payload at the top of its PR comment. */
interface VercelPayload {
  projects?: Array<{ name?: string; rootDirectory?: string; previewUrl?: string; nextCommitStatus?: string }>;
}

function decodeVercelPayload(body: string): VercelPayload | null {
  const marker = /^\[vc\]: #[^:\n]+:(\S+)/m.exec(body);
  if (!marker) return null;
  try {
    const json = JSON.parse(Buffer.from(marker[1], 'base64').toString('utf8'));
    return json && typeof json === 'object' ? (json as VercelPayload) : null;
  } catch {
    return null;
  }
}

const withScheme = (url: string): string => (/^https?:\/\//.test(url) ? url : `https://${url}`);

/**
 * The preview URL a deployment bot posted on the PR.
 *
 * Not every provider records a GitHub Deployment — Vercel's GitHub app reports
 * a commit status and a comment, and the commit status only links to its own
 * dashboard. The comment is where the deployed URL actually appears, so this is
 * the fallback when `deploymentUrlForSha` finds nothing.
 *
 * `appPrefix` disambiguates a monorepo comment listing several projects, by
 * matching the project whose root directory is the app being captured.
 */
export async function previewUrlFromComments(
  gh: GitHub,
  ownerRepo: string,
  prNumber: number,
  opts: { appPrefix?: string } = {},
): Promise<DeploymentUrl | null> {
  let comments: IssueComment[];
  try {
    comments = await gh.request<IssueComment[]>('GET', `/repos/${ownerRepo}/issues/${prNumber}/comments?per_page=100`);
  } catch {
    return null;
  }
  if (!Array.isArray(comments)) return null;

  // Newest first: a re-run posts an updated URL.
  for (const comment of [...comments].reverse()) {
    const body = comment.body ?? '';
    if (!comment.user || !TRUSTED_BOTS.has(comment.user.login)) continue;

    const payload = decodeVercelPayload(body);
    const projects = (payload?.projects ?? []).filter(p => p.previewUrl);
    if (projects.length) {
      // Only projects that could be the app being captured. A project that
      // declares a different root directory is a different app, so falling back
      // to it would screenshot the wrong site.
      const norm = (dir?: string) => (dir ?? '').replace(/^\.?\//, '').replace(/\/$/, '');
      const candidates = projects.filter(p => !opts.appPrefix || !p.rootDirectory || norm(p.rootDirectory) === opts.appPrefix);
      const chosen = candidates.length === 1 ? candidates[0] : undefined;
      // A build still running has a URL that does not serve the branch yet.
      if (chosen && (chosen.nextCommitStatus ?? 'DEPLOYED') === 'DEPLOYED') {
        return { url: withScheme(chosen.previewUrl!), environment: chosen.name ? `Preview (${chosen.name})` : 'Preview' };
      }
      continue;
    }

    // Providers without a structured payload still link the preview by name.
    const link = /\[(?:Preview|Deploy Preview)\]\((https?:\/\/[^\s)]+)\)/i.exec(body);
    if (link) return { url: link[1], environment: 'Preview' };
  }
  return null;
}
