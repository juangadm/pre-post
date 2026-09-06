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
import { deploymentUrlForSha, findPreviewForCommit, latestProductionDeployment } from './deployments.js';
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
  /**
   * The commit detection compared against, when it resolved one.
   *
   * This wins over the PR's base: it is what `--base` sets, and it is the
   * commit the route list was built from. The PR's base is the fallback for a
   * caller that has a PR but no detection of its own.
   */
  baseSha?: string;
  /**
   * True when `baseSha` is a ref the caller named with `--base`, which makes it
   * a constraint rather than a starting point: no strategy may widen past it.
   */
  baseExplicit?: boolean;
  /** This checkout's HEAD, so a preview can be found before a PR is opened. */
  headSha?: string;
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

/**
 * The preview deployment for the commit being reviewed, if there is a fresh one.
 *
 * Keyed on the commit rather than on the PR: a host builds a branch as soon as
 * it is pushed, so the preview usually exists before anyone opens the PR. The
 * PR number is passed when there is one only because the bot-comment fallback
 * needs somewhere to look.
 */
async function previewForHead(ctx: ResolveContext): Promise<Side | null> {
  const { gh, ownerRepo, pr } = ctx;
  const sha = pr?.head.sha ?? ctx.headSha;
  if (!gh || !sha) return null;
  const found = await findPreviewForCommit(gh, ownerRepo, { sha, prNumber: pr?.number, appPrefix: ctx.appPrefix });
  return found ? side(found.url, `${found.environment} deployment for ${sha.slice(0, 7)}`) : null;
}

/**
 * The deployed baseline, most honest answer first.
 *
 * Pinning Pre to the base commit is the right question and it is tried first.
 * The second step exists because production is a branch, not a commit: a
 * repository that does not deploy every push to its default branch has no
 * deployment at the fork point, and requiring one left the deployed comparison
 * with no Pre — a preview would be found, no baseline would be, and the run
 * fell back to needing a dev server nobody in the target audience has.
 *
 * Widening stops at deployments the host actually recorded. Every step names
 * the commit it answered with, so Pre is never mistaken for the base.
 */
async function deployedBaseline(ctx: ResolveContext): Promise<Side | null> {
  if (ctx.before) return side(ctx.before, 'passed with --before');
  if (ctx.config.before) return side(ctx.config.before, 'from .pre-post.json');
  if (!ctx.gh) return null;

  // What this branch forked from, if that exact commit was deployed. Usually it
  // was — a host that deploys every push to the default branch has one — but a
  // repository that deploys on a tag, promotes by hand, or whose base commit is
  // older than its retained deployments will find nothing here.
  const baseSha = ctx.baseSha ?? ctx.pr?.base.sha;
  if (baseSha) {
    const pinned = await deploymentUrlForSha(ctx.gh, ctx.ownerRepo, baseSha, { production: true });
    if (pinned) return side(pinned.url, `${pinned.environment} deployment for ${baseSha.slice(0, 7)}`);
  }

  // Widening is for a fork point this tool worked out on its own. A base the
  // caller named is a different thing: production is some other commit, so
  // answering with it would compare against a commit they did not ask for while
  // route detection still describes the ref they did -- the same Pre/route-list
  // disagreement that made `--base` worth fixing in the first place. Yield
  // instead, and let the local strategy build the named commit from source.
  if (ctx.baseExplicit) {
    ctx.log(`No deployment for the base you asked for (${baseSha?.slice(0, 7)}); building it locally rather than comparing against a different commit.`);
    return null;
  }

  // Otherwise what is on production now: the same site, possibly a few commits
  // ahead, so name the commit it was built from instead of implying the base.
  const latest = await latestProductionDeployment(ctx.gh, ctx.ownerRepo);
  if (latest) {
    return side(latest.url, `${latest.environment} deployment${latest.sha ? ` for ${latest.sha.slice(0, 7)}` : ''}`);
  }

  // Anything past here would be a guess at the site's address, and a baseline
  // that is quietly the wrong site reads as 100% changed on every route — a
  // result that looks exactly like a real one. Better to say so and stop.
  return null;
}

/** Both sides named by the caller: their call, mixed or not. */
function explicitPair(ctx: ResolveContext): Comparison | null {
  if (!ctx.before || !ctx.after) return null;
  return pair('explicit', side(ctx.before, 'passed with --before'), side(ctx.after, 'passed with --after'));
}

/** What the deployed strategy found, so a fallback can explain itself. */
interface DeployedAttempt {
  comparison: Comparison | null;
  /** The preview that exists for this commit, whether or not it could be paired. */
  preview: Side | null;
  /**
   * A deployed baseline that was found and then rejected, with the probe that
   * rejected it. "None recorded" and "recorded but behind a login wall" need
   * different instructions, and only this knows which happened.
   */
  rejectedBaseline?: { side: Side; probe: ProbeResult | null };
}

