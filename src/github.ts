/**
 * GitHub REST client used for:
 *   - finding the open PR for a branch
 *   - publishing screenshots to an orphan assets branch (Git Data API, one commit per run)
 *   - upserting a sticky PR comment
 *   - pruning old assets
 *
 * Authentication: GH_TOKEN / GITHUB_TOKEN, else the gh CLI's stored token.
 */

import { execFileSync } from 'child_process';
import { GitHubError, NeedsHumanError, GH_LOGIN_HINT } from './errors.js';
export { GitHubError } from './errors.js';

export const API_BASE = process.env.GITHUB_API_URL || 'https://api.github.com';

export function getToken(): string | null {
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env) return env;
  try {
    const out = execFileSync('gh', ['auth', 'token'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** A token, or the one sentence telling the human how to get one. */
export function requireToken(purpose = 'publish screenshots'): string {
  const token = getToken();
  if (!token) throw new NeedsHumanError(`GitHub access is needed to ${purpose}. ${GH_LOGIN_HINT}`);
  return token;
}

export class GitHub {
  constructor(private readonly token: string, private readonly base = API_BASE) {}

  async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'pre-post',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch { /* non-JSON */ }
    if (res.status === 401 || (res.status === 403 && !/rate limit/i.test(json?.message || ''))) {
      throw new NeedsHumanError(`GitHub rejected the token (${res.status}). ${GH_LOGIN_HINT}`);
    }
    if (!res.ok) {
      const msg = json?.message || text || res.statusText;
      throw new GitHubError(res.status, `GitHub ${method} ${path} → ${res.status}: ${msg}`);
    }
    return json as T;
  }
}

export interface PullRequestRef {
  number: number;
  html_url: string;
  head: { sha: string; ref: string };
  base: { ref: string; sha: string };
  title: string;
}

export async function findOpenPr(gh: GitHub, ownerRepo: string, branch: string): Promise<PullRequestRef | null> {
  const owner = ownerRepo.split('/')[0];
  const prs = await gh.request<PullRequestRef[]>(
    'GET',
    `/repos/${ownerRepo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=1`,
  );
  return prs[0] ?? null;
}

export async function getPr(gh: GitHub, ownerRepo: string, number: number): Promise<PullRequestRef & { state: string; closed_at: string | null; merged_at: string | null }> {
  return gh.request('GET', `/repos/${ownerRepo}/pulls/${number}`);
}

export interface AssetFile {
  /** Path inside the assets branch, e.g. "pr-42/20260115-1200/home-desktop-post.png" */
  path: string;
  content: Buffer;
}

export interface PublishResult {
  sha: string;
  /** path → raw-rendering blob URL */
  urls: Map<string, string>;
}

export function blobUrl(ownerRepo: string, sha: string, filePath: string): string {
  const encoded = filePath.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${ownerRepo}/blob/${sha}/${encoded}?raw=true`;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Publish files to `branch` as a single commit. Creates the branch as an
 * orphan (no parents) when it does not exist. Retries once on a ref race.
 */
export async function publishAssets(
  gh: GitHub,
  ownerRepo: string,
  branch: string,
  files: AssetFile[],
  message: string,
): Promise<PublishResult> {
  if (files.length === 0) throw new Error('publishAssets: no files');

  // 1. Blobs in parallel (content is base64; 6 at a time keeps well under abuse limits).
  const blobs = await mapLimit(files, 6, async f => {
    const res = await gh.request<{ sha: string }>('POST', `/repos/${ownerRepo}/git/blobs`, {
      content: f.content.toString('base64'),
      encoding: 'base64',
    });
    return { path: f.path, sha: res.sha };
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    // 2. Current head of the assets branch (if any).
    let parentSha: string | null = null;
    let baseTree: string | undefined;
    try {
      const ref = await gh.request<{ object: { sha: string } }>('GET', `/repos/${ownerRepo}/git/ref/${encodeURIComponent(`heads/${branch}`)}`);
      parentSha = ref.object.sha;
      const commit = await gh.request<{ tree: { sha: string } }>('GET', `/repos/${ownerRepo}/git/commits/${parentSha}`);
      baseTree = commit.tree.sha;
    } catch (err) {
      if (!(err instanceof GitHubError) || err.status !== 404) throw err;
    }

    // 3. One tree, one commit.
    const tree = await gh.request<{ sha: string }>('POST', `/repos/${ownerRepo}/git/trees`, {
      ...(baseTree ? { base_tree: baseTree } : {}),
      tree: blobs.map(b => ({ path: b.path, mode: '100644', type: 'blob', sha: b.sha })),
    });
    const commit = await gh.request<{ sha: string }>('POST', `/repos/${ownerRepo}/git/commits`, {
      message,
      tree: tree.sha,
      parents: parentSha ? [parentSha] : [],
    });

    // 4. Move the ref (create when missing). A 422 here means another run raced us; retry.
    try {
      if (parentSha) {
        await gh.request('PATCH', `/repos/${ownerRepo}/git/refs/${encodeURIComponent(`heads/${branch}`)}`, { sha: commit.sha, force: false });
      } else {
        await gh.request('POST', `/repos/${ownerRepo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
      }
    } catch (err) {
      if (err instanceof GitHubError && (err.status === 422 || err.status === 409) && attempt < 2) continue;
      throw err;
    }

    const urls = new Map<string, string>();
    for (const f of files) urls.set(f.path, blobUrl(ownerRepo, commit.sha, f.path));
    return { sha: commit.sha, urls };
  }
  throw new Error(`Could not update ${branch} after 3 attempts (concurrent runs?)`);
}

export interface CommentResult {
  html_url: string;
  created: boolean;
}

