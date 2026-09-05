/**
 * `pre-post pr` — the one-shot path: detect → capture → diff → publish → comment.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { ArtifactSet, Framework, PrePostConfig, PrRunResult } from '../types.js';
import { loadConfig, resolveSettings, Settings, updateConfig } from '../config.js';
import { currentBranch, headSha, repoRoot, resolveOwnerRepo } from '../git.js';
import { detectRoutesForRepo, resolveSample } from '../routes.js';
import { closeBrowser } from '../browser.js';
import { parseViewport } from '../viewport.js';
import { authHint, detectDevServer, ensureBrowser, NeedsHumanError, probeUrl } from '../doctor.js';
import { signInHint } from '../landing.js';
import { differentSitesHint, looksLikeDifferentSites } from '../sameness.js';
import { AssetFile, cannotPublishHint, checkWriteAccess, findOpenPr, getPr, getToken, GitHub, publishAssets, requireToken, upsertPrDescription, upsertStickyComment } from '../github.js';
import { buildComment, STICKY_MARKER } from '../report.js';
import { resolveAuth } from '../sessions.js';
import { CaptureTask, routeSlug, runTasks } from '../run.js';
import { joinUrl } from '../url.js';
import { Comparison, describeComparison, resolveComparison } from '../comparison.js';

export interface PrCommandOptions extends Partial<Settings> {
  cwd?: string;
  before?: string;
  after?: string;
  routes?: string[];
  framework?: Framework;
  /** Diff against this ref instead of the detected fork point. */
  base?: string;
  headers?: Record<string, string>;
  cookies?: Array<{ name: string; value: string }>;
  wait?: number;
  output?: string;
  /** Capture and diff only; do not publish or comment */
  dryRun?: boolean;
  /** Publish assets but do not touch the PR */
  comment?: boolean;
  pr?: number;
  /** Rebuild the baseline from the base commit when no URL is reachable. Default true. */
  localBaseline?: boolean;
  version?: string;
  log?: (msg: string) => void;
}

/**
 * What ends up on the assets branch. The diff overlay is an intermediate used
 * to locate the changed region; Pre beside Post is the comparison a reviewer
 * reads, so shipping the overlay is upload time and storage for nothing.
 */
const PUBLISHED_KINDS = ['before', 'after', 'cropBefore', 'cropAfter'] as const;

function headersFor(config: PrePostConfig, opts: PrCommandOptions): Record<string, string> {
  return resolveAuth({ configHeaders: config.headers, headers: opts.headers, urls: [] })?.headers ?? {};
}

