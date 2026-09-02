/**
 * Choosing what to compare against what.
 *
 * Pre and Post used to be resolved independently, which could pair a production
 * deployment against a local dev server. Different fonts, different data,
 * different analytics — a diff full of changes the PR did not make. Nobody
 * reviews the raw images (the skill forbids it), so a noisy diff is believed.
 *
 * So a *pair* is resolved, not two URLs. Each strategy either produces both
 * sides from the same kind of environment or yields to the next one. Mixing
 * happens only when the caller asked for it by name, and is reported when it
 * does.
 */

import { GitHub } from './github.js';
import { deploymentUrlForSha, previewUrlFromComments } from './deployments.js';
import { LocalBaseline, serveBaseCommit, serveWorkingTree } from './baseline.js';
import { ProbeResult } from './doctor.js';
import { normalizeUrl } from './run.js';
import { PrePostConfig } from './types.js';
import { mergeBase } from './git.js';

export type UrlSource = 'flag' | 'config' | 'deployment' | 'dev-server' | 'homepage' | 'local-base';

export type StrategyName = 'explicit' | 'deployed' | 'local';

export interface Side {
  url: string;
  source: UrlSource;
  /** Human-readable provenance, e.g. "Preview deployment for 7bbb138". */
  detail: string;
}

export interface Comparison {
  strategy: StrategyName;
  before: Side;
  after: Side;
  /** True when the two sides come from different kinds of environment. */
  mixed: boolean;
  /** Tear down anything started to make this comparison possible. */
  stop: () => Promise<void>;
}

export interface PullRequestLike {
  number: number;
  head: { sha: string };
  base: { sha: string };
}

export interface ResolveContext {
  gh: GitHub | null;
  ownerRepo: string;
  pr: PullRequestLike | null;
  repoRoot: string;
  appPrefix?: string;
  config: PrePostConfig;
  before?: string;
  after?: string;
  /** Local dev server URL, if one is already running. */
  devServer: Promise<string | null>;
  probe: (url: string) => Promise<ProbeResult>;
  /** Skip building the base commit locally. */
  allowLocalBaseline?: boolean;
  /** Injectable for tests; defaults to a real git worktree + dev server. */
  serveBaseline?: typeof serveBaseCommit;
  /** Injectable for tests; defaults to booting this checkout's dev server. */
  servePost?: typeof serveWorkingTree;
  log: (msg: string) => void;
}

const isLocal = (url: string): boolean => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url);

/** Reachable and not sitting behind a login wall. */
async function usable(url: string, probe: ResolveContext['probe']): Promise<boolean> {
  const result = await probe(url);
  return result.status !== null && result.status !== 401 && result.status !== 403;
}

/**
 * The preview deployment for the PR's head commit.
 *
 * A deployment bot's PR comment carries no commit SHA — it is edited in place,
 * so mid-deploy it still advertises the *previous* commit's preview. Screenshotting
 * that and labelling it as this branch is the worst failure this tool has, because
 * it looks exactly like a correct result. The comment is therefore only trusted
 * once the provider has reported success against the head SHA itself.
 */
async function previewForHead(ctx: ResolveContext): Promise<Side | null> {
  const { gh, ownerRepo, pr } = ctx;
  if (!gh || !pr) return null;
  const sha = pr.head.sha;

  const recorded = await deploymentUrlForSha(gh, ownerRepo, sha, { production: false });
  if (recorded) {
    return { url: normalizeUrl(recorded.url), source: 'deployment', detail: `${recorded.environment} deployment for ${sha.slice(0, 7)}` };
  }

  if (!(await deploymentSucceededFor(gh, ownerRepo, sha))) return null;
  const commented = await previewUrlFromComments(gh, ownerRepo, pr.number, { appPrefix: ctx.appPrefix });
  return commented
    ? { url: normalizeUrl(commented.url), source: 'deployment', detail: `${commented.environment} deployment for ${sha.slice(0, 7)}` }
    : null;
}

/** Has a deployment provider reported success against this exact commit? */
async function deploymentSucceededFor(gh: GitHub, ownerRepo: string, sha: string): Promise<boolean> {
  try {
    const combined = await gh.request<{ statuses?: Array<{ state: string; context: string }> }>(
      'GET',
      `/repos/${ownerRepo}/commits/${sha}/status`,
    );
    return (combined.statuses ?? []).some(s => s.state === 'success' && /vercel|netlify|cloudflare|render/i.test(s.context));
  } catch {
    return false;
  }
}

/** The deployed baseline: what the caller pinned, or production for the base commit. */
async function deployedBaseline(ctx: ResolveContext): Promise<Side | null> {
  if (ctx.before) return { url: normalizeUrl(ctx.before), source: 'flag', detail: 'passed with --before' };
  if (ctx.config.before) return { url: normalizeUrl(ctx.config.before), source: 'config', detail: 'from .pre-post.json' };
  if (!ctx.gh || !ctx.pr) return null;
  const found = await deploymentUrlForSha(ctx.gh, ctx.ownerRepo, ctx.pr.base.sha, { production: true });
  return found
    ? { url: normalizeUrl(found.url), source: 'deployment', detail: `${found.environment} deployment for ${ctx.pr.base.sha.slice(0, 7)}` }
    : null;
}

/**
 * Resolve both sides together.
 *
 * `explicit` when the caller named both; then `deployed`, which needs a preview
 * for this commit and a deployed baseline; then `local`, which needs nothing but
 * the repository itself and therefore always works.
 */
