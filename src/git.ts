/**
 * Thin git helpers. Every call is a single short-lived subprocess.
 */

import { execFileSync } from 'child_process';
import { NeedsHumanError } from './errors.js';

export function git(args: string[], cwd = process.cwd()): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryGit(args: string[], cwd?: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

export function repoRoot(cwd = process.cwd()): string {
  const root = tryGit(['rev-parse', '--show-toplevel'], cwd);
  if (!root) throw new Error('Not inside a git repository.');
  return root;
}

export function currentBranch(cwd?: string): string | null {
  const b = tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return b && b !== 'HEAD' ? b : null;
}

export function headSha(cwd?: string): string | null {
  return tryGit(['rev-parse', 'HEAD'], cwd);
}

/**
 * Parse "owner/repo" from a remote URL. Supports HTTPS, SSH, and proxy URLs
 * whose last two path segments are owner/repo.
 */
export function parseOwnerRepo(remoteUrl: string): string | null {
  const std = remoteUrl.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  if (std) return std[1];
  const fallback = remoteUrl.match(/\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return fallback ? fallback[1] : null;
}

export function resolveOwnerRepo(cwd?: string): string {
  const env = process.env.GH_REPO || process.env.GITHUB_REPOSITORY;
  if (env) return env;
  const url = tryGit(['remote', 'get-url', 'origin'], cwd);
  const parsed = url ? parseOwnerRepo(url) : null;
  if (!parsed) {
    throw new Error('Cannot determine GitHub repository. Set GH_REPO=owner/repo.');
  }
  return parsed;
}

/** Default branch of origin (main/master/...), best effort. */
export function defaultBranch(cwd?: string): string {
  const ref = tryGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
  if (ref) return ref.replace(/^origin\//, '');
  const found = lines(tryGit([
    'for-each-ref', '--format=%(refname:short)',
    'refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master',
  ], cwd));
  const first = found[0]?.replace(/^origin\//, '');
  return first || 'main';
}

/** Merge base between HEAD and the default branch, or null when unknown. */
export function mergeBase(cwd?: string): string | null {
  return mergeBaseWith(defaultBranch(cwd), cwd);
}

function mergeBaseWith(branch: string, cwd?: string): string | null {
  return tryGit(['merge-base', `origin/${branch}`, 'HEAD'], cwd)
    || tryGit(['merge-base', branch, 'HEAD'], cwd);
}

/** True when this clone was made with --depth, so its history may be missing. */
export function isShallow(cwd?: string): boolean {
  return tryGit(['rev-parse', '--is-shallow-repository'], cwd) === 'true';
}

/** The branch this work forked from: the CI hint first, then origin's default. */
export function baseBranchName(cwd?: string): string {
  // GitHub Actions sets this on pull_request events, and it is more reliable
  // than origin/HEAD in a checkout that has neither.
  const env = process.env.GITHUB_BASE_REF?.trim();
  return env || defaultBranch(cwd);
}

/**
 * Make the base branch reachable in a clone that does not have it.
 *
 * Sandbox and web environments check a branch out with `--depth 1
 * --single-branch`, which leaves no origin/<base> ref and no shared history to
 * fork from. Widen in three steps, stopping as soon as a merge base appears, so
 * the common case costs one shallow fetch rather than the whole history.
 */
function fetchBase(branch: string, cwd?: string): boolean {
  const refspec = `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
  const attempts = [
    ['fetch', '--no-tags', '--depth=50', 'origin', refspec],
    ['fetch', '--no-tags', '--deepen=200', 'origin', refspec],
    ['fetch', '--no-tags', '--unshallow', 'origin', refspec],
  ];
  for (const args of attempts) {
    // A deepen or unshallow against a complete clone is an error, not a result.
    if (tryGit(args, cwd) === null) continue;
    if (mergeBaseWith(branch, cwd)) return true;
  }
  return false;
}

/**
 * git's empty tree. Diffing against it lists every tracked file, which is the
 * honest answer in a repository whose first commit has not happened yet.
 */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** What a run diffs against, and how it was found. */
export interface BaseResolution {
  /** The commit the working tree is compared with. */
  sha: string;
  source: 'explicit' | 'merge-base' | 'fetched' | 'head';
  /** The base branch it came from, when one is known. */
  branch?: string;
}

export interface ResolveBaseOptions {
  /** A ref the caller named; it wins outright. */
  explicit?: string;
  /** Allow one network fetch to repair a shallow clone. Default true. */
  fetch?: boolean;
  log?: (msg: string) => void;
}

/**
 * The commit this branch forked from, or null when that cannot be established.
 *
 * Null is a real answer and callers must treat it as one: diffing against HEAD
 * instead reports only uncommitted work, so a branch whose changes are
 * committed comes back as "nothing changed" — the wrong answer, stated
 * confidently.
 */
export function resolveBase(cwd = process.cwd(), opts: ResolveBaseOptions = {}): BaseResolution | null {
  if (opts.explicit) {
    const sha = tryGit(['rev-parse', '--verify', '--quiet', `${opts.explicit}^{commit}`], cwd);
    if (!sha) throw new NeedsHumanError(`--base ${opts.explicit} is not a commit in this repository.`);
    return { sha, source: 'explicit' };
  }

  // No commits yet: everything in the tree is new, and there is nothing to
  // fork from. Not a failure — a repository at its very beginning.
  if (!headSha(cwd)) return { sha: EMPTY_TREE, source: 'head' };

  const branch = baseBranchName(cwd);
  const local = mergeBaseWith(branch, cwd);
  if (local) return { sha: local, source: 'merge-base', branch };

  if (opts.fetch !== false) {
    opts.log?.(`No local history for ${branch}; fetching it to see what this branch changed.`);
    if (fetchBase(branch, cwd)) {
      const sha = mergeBaseWith(branch, cwd);
      if (sha) return { sha, source: 'fetched', branch };
    }
  }

  // Standing on the base branch with nothing to fork from: the change under
  // review is whatever is uncommitted, which is what diffing HEAD reports.
  if (currentBranch(cwd) === branch) {
    const head = headSha(cwd);
    if (head) return { sha: head, source: 'head', branch };
  }
  return null;
}

/** `resolveBase`, with the one sentence a human needs when it comes back null. */
export function requireBase(cwd: string, opts: ResolveBaseOptions = {}): BaseResolution {
  const base = resolveBase(cwd, opts);
  if (base) return base;
  const branch = baseBranchName(cwd);
  throw new NeedsHumanError(
    `Cannot tell what this branch changed: this clone shares no history with ${branch}` +
    `${isShallow(cwd) ? ' (it is a shallow checkout)' : ''}. ` +
    `Run \`git fetch origin ${branch}\`, or pass --base <ref>.`,
  );
}

function lines(out: string | null): string[] {
  return out ? out.split('\n').map(l => l.trim()).filter(Boolean) : [];
}

/**
 * Files changed relative to `diffTarget`, plus anything staged, unstaged, or
 * untracked. Paths are relative to the repo root.
 *
 * The target is required: working it out is `resolveBase`'s job, because
 * guessing it wrong here is silent and reports an empty diff.
 */
export function changedFiles(cwd: string, diffTarget: string): string[] {
  const files = new Set<string>();
  const root = repoRoot(cwd);
  const target = diffTarget;
  lines(tryGit(['diff', '--name-only', target], root)).forEach(f => files.add(f));
  lines(tryGit(['diff', '--name-only', '--cached'], root)).forEach(f => files.add(f));
  lines(tryGit(['diff', '--name-only'], root)).forEach(f => files.add(f));
  lines(tryGit(['ls-files', '--others', '--exclude-standard'], root)).forEach(f => files.add(f));
  return Array.from(files);
}
