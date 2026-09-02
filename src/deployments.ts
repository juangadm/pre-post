/**
 * Deployment URLs from the GitHub Deployments API.
 *
 * Vercel, Cloudflare Pages, Netlify and Render all report their deploys to
 * GitHub against a commit, so one lookup covers every provider: no per-host
 * API tokens, and nothing to configure per repo.
 */

import { GitHub } from './github.js';

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
