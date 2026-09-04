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

import { GitHub, PullRequestRef } from './github.js';
import { deploymentUrlForSha, findPreviewForCommit } from './deployments.js';
import { LocalBaseline, serveBaseCommit, serveWorkingTree } from './baseline.js';
import { NeedsHumanError, ProbeResult } from './doctor.js';
import { isLocalUrl, normalizeUrl } from './url.js';
import { PrePostConfig } from './types.js';
import { mergeBase } from './git.js';

export type StrategyName = 'explicit' | 'deployed' | 'local';

export interface Side {
  url: string;
  /** Human-readable provenance, e.g. "Preview deployment for 7bbb138". */
  detail: string;
  /** The probe resolution already took, so callers need not repeat it. */
  probe?: ProbeResult;
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

export interface ResolveContext {
  gh: GitHub | null;
  ownerRepo: string;
  pr: PullRequestRef | null;
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

const noop = async (): Promise<void> => undefined;

const side = (url: string, detail: string, probe?: ProbeResult): Side => ({ url: normalizeUrl(url), detail, probe });

/**
 * The one place a Comparison is built, so `mixed` is derived rather than
 * recomputed — a construction site that forgot it would report a production
 * page against a dev server as a clean comparison.
 */
const pair = (strategy: StrategyName, before: Side, after: Side, stop: () => Promise<void> = noop): Comparison =>
  ({ strategy, before, after, mixed: isLocalUrl(before.url) !== isLocalUrl(after.url), stop });

/** Reachable and not sitting behind a login wall. */
function isUsable(result: ProbeResult): boolean {
  return result.status !== null && result.status !== 401 && result.status !== 403;
}

/** The preview deployment for the PR's head commit, if there is a fresh one. */
async function previewForHead(ctx: ResolveContext): Promise<Side | null> {
  const { gh, ownerRepo, pr } = ctx;
  if (!gh || !pr) return null;
  const found = await findPreviewForCommit(gh, ownerRepo, { sha: pr.head.sha, prNumber: pr.number, appPrefix: ctx.appPrefix });
  return found ? side(found.url, `${found.environment} deployment for ${pr.head.sha.slice(0, 7)}`) : null;
}

/** The deployed baseline: what the caller pinned, or production for the base commit. */
async function deployedBaseline(ctx: ResolveContext): Promise<Side | null> {
  if (ctx.before) return side(ctx.before, 'passed with --before');
  if (ctx.config.before) return side(ctx.config.before, 'from .pre-post.json');
  if (!ctx.gh || !ctx.pr) return null;
  const found = await deploymentUrlForSha(ctx.gh, ctx.ownerRepo, ctx.pr.base.sha, { production: true });
  return found
    ? side(found.url, `${found.environment} deployment for ${ctx.pr.base.sha.slice(0, 7)}`)
    : null;
}

/** Both sides named by the caller: their call, mixed or not. */
function explicitPair(ctx: ResolveContext): Comparison | null {
  if (!ctx.before || !ctx.after) return null;
  return pair('explicit', side(ctx.before, 'passed with --before'), side(ctx.after, 'passed with --after'));
}

/** Both sides deployed — same build pipeline, same CDN, same data. */
async function deployedPair(ctx: ResolveContext): Promise<Comparison | null> {
  const [preview, baseline] = await Promise.all([previewForHead(ctx), deployedBaseline(ctx)]);
  if (!preview) return null;

  const [previewProbe, baselineProbe] = await Promise.all([
    ctx.probe(preview.url),
    baseline && !isLocalUrl(baseline.url) ? ctx.probe(baseline.url) : Promise.resolve(null),
  ]);
  if (!isUsable(previewProbe)) {
    ctx.log(`Preview deployment ${preview.url} is not reachable (it may be behind Deployment Protection); comparing locally instead.`);
    return null;
  }
  if (!baseline || !baselineProbe || !isUsable(baselineProbe)) {
    ctx.log('Preview deployment found but no reachable deployed baseline; comparing locally instead.');
    return null;
  }
  return pair('deployed', { ...baseline, probe: baselineProbe }, { ...preview, probe: previewProbe });
}

/**
 * Both sides local — same browser, same machine, no network.
 *
 * This is the strategy that always has something to offer, so it owns the dev
 * servers it starts: every exit below either hands their teardown to the
 * Comparison or runs it before throwing.
 */
async function localPair(ctx: ResolveContext): Promise<Comparison> {
  const running = await ctx.devServer;
  let after: Side | null = ctx.after
    ? side(ctx.after, 'passed with --after')
    : running ? side(running, 'local dev server') : null;

  // Nothing deployed and nothing running is not a reason to stop: this is the
  // command you hit on the way out of a PR, so it starts the dev server itself
  // rather than handing back a chore.
  let postServer: LocalBaseline | null = null;
  if (!after && ctx.allowLocalBaseline !== false) {
    postServer = await (ctx.servePost ?? serveWorkingTree)({ repoRoot: ctx.repoRoot, appPrefix: ctx.appPrefix, log: ctx.log });
    if (postServer) after = side(postServer.url, 'working tree, served locally');
  }
  if (!after) throw new NoPostError();
  const stopPost = postServer ? postServer.stop : noop;

  // A baseline the caller named wins even if it is remote; they asked for it.
  if (ctx.before) return pair('explicit', side(ctx.before, 'passed with --before'), after, stopPost);

  // git knows what this branch forked from, so a baseline does not depend on a
  // PR existing yet — this often runs before one is opened.
  const baseSha = ctx.pr?.base.sha ?? mergeBase(ctx.repoRoot) ?? undefined;
  const baseline = ctx.allowLocalBaseline === false || !baseSha
    ? null
    : await (ctx.serveBaseline ?? serveBaseCommit)({ repoRoot: ctx.repoRoot, sha: baseSha, appPrefix: ctx.appPrefix, log: ctx.log });
  if (baseline) {
    const before = side(baseline.url, `base commit ${baseSha!.slice(0, 7)}, served locally`);
    return pair('local', before, after, async () => { await baseline.stop(); await stopPost(); });
  }

  // Nothing local could be built; a configured URL beats no comparison at all.
  if (ctx.config.before) return pair('explicit', side(ctx.config.before, 'from .pre-post.json'), after, stopPost);
  await stopPost();
  throw new NoBaselineError();
}

/**
 * Resolve both sides together, cheapest strategy first.
 *
 * `explicit` when the caller named both; then `deployed`, which needs a preview
 * for this commit and a deployed baseline; then `local`, which needs nothing but
 * the repository itself.
 */
export async function resolveComparison(ctx: ResolveContext): Promise<Comparison> {
  return explicitPair(ctx) ?? (await deployedPair(ctx)) ?? localPair(ctx);
}

export class NoPostError extends NeedsHumanError {
  constructor() {
    super('No preview deployment for this commit and no dev server on the usual ports (3000, 5173, ...). Start the dev server (e.g. npm run dev), then re-run — or pass --after http://localhost:PORT.');
    this.name = 'NoPostError';
  }
}

export class NoBaselineError extends NeedsHumanError {
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
