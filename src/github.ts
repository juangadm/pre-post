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

/** Where a token came from. Which one it is decides how a rejection is fixed. */
export type TokenSource = 'GH_TOKEN' | 'GITHUB_TOKEN' | 'gh';

export interface FoundToken {
  token: string;
  source: TokenSource;
}

/**
 * The token this run will use, and where it came from.
 *
 * The source is not bookkeeping: the env vars take precedence over the `gh`
 * CLI, so advice aimed at the wrong one is advice that cannot work. Someone
 * whose `GH_TOKEN` is refused gains nothing from `gh auth login`, because the
 * variable still wins on the next run.
 */
export function findToken(): FoundToken | null {
  if (process.env.GH_TOKEN) return { token: process.env.GH_TOKEN, source: 'GH_TOKEN' };
  if (process.env.GITHUB_TOKEN) return { token: process.env.GITHUB_TOKEN, source: 'GITHUB_TOKEN' };
  try {
    const out = execFileSync('gh', ['auth', 'token'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out ? { token: out, source: 'gh' } : null;
  } catch {
    return null;
  }
}

export function getToken(): string | null {
  return findToken()?.token ?? null;
}

/** A token and its source, or the one sentence telling the human how to get one. */
export function requireToken(purpose = 'publish screenshots'): FoundToken {
  const found = findToken();
  if (!found) throw new NeedsHumanError(`GitHub access is needed to ${purpose}. ${GH_LOGIN_HINT}`);
  return found;
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

/** What one write attempt established about this token's access to a repository. */
export type WriteAccess =
  /** The token wrote an object. It may still be refused a ref by a ruleset. */
  | { writable: true }
  /** GitHub refused the write. Nothing this run publishes will land. */
  | { writable: false; reason: 'rejected' }
  /** Nobody answered, or answered something that is not about access. */
  | { writable: false; reason: 'unknown'; detail: string };

/**
 * Can this token write to `ownerRepo`?
 *
 * `getToken()` checks that a token exists, which is a different question. A
 * GitHub Actions job that maps `secrets.GITHUB_TOKEN` gets one that reads
 * everything this tool reads and writes nothing: measured on this repository,
 * `GET /repos/juangadm/pre-post` answers 200 with `permissions.push: false`
 * and `POST .../git/blobs` answers 403. Those reads are the ones `pr` makes
 * before it captures, so without this the run spends its screenshots first and
 * discovers the refusal after.
 *
 * The probe is the first write `publishAssets` makes, on the one piece of
 * content that cannot add anything: the empty blob already exists in every
 * repository, so a successful call stores nothing new. A read cannot stand in
 * for it — `permissions.push` describes the account's access to the repository,
 * not the scopes the token carries, so it can report `true` for a credential
 * the write still refuses. That is the confident all-clear this check exists to
 * avoid, which is why it writes.
 *
 * What it proves is bounded: the token may write objects. Creating the assets
 * *ref* is a separate permission a ruleset can refuse, so `writable: true` is
 * "not this failure", never "the publish will work".
 */
export async function checkWriteAccess(gh: GitHub, ownerRepo: string): Promise<WriteAccess> {
  try {
    await gh.request('POST', `/repos/${ownerRepo}/git/blobs`, { content: '', encoding: 'utf-8' });
    return { writable: true };
  } catch (err) {
    // 401/403 arrive as NeedsHumanError from `request`; a repository an
    // installation cannot write is often hidden as 404 rather than refused.
    if (err instanceof NeedsHumanError) return { writable: false, reason: 'rejected' };
    if (err instanceof GitHubError) {
      if (err.status === 404) return { writable: false, reason: 'rejected' };
      return { writable: false, reason: 'unknown', detail: `GitHub answered ${err.status}` };
    }
    return { writable: false, reason: 'unknown', detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The one thing to do about a token that cannot publish.
 *
 * It follows the credential that was actually chosen, not just the
 * environment. Being inside a runner does not make `permissions:` the fix: a
 * workflow that sets `GH_TOKEN` to a PAT is refused by that PAT, and rewriting
 * the job's permissions changes only the `GITHUB_TOKEN` the run never reaches.
 * The same holds the other way round on a laptop, where `gh auth login` cannot
 * help while an env var is shadowing it.
 *
 * The runner sentence names both permissions, though only `contents` is what
 * this check tested. Naming `contents` alone would be advice that fails on its
 * own terms: a `permissions:` block sets every scope it omits to none, so
 * following it leaves a token that uploads the screenshots and is then refused
 * the PR description — measured on this repository, `PATCH /pulls/23` answers
 * 403 with only `contents: write` and 200 with `pull-requests: write` beside it.
 * A second trip through a full capture is not worth the tighter sentence.
 */
export function cannotPublishHint(ownerRepo: string, source: TokenSource): string {
  const inActions = process.env.GITHUB_ACTIONS === 'true';
  const perms = '"permissions: { contents: write, pull-requests: write }"';
  const nowhere = `cannot write to ${ownerRepo}, so the screenshots would have nowhere to go`;
  if (source === 'gh') {
    return `The gh CLI login ${nowhere}: run gh auth login as someone with write access, or set GH_TOKEN to a token carrying repo scope.`;
  }
  if (inActions && source === 'GITHUB_TOKEN') {
    return `This workflow's GITHUB_TOKEN ${nowhere}: give the job ${perms} and re-run.`;
  }
  if (inActions) {
    return `The GH_TOKEN this workflow sets ${nowhere}: give that credential write access, or unset it so the job's own GITHUB_TOKEN is used with ${perms}.`;
  }
  return `The ${source} set in this environment ${nowhere}: set it to a token carrying repo scope, or unset it to fall back on your gh CLI login.`;
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
  // Prepend: the screenshots are the first thing a reviewer should see.
  const next = start !== -1 && end > start
    ? existing.slice(0, start) + section + existing.slice(end + close.length)
    : section + (existing.trim() ? '\n\n' + existing.trimStart() : '');
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

const ASSETS_README_PATH = 'README.md';

/** Kept so pruning the last folder does not ask the API for an empty tree. */
const ASSETS_README = `# pre-post assets

Screenshots published by [pre-post](https://github.com/juangadm/pre-post), one folder per
pull request (\`pr-<number>/\`). Nothing here is edited by hand.

\`pre-post prune\` removes folders for pull requests closed more than \`pruneDays\` ago. This
file is what keeps the branch from becoming an empty tree, which the GitHub tree API
refuses to create.
`;

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

  // Deleting every blob would leave an empty tree, and git's empty tree is not
  // something the API will build: `tree: []` is refused as "Invalid tree info"
  // (422), and the canonical empty-tree SHA is not resolvable through the REST
  // API either (404) even though every repository contains that object. So the
  // last folder could never be removed -- prune worked in every case except the
  // one that finishes the job.
  //
  // The branch therefore keeps one file. `README.md` is chosen over an empty
  // marker because the branch is otherwise undocumented, and it is inert on
  // both sides: prune only ever counts `pr-<n>/` paths, and publish adds to
  // whatever tree it finds.
  const doomed = new Set(deletions);
  const survivors = tree.tree.filter(e => e.type === 'blob' && !doomed.has(e.path));

  // Rebuilding from scratch is only safe on a complete listing. A truncated one
  // does not show every entry, so "nothing survives" would be a statement about
  // the page that came back rather than about the branch, and the rebuild would
  // silently drop whatever GitHub left out. Subtracting from `base_tree` is the
  // safe answer there, and it cannot empty the tree either: truncation means
  // there are more entries than the ones being removed.
  const rebuild = survivors.length === 0 && !tree.truncated;

  try {
    const newTree = await gh.request<{ sha: string }>('POST', `/repos/${ownerRepo}/git/trees`, rebuild
      // No base_tree: the surviving tree is this file and nothing else.
      ? { tree: [{ path: ASSETS_README_PATH, mode: '100644', type: 'blob', content: ASSETS_README }] }
      : {
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
  } catch (err) {
    // Everything above this point was a read, so a write that fails here has
    // left the branch untouched and the run is always safe to repeat. What
    // changes is what the human should do about it, and naming the wrong cause
    // is worse than naming none: `request` has already turned 401 and 403 into
    // NeedsHumanError, so what reaches here is a refusal disguised as a 404, a
    // race, or GitHub being unwell -- and only the first is about permissions.
    if (err instanceof GitHubError) {
      if (err.status === 409 || err.status === 422) {
        throw new NeedsHumanError(`Another run moved ${branch} while prune was working on it; nothing was changed, so run pre-post prune again.`);
      }
      if (err.status === 429 || err.status >= 500) {
        throw new NeedsHumanError(`GitHub could not finish pruning ${branch} (it answered ${err.status}); nothing was changed, so run pre-post prune again in a few minutes.`);
      }
      throw new NeedsHumanError(
        `Could not update the ${branch} branch to prune ${removed.length} folder(s) (GitHub answered ${err.status}); ` +
        `check that your token still has contents: write on ${ownerRepo}, then run pre-post prune again.`,
      );
    }
    throw err;
  }
}
