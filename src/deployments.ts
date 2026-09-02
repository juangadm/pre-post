/**
 * Deployment URLs from the GitHub Deployments API.
 *
 * Vercel, Cloudflare Pages, Netlify and Render all report their deploys to
 * GitHub against a commit, so one lookup covers every provider: no per-host
 * API tokens, and nothing to configure per repo.
 */

import { GitHub } from './github.js';
import { normalizeUrl } from './run.js';

/**
 * Bots whose PR comments may be read for a preview URL. A comment is only
 * trusted when GitHub reports its author as one of these apps: anyone can post
 * a comment that looks like Vercel's, and following it would point a capture at
 * a URL a stranger chose.
 */
const TRUSTED_BOTS = new Set(['vercel[bot]', 'netlify[bot]']);

/** Commit-status contexts these same providers post under. */
const PROVIDER_STATUS = /vercel|netlify|cloudflare|render/i;

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

  const ready = await Promise.all(candidates.map(async deployment => {
    try {
      const statuses = await gh.request<DeploymentStatus[]>('GET', `/repos/${ownerRepo}/deployments/${deployment.id}/statuses?per_page=20`);
      if (!Array.isArray(statuses)) return null;
      const ok = statuses.find((s): s is DeploymentStatus & { environment_url: string } => s.state === 'success' && !!s.environment_url);
      return ok ? { url: ok.environment_url, environment: deployment.environment } : null;
    } catch {
      return null;
    }
  }));
  // Candidates stay in newest-first order, so the first hit is the newest.
  return ready.find(Boolean) ?? null;
}

/** Has a deployment provider reported success against this exact commit? */
async function providerSucceededFor(gh: GitHub, ownerRepo: string, sha: string): Promise<boolean> {
  try {
    const combined = await gh.request<{ statuses?: Array<{ state: string; context: string }> }>('GET', `/repos/${ownerRepo}/commits/${sha}/status`);
    return (combined.statuses ?? []).some(s => s.state === 'success' && PROVIDER_STATUS.test(s.context));
  } catch {
    return false;
  }
}

/**
 * The preview for a commit, from whichever mechanism the provider uses.
 *
 * The freshness rule lives here rather than in the caller: a bot comment is
 * edited in place and carries no SHA, so mid-deploy it still advertises the
 * previous commit's preview. Screenshotting that and labelling it as this
 * branch is the worst failure this tool has, because it looks exactly like a
 * correct result. Every caller gets that guarantee by construction.
 */
export async function findPreviewForCommit(
  gh: GitHub,
  ownerRepo: string,
  opts: { sha: string; prNumber?: number; appPrefix?: string },
): Promise<DeploymentUrl | null> {
  const recorded = await deploymentUrlForSha(gh, ownerRepo, opts.sha, { production: false });
  if (recorded) return { ...recorded, url: normalizeUrl(recorded.url) };
  if (opts.prNumber === undefined) return null;

  const [fresh, commented] = await Promise.all([
    providerSucceededFor(gh, ownerRepo, opts.sha),
    previewUrlFromComments(gh, ownerRepo, opts.prNumber, { appPrefix: opts.appPrefix }),
  ]);
  return fresh && commented ? { ...commented, url: normalizeUrl(commented.url) } : null;
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
        return { url: normalizeUrl(chosen.previewUrl!), environment: chosen.name ? `Preview (${chosen.name})` : 'Preview' };
      }
      continue;
    }

    // Providers without a structured payload still link the preview by name.
    const link = /\[(?:Preview|Deploy Preview)\]\((https?:\/\/[^\s)]+)\)/i.exec(body);
    if (link) return { url: link[1], environment: 'Preview' };
  }
  return null;
}