function runId(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

export async function runPr(opts: PrCommandOptions = {}): Promise<PrRunResult> {
  const started = Date.now();
  const log = opts.log ?? (() => undefined);
  const root = repoRoot(opts.cwd);
  const config = loadConfig(root);
  const settings = resolveSettings(config, opts);
  const ownerRepo = resolveOwnerRepo(root);
  const branch = currentBranch(root);
  /** Tears down anything resolution started (a local dev server). */
  let cleanupComparison: () => Promise<void> = async () => undefined;

  // --- GitHub access (checked before any time is spent) -----------------------
  // A dry run still has to *read* GitHub: the PR, and the deployments that
  // decide what Pre and Post are. Only writing is off. Withholding the client
  // entirely made --dry-run the one mode that could never use a deployment,
  // so it always demanded a dev server — from the person least likely to have
  // one. Reads use `gh`; publishing and commenting use `writeGh`.
  const token = opts.dryRun ? getToken() : requireToken();
  const gh = token ? new GitHub(token) : null;
  const writeGh = opts.dryRun ? null : gh;

  // --- Start the slow, independent things now; they overlap route detection ----
  const browserReady = ensureBrowser();
  // Whether the token may write, asked at the same time as the PR lookup so it
  // costs no wall clock, and answered before anything expensive begins. A token
  // that cannot read fails the lookup below and never reaches capture; one that
  // reads but cannot write passes every check this run makes until the publish,
  // which is a whole capture pass later — 22.7s for one route at one viewport,
  // measured on a runner.
  const writeAccess = writeGh ? checkWriteAccess(writeGh, ownerRepo) : null;
  const lookup = gh
    ? opts.pr ? getPr(gh, ownerRepo, opts.pr) : branch ? findOpenPr(gh, ownerRepo, branch) : Promise.resolve(null)
    : Promise.resolve(null);
  // A dry run used to touch GitHub not at all, and must still work when it
  // cannot: it is what someone runs before anything is set up. A stale token or
  // an unreachable API degrades it to "no PR", never ends the run. A real run
  // needs the PR to publish against, so there the failure still surfaces.
  const prLookup = opts.dryRun
    ? lookup.catch(err => { log(`GitHub lookup failed (${err instanceof Error ? err.message : err}); continuing without it.`); return null; })
    : lookup;
  // Local detection runs regardless: it is cheap, and it is the fallback when
  // the PR has no preview deployment.
  const explicitAfter = opts.after ?? config.after;
  const devServer = explicitAfter ? Promise.resolve(explicitAfter) : detectDevServer();

  // Detection is synchronous git + fs work, so run it while the PR lookup is in
  // flight rather than after it.
  const detection = detectRoutesForRepo({ cwd: root, config, maxRoutes: settings.maxRoutes, framework: opts.framework, diffTarget: opts.base, log });
  const appPrefix = path.relative(root, detection.appRoot) || undefined;
  const head = headSha(root);
  const pr = await prLookup;

  // Before the local baseline, which can install and build a whole app, and
  // long before the captures. An answer that is not about access — a 500, a
  // dropped connection — is not evidence of anything, so it says so and the run
  // continues to fail wherever it really fails.
  const access = await writeAccess;
  if (access?.writable === false) {
    if (access.reason === 'rejected') throw new NeedsHumanError(cannotPublishHint(ownerRepo));
    log(`Could not check whether the token can publish (${access.detail}); continuing.`);
  }

  // --- What are we comparing? ---------------------------------------------------
  const headers = headersFor(config, opts);
  const comparison: Comparison = await resolveComparison({
    gh, ownerRepo, pr, repoRoot: root, appPrefix, config,
    // Detection already established this; the baseline must be built from the
    // same commit, or Pre and the route list disagree about what changed.
    baseSha: detection.base?.sha,
    // So a preview can be found for a branch that has been pushed but has no
    // PR open yet — the host builds on push, not on PR.
    headSha: head ?? undefined,
    before: opts.before, after: explicitAfter,
    devServer, probe: url => probeUrl(url, headers),
    allowLocalBaseline: opts.localBaseline, log,
  });
  cleanupComparison = comparison.stop;
  for (const line of describeComparison(comparison)) log(line);

  const before = comparison.before.url;
  const after = comparison.after.url;
  if (opts.before && config.before !== before) {
    updateConfig(root, { before });
    log('Saved production URL to .pre-post.json');
  }

  // --- Routes (sync: git + import graph) ----------------------------------------
  const samples = config.samples || {};
  let routes: string[];
  let skippedDynamic: string[] = [];
  if (opts.routes?.length) {
    routes = opts.routes;
  } else {
    routes = detection.routes.map(r => r.path);
    skippedDynamic = detection.skippedDynamic;
    log(`Routes (${detection.framework}, ${detection.durationMs}ms): ${routes.length ? routes.join(', ') : 'none detected'}`);
    for (const r of detection.routes) log(`  ${r.path.padEnd(28)} ${r.confidence.padEnd(6)} ${r.reason}`);
    if (routes.length === 0) {
      routes = ['/'];
      log('No routes detected from the diff; capturing / only.');
    }
  }

  // --- Reachability ---------------------------------------------------------------
  // Resolution already probed whatever it chose; this catches a side that died
  // in between, and names which one so the message is actionable.
  const fail = async (message: string): Promise<never> => {
    await cleanupComparison();
    throw new NeedsHumanError(message);
  };
  const [probe, afterProbe] = await Promise.all([
    comparison.before.probe ?? probeUrl(before, headers),
    comparison.after.probe ?? probeUrl(after, headers),
  ]);
  if (probe.status === null) await fail(`Cannot reach ${before} (Pre — ${comparison.before.detail}).`);
  if (probe.status === 401 || probe.status === 403) await fail(authHint({ url: before, vercel: probe.vercel }));
  if (afterProbe.status === null) await fail(`Cannot reach ${after} (Post — ${comparison.after.detail}).`);
  if (afterProbe.status === 401 || afterProbe.status === 403) await fail(authHint({ url: after, vercel: afterProbe.vercel }));

  const auth = resolveAuth({ configHeaders: config.headers, headers: opts.headers, cookies: opts.cookies, cookieUrl: before, urls: [before, after] });

  // --- Capture -------------------------------------------------------------------
  const now = new Date();
  const id = runId(now);
  const outputDir = opts.output || path.join(os.tmpdir(), 'pre-post', ownerRepo.replace('/', '__'), id);
  const viewports = settings.viewports.map(parseViewport);
  const tasks: CaptureTask[] = [];
  for (const route of routes) {
    const resolved = resolveSample(route, samples);
    for (const vp of viewports) {
      tasks.push({ route, resolvedRoute: resolved, viewport: vp.label, size: vp.size, beforeUrl: joinUrl(before, resolved), afterUrl: joinUrl(after, resolved) });
    }
  }
  log(`Capturing ${tasks.length * 2} screenshots (${routes.length} route(s) × ${viewports.length} viewport(s)) ...`);

  await browserReady;
  let outcomes;
  try {
    outcomes = await runTasks(tasks, { outputDir, ...settings, wait: opts.wait, auth, log });
  } finally {
    await closeBrowser();
    await cleanupComparison();
  }

  // Every route walled means the run never saw the site. Publishing "no visual
  // changes" — or anything else — from that would be a confident lie, so stop
  // with the one thing a human has to do.
  const walled = outcomes.filter(o => o.blocked);
  if (walled.length === outcomes.length && walled.length > 0) {
    const { side, vercel } = walled[0].blocked!;
    throw new NeedsHumanError(signInHint(side === 'before' ? comparison.before.url : comparison.after.url, vercel));
  }

  // The general case of the same failure: both sides answered, neither is a
  // wall, and they are simply not the same site — a baseline pointed at the
  // wrong host, or a production URL that has moved. The diff between two
  // different sites is a number, and publishing it as "visual changes" for
  // this branch is the confident-and-wrong answer this tool exists to avoid.
  if (looksLikeDifferentSites(outcomes)) {
    throw new NeedsHumanError(differentSitesHint(comparison.before.url, comparison.before.detail, comparison.after.url));
  }

  // --- Publish -------------------------------------------------------------------
  const changed = outcomes.filter(o => o.status === 'changed' && o.files);
  if (writeGh && changed.length) {
    const folder = pr ? `pr-${pr.number}/${id}` : `branch/${routeSlug(branch || 'detached')}/${id}`;
    const keyFor = (o: typeof changed[number], kind: keyof ArtifactSet) => `${folder}/${routeSlug(o.route)}-${o.viewport}-${kind}.png`;
    const files: AssetFile[] = [];
    for (const o of changed) {
      for (const kind of PUBLISHED_KINDS) {
        const local = o.files![kind];
        if (local) files.push({ path: keyFor(o, kind), content: fs.readFileSync(local) });
      }
    }
    log(`Publishing ${files.length} image(s) to ${ownerRepo}@${settings.assetsBranch} ...`);
    const published = await publishAssets(writeGh, ownerRepo, settings.assetsBranch, files, pr ? `Screenshots for #${pr.number} (${id})` : `Screenshots for ${branch || 'detached'} (${id})`);
    for (const o of changed) {
      const urls: Partial<ArtifactSet> = {};
      for (const kind of PUBLISHED_KINDS) if (o.files![kind]) urls[kind] = published.urls.get(keyFor(o, kind));
      o.urls = urls as ArtifactSet;
    }
  }

  const result: PrRunResult = {
    repo: ownerRepo,
    prNumber: pr?.number,
    beforeBase: before,
    afterBase: after,
    outcomes,
    skippedDynamic,
    durationMs: Date.now() - started,
    markdown: '',
    outputDir,
  };
  result.markdown = buildComment(result, { version: opts.version, headSha: head, now });

  if (writeGh && (opts.comment ?? true)) {
    if (pr) {
      // The description is what a reviewer reads first, so put the images there
      // and fall back to a comment only when the PR cannot be edited.
      const described = await upsertPrDescription(writeGh, ownerRepo, pr.number, result.markdown, 'pre-post');
      if (described.updated) {
        result.commentUrl = described.html_url;
        log(`Updated PR description: ${described.html_url}`);
      } else {
        const comment = await upsertStickyComment(writeGh, ownerRepo, pr.number, result.markdown, STICKY_MARKER);
        result.commentUrl = comment.html_url;
        log(`Cannot edit the PR description; ${comment.created ? 'posted' : 'updated'} a comment instead: ${comment.html_url}`);
      }
    } else {
      log(`No open PR for branch "${branch}". Open one and re-run, or paste the markdown below.`);
    }
  }
  return result;
}