/**
 * Both sides deployed — same build pipeline, same CDN, same data.
 *
 * The preview is looked up first and alone: it is the cheap question, and when
 * there is no preview there is nothing for a baseline to pair with, so no
 * baseline requests are spent on a run that will compare locally anyway.
 */
async function deployedPair(ctx: ResolveContext): Promise<DeployedAttempt> {
  const preview = await previewForHead(ctx);
  if (!preview) return { comparison: null, preview: null };

  const [previewProbe, baseline] = await Promise.all([ctx.probe(preview.url), deployedBaseline(ctx)]);
  if (!isUsable(previewProbe)) {
    ctx.log(`Preview deployment ${preview.url} is not reachable (it may be behind Deployment Protection); comparing locally instead.`);
    return { comparison: null, preview: null };
  }

  const baselineProbe = baseline && !isLocalUrl(baseline.url) ? await ctx.probe(baseline.url) : null;
  if (!baseline || !baselineProbe || !isUsable(baselineProbe)) {
    ctx.log('Preview deployment found but no reachable deployed baseline; comparing locally instead.');
    return { comparison: null, preview, rejectedBaseline: baseline ? { side: baseline, probe: baselineProbe } : undefined };
  }
  return { comparison: pair('deployed', { ...baseline, probe: baselineProbe }, { ...preview, probe: previewProbe }), preview };
}

/**
 * Both sides local — same browser, same machine, no network.
 *
 * This is the strategy that always has something to offer, so it owns the dev
 * servers it starts: every exit below either hands their teardown to the
 * Comparison or runs it before throwing.
 */
async function localPair(ctx: ResolveContext, deployed: DeployedAttempt): Promise<Comparison> {
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
  if (!after) throw deployed.preview ? new NoDeployedBaselineError(deployed.preview.url, deployed.rejectedBaseline) : new NoPostError();
  const stopPost = postServer ? postServer.stop : noop;

  // A baseline the caller named wins even if it is remote; they asked for it.
  if (ctx.before) return pair('explicit', side(ctx.before, 'passed with --before'), after, stopPost);

  // git knows what this branch forked from, so a baseline does not depend on a
  // PR existing yet — this often runs before one is opened.
  const baseSha = ctx.baseSha ?? ctx.pr?.base.sha ?? mergeBase(ctx.repoRoot) ?? undefined;
  // Serving the base can now fail loudly rather than yielding — an install
  // that died is not a "try the next option", it is the answer. The Post
  // server is already up by then, so it has to come down before the throw
  // escapes; nothing above this has a handle on it yet.
  const baseline = ctx.allowLocalBaseline === false || !baseSha
    ? null
    : await (ctx.serveBaseline ?? serveBaseCommit)({ repoRoot: ctx.repoRoot, sha: baseSha, appPrefix: ctx.appPrefix, log: ctx.log })
        .catch(async err => { await stopPost(); throw err; });
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
  const explicit = explicitPair(ctx);
  if (explicit) return explicit;
  const deployed = await deployedPair(ctx);
  return deployed.comparison ?? localPair(ctx, deployed);
}

export class NoPostError extends NeedsHumanError {
  constructor() {
    super('No preview deployment for this commit and no dev server on the usual ports (3000, 5173, ...). Start the dev server (e.g. npm run dev), then re-run — or pass --after http://localhost:PORT.');
    this.name = 'NoPostError';
  }
}

/**
 * A preview exists but nothing could stand beside it.
 *
 * Worth its own error because the generic one says "no preview deployment for
 * this commit", which in this case is the opposite of what happened — and the
 * person hitting it is the one least able to act on advice about dev servers.
 *
 * The instruction depends on *why* there was no baseline. Telling someone to
 * pass `--before` when the baseline was found and turned them away at a login
 * wall sends them back to the same URL for the same failure; the fix there is
 * access, not an argument.
 */
export class NoDeployedBaselineError extends NeedsHumanError {
  constructor(previewUrl: string, rejected?: { side: Side; probe: ProbeResult | null }) {
    super(`Found the preview deployment for this commit (${previewUrl}) but nothing to compare it against: ${reasonFor(rejected)} No dev server is running either.`);
    this.name = 'NoDeployedBaselineError';
  }
}

const PIN_HINT = 'Re-run with --before https://your-production-url (it is saved to .pre-post.json for next time).';

function reasonFor(rejected?: { side: Side; probe: ProbeResult | null }): string {
  if (!rejected) return `no production deployment is recorded for this repository. ${PIN_HINT}`;
  const { side: baseline, probe } = rejected;
  if (probe && (probe.status === 401 || probe.status === 403)) {
    return `the baseline (${baseline.url} — ${baseline.detail}) returned ${probe.status}, so it is behind access control.${probe.vercel ? ' Set VERCEL_AUTOMATION_BYPASS_SECRET, or' : ''} run \`pre-post login ${baseline.url}\`, then re-run.`;
  }
  return `the baseline (${baseline.url} — ${baseline.detail}) could not be reached. Check it is up, or ${PIN_HINT[0].toLowerCase()}${PIN_HINT.slice(1)}`;
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
