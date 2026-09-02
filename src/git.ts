/**
 * Thin git helpers. Every call is a single short-lived subprocess.
 */

import { execFileSync } from 'child_process';

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
  const base = defaultBranch(cwd);
  return tryGit(['merge-base', `origin/${base}`, 'HEAD'], cwd)
    || tryGit(['merge-base', base, 'HEAD'], cwd);
}

function lines(out: string | null): string[] {
  return out ? out.split('\n').map(l => l.trim()).filter(Boolean) : [];
}

/**
 * Files changed on this branch relative to the default branch, plus anything
 * staged, unstaged, or untracked. Paths are relative to the repo root.
 */
export function changedFiles(cwd = process.cwd(), diffTarget?: string): string[] {
  const files = new Set<string>();
  const root = repoRoot(cwd);
  const target = diffTarget || mergeBase(root) || 'HEAD';
  lines(tryGit(['diff', '--name-only', target], root)).forEach(f => files.add(f));
  lines(tryGit(['diff', '--name-only', '--cached'], root)).forEach(f => files.add(f));
  lines(tryGit(['diff', '--name-only'], root)).forEach(f => files.add(f));
  lines(tryGit(['ls-files', '--others', '--exclude-standard'], root)).forEach(f => files.add(f));
  return Array.from(files);
}