export async function resolveComparison(ctx: ResolveContext): Promise<Comparison> {
  const noop = async () => undefined;

  // 1. Both sides named — the caller's call, mixed or not.
  if (ctx.before && ctx.after) {
    const before: Side = { url: normalizeUrl(ctx.before), source: 'flag', detail: 'passed with --before' };
    const after: Side = { url: normalizeUrl(ctx.after), source: 'flag', detail: 'passed with --after' };
    return { strategy: 'explicit', before, after, mixed: isLocal(before.url) !== isLocal(after.url), stop: noop };
  }

  // 2. Both sides deployed — same CDN, same fonts, same data.
  const preview = await previewForHead(ctx);
  if (preview && (await usable(preview.url, ctx.probe))) {
    const baseline = await deployedBaseline(ctx);
    if (baseline && !isLocal(baseline.url) && (await usable(baseline.url, ctx.probe))) {
      return { strategy: 'deployed', before: baseline, after: preview, mixed: false, stop: noop };
    }
    ctx.log('Preview deployment found but no reachable deployed baseline; comparing locally instead.');
  } else if (preview) {
    ctx.log(`Preview deployment ${preview.url} is not reachable (it may be behind Deployment Protection); comparing locally instead.`);
  }

  // 3. Both sides local — same browser, same machine, no network.
  const local = await ctx.devServer;
  let after: Side | null = ctx.after
    ? { url: normalizeUrl(ctx.after), source: 'flag', detail: 'passed with --after' }
    : local
      ? { url: normalizeUrl(local), source: 'dev-server', detail: 'local dev server' }
      : null;

  // Nothing deployed and nothing running is not a reason to stop: this is the
  // command you hit on the way out of a PR, so it starts the dev server itself
  // rather than handing back a chore.
  let postServer: LocalBaseline | null = null;
  if (!after && ctx.allowLocalBaseline !== false) {
    const serve = ctx.servePost ?? serveWorkingTree;
    postServer = await serve({ repoRoot: ctx.repoRoot, appPrefix: ctx.appPrefix, log: ctx.log });
    if (postServer) after = { url: normalizeUrl(postServer.url), source: 'dev-server', detail: 'working tree, served locally' };
  }
  if (!after) {
    throw new NoPostError();
  }
  const stopPost = postServer ? postServer.stop : noop;

  // A baseline the caller pinned wins even if it is remote; they asked for it.
  const pinned = ctx.before ?? ctx.config.before;
  if (pinned && ctx.before) {
    const before: Side = { url: normalizeUrl(pinned), source: 'flag', detail: 'passed with --before' };
    return { strategy: 'explicit', before, after, mixed: isLocal(before.url) !== isLocal(after.url), stop: stopPost };
  }

  if (ctx.allowLocalBaseline === false) {
    if (!pinned) throw new NoBaselineError();
    const before: Side = { url: normalizeUrl(pinned), source: 'config', detail: 'from .pre-post.json' };
    return { strategy: 'explicit', before, after, mixed: isLocal(before.url) !== isLocal(after.url), stop: stopPost };
  }

  // git knows what this branch forked from, so a baseline does not depend on a
  // PR existing yet — this often runs before one is opened.
  const baseSha = ctx.pr?.base.sha ?? mergeBase(ctx.repoRoot) ?? undefined;
  let baseline: LocalBaseline | null = null;
  if (baseSha) {
    const serve = ctx.serveBaseline ?? serveBaseCommit;
    baseline = await serve({ repoRoot: ctx.repoRoot, sha: baseSha, appPrefix: ctx.appPrefix, log: ctx.log });
  }
  if (baseline) {
    const before: Side = { url: normalizeUrl(baseline.url), source: 'local-base', detail: `base commit ${baseSha!.slice(0, 7)}, served locally` };
    return { strategy: 'local', before, after, mixed: false, stop: async () => { await baseline!.stop(); await stopPost(); } };
  }

  // Nothing local could be built; a pinned URL is better than no comparison.
  if (pinned) {
    const before: Side = { url: normalizeUrl(pinned), source: 'config', detail: 'from .pre-post.json' };
    return { strategy: 'explicit', before, after, mixed: isLocal(before.url) !== isLocal(after.url), stop: stopPost };
  }
  await stopPost();
  throw new NoBaselineError();
}

export class NoPostError extends Error {
  constructor() {
    super('No preview deployment for this commit and no dev server on the usual ports (3000, 5173, ...). Start the dev server (e.g. npm run dev), then re-run — or pass --after http://localhost:PORT.');
    this.name = 'NoPostError';
  }
}

export class NoBaselineError extends Error {
  constructor() {
    super('No baseline to compare against: no deployed baseline, and the base commit could not be served locally. Re-run with --before https://your-production-url (it is saved to .pre-post.json for next time).');
    this.name = 'NoBaselineError';
  }
}

/** The plan, for the log — an unattended tool has to say what it chose. */
export function describeComparison(c: Comparison): string[] {
  const lines = [
    `Comparing (${c.strategy}):`,
    `  Pre   ${c.before.url}  — ${c.before.detail}`,
    `  Post  ${c.after.url}  — ${c.after.detail}`,
  ];
  if (c.mixed) {
    lines.push('  Note: the two sides run in different environments, so some differences may not come from this branch.');
  }
  return lines;
}