/**
 * Create or update the single pre-post comment on a PR, identified by `marker`.
 */
export async function upsertStickyComment(
  gh: GitHub,
  ownerRepo: string,
  prNumber: number,
  body: string,
  marker: string,
): Promise<CommentResult> {
  for (let page = 1; page <= 5; page++) {
    const comments = await gh.request<Array<{ id: number; body: string; html_url: string }>>(
      'GET',
      `/repos/${ownerRepo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
    );
    const existing = comments.find(c => c.body?.includes(marker));
    if (existing) {
      const updated = await gh.request<{ id: number; html_url: string }>('PATCH', `/repos/${ownerRepo}/issues/comments/${existing.id}`, { body });
      return { html_url: updated.html_url, created: false };
    }
    if (comments.length < 100) break;
  }
  const created = await gh.request<{ id: number; html_url: string }>('POST', `/repos/${ownerRepo}/issues/${prNumber}/comments`, { body });
  return { html_url: created.html_url, created: true };
}

export interface DescriptionResult {
  html_url: string;
  /** False when the PR body could not be edited and nothing was written. */
  updated: boolean;
}

/**
 * Write `body` into a marked block in the PR description, replacing the block
 * from a previous run. The description is where reviewers look first, so this
 * is preferred over a comment.
 *
 * Returns updated: false when the token cannot edit the PR (a fork, or no write
 * access), so the caller can fall back to a comment instead of failing.
 */
export async function upsertPrDescription(
  gh: GitHub,
  ownerRepo: string,
  prNumber: number,
  body: string,
  marker: string,
): Promise<DescriptionResult> {
  const open = `<!-- ${marker}:start -->`;
  const close = `<!-- ${marker}:end -->`;
  const pr = await gh.request<{ body: string | null; html_url: string }>('GET', `/repos/${ownerRepo}/pulls/${prNumber}`);
  const section = `${open}\n${body}\n${close}`;
  const existing = pr.body ?? '';
  const start = existing.indexOf(open);
  const end = existing.indexOf(close);
  const next = start !== -1 && end > start
    ? existing.slice(0, start) + section + existing.slice(end + close.length)
    : (existing.trim() ? existing.trimEnd() + '\n\n' : '') + section;
  if (next === existing) return { html_url: pr.html_url, updated: true };
  try {
    await gh.request('PATCH', `/repos/${ownerRepo}/pulls/${prNumber}`, { body: next });
  } catch {
    return { html_url: pr.html_url, updated: false };
  }
  return { html_url: pr.html_url, updated: true };
}

export interface PruneResult {
  removed: string[];
  kept: string[];
  sha?: string;
}

/**
 * Remove `pr-<n>/` folders on the assets branch whose PR closed more than
 * `olderThanDays` ago. One commit; no history rewrite.
 */
export async function pruneAssets(
  gh: GitHub,
  ownerRepo: string,
  branch: string,
  olderThanDays: number,
  dryRun = false,
): Promise<PruneResult> {
  let headSha: string;
  try {
    const ref = await gh.request<{ object: { sha: string } }>('GET', `/repos/${ownerRepo}/git/ref/${encodeURIComponent(`heads/${branch}`)}`);
    headSha = ref.object.sha;
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return { removed: [], kept: [] };
    throw err;
  }
  const commit = await gh.request<{ tree: { sha: string } }>('GET', `/repos/${ownerRepo}/git/commits/${headSha}`);
  const tree = await gh.request<{ tree: Array<{ path: string; type: string; sha: string; mode: string }>; truncated: boolean }>(
    'GET',
    `/repos/${ownerRepo}/git/trees/${commit.tree.sha}?recursive=1`,
  );

  const folders = new Map<number, string[]>();
  for (const entry of tree.tree) {
    const m = entry.path.match(/^pr-(\d+)\//);
    if (m && entry.type === 'blob') {
      const n = Number(m[1]);
      const list = folders.get(n);
      if (list) list.push(entry.path); else folders.set(n, [entry.path]);
    }
  }

  const cutoff = Date.now() - olderThanDays * 86_400_000;
  const removed: string[] = [];
  const kept: string[] = [];
  const deletions: string[] = [];
  const entries = Array.from(folders.entries()).sort((a, b) => a[0] - b[0]);
  const staleFlags = await mapLimit(entries, 6, async ([n]) => {
    try {
      const pr = await getPr(gh, ownerRepo, n);
      const closedAt = pr.merged_at || pr.closed_at;
      return pr.state === 'closed' && Boolean(closedAt) && new Date(closedAt!).getTime() < cutoff;
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return true;
      throw err;
    }
  });
  entries.forEach(([n, paths], i) => {
    if (staleFlags[i]) {
      removed.push(`pr-${n}`);
      deletions.push(...paths);
    } else {
      kept.push(`pr-${n}`);
    }
  });

  if (dryRun || deletions.length === 0) return { removed, kept };

  const newTree = await gh.request<{ sha: string }>('POST', `/repos/${ownerRepo}/git/trees`, {
    base_tree: commit.tree.sha,
    tree: deletions.map(p => ({ path: p, mode: '100644', type: 'blob', sha: null })),
  });
  const newCommit = await gh.request<{ sha: string }>('POST', `/repos/${ownerRepo}/git/commits`, {
    message: `Prune screenshots for ${removed.length} closed PR(s)`,
    tree: newTree.sha,
    parents: [headSha],
  });
  await gh.request('PATCH', `/repos/${ownerRepo}/git/refs/${encodeURIComponent(`heads/${branch}`)}`, { sha: newCommit.sha });
  return { removed, kept, sha: newCommit.sha };
}
