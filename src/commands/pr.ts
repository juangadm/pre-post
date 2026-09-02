/**
 * `pre-post pr` — the one-shot path: detect → capture → diff → publish → comment.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { ArtifactSet, Framework, PrePostConfig, PrRunResult } from '../types.js';
import { CONFIG_FILENAME, loadConfig, resolveSettings, Settings, updateConfig } from '../config.js';
import { currentBranch, headSha, repoRoot, resolveOwnerRepo } from '../git.js';
import { detectRoutesForRepo, resolveSample } from '../routes.js';
import { closeBrowser } from '../browser.js';
import { parseViewport } from '../viewport.js';
import { authHint, detectDevServer, ensureBrowser, NeedsHumanError, probeUrl } from '../doctor.js';
import { AssetFile, findOpenPr, getPr, GitHub, publishAssets, requireToken, upsertPrDescription, upsertStickyComment } from '../github.js';
import { buildComment, STICKY_MARKER } from '../report.js';
import { resolveAuth } from '../sessions.js';
import { readPackage } from '../pkg.js';
import { CaptureTask, joinUrl, normalizeUrl, routeSlug, runTasks } from '../run.js';
import { Comparison, describeComparison, NoBaselineError, NoPostError, resolveComparison, UrlSource } from '../comparison.js';

export interface PrCommandOptions extends Partial<Settings> {
  cwd?: string;
  before?: string;
  after?: string;
  routes?: string[];
  framework?: Framework;
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

/** Where the app's package.json lives, relative to the repo root. */
function detectAppPrefix(root: string, config: PrePostConfig, opts: PrCommandOptions): string | undefined {
  const { appRoot } = detectRoutesForRepo({ cwd: root, config, maxRoutes: opts.maxRoutes, framework: opts.framework });
  return path.relative(root, appRoot) || undefined;
}

/**
 * What ends up on the assets branch. The diff overlay is an intermediate used
 * to locate the changed region; Pre beside Post is the comparison a reviewer
 * reads, so shipping the overlay is upload time and storage for nothing.
 */
const PUBLISHED_KINDS = ['before', 'after', 'cropBefore', 'cropAfter'] as const;

function packageHomepage(root: string): string | undefined {
  const hp = readPackage(root)?.homepage;
  return typeof hp === 'string' && /^https?:\/\//.test(hp) && !/github\.com/.test(hp) ? hp : undefined;
}

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
  /** Tears down anything resolution started (a local baseline server). */
  let cleanupComparison: () => Promise<void> = async () => undefined;

  // --- GitHub access (checked before any time is spent) -----------------------
  const gh = opts.dryRun ? null : new GitHub(requireToken());

  // --- Start the slow, independent things now; they overlap route detection ----
  const browserReady = ensureBrowser();
  const prLookup = gh
    ? opts.pr ? getPr(gh, ownerRepo, opts.pr) : branch ? findOpenPr(gh, ownerRepo, branch) : Promise.resolve(null)
    : Promise.resolve(null);
  // Local detection runs regardless: it is cheap, and it is the fallback when
  // the PR has no preview deployment.
  const devServer = opts.after || config.after ? Promise.resolve(opts.after || config.after!) : detectDevServer();

  const pr = await prLookup;
  const appPrefix = detectAppPrefix(root, config, opts);

  // --- What are we comparing? ---------------------------------------------------
  let comparison: Comparison;
  try {
    comparison = await resolveComparison({
      gh, ownerRepo, pr, repoRoot: root, appPrefix, config,
      before: opts.before, after: opts.after ?? config.after,
      devServer, probe: url => probeUrl(url, headersFor(config, opts)),
      allowLocalBaseline: opts.localBaseline, log,
    });
  } catch (err) {
    if (err instanceof NoPostError || err instanceof NoBaselineError) throw new NeedsHumanError(err.message);
    throw err;
  }
  cleanupComparison = comparison.stop;
  for (const line of describeComparison(comparison)) log(line);

  const before = comparison.before.url;
  const after = comparison.after.url;
  if (opts.before && config.before !== before) {
    updateConfig(root, { before });
    log('Saved production URL to .pre-post.json');
  }

  const headers = headersFor(config, opts);

  // --- Routes (sync: git + import graph) ----------------------------------------
  const samples = config.samples || {};
  const detection = detectRoutesForRepo({ cwd: root, config, maxRoutes: settings.maxRoutes, framework: opts.framework });
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
  const [probe, afterProbe] = await Promise.all([probeUrl(before, headers), probeUrl(after, headers)]);
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

  // --- Publish -------------------------------------------------------------------
  const changed = outcomes.filter(o => o.status === 'changed' && o.files);
  if (gh && changed.length) {
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
    const published = await publishAssets(gh, ownerRepo, settings.assetsBranch, files, pr ? `Screenshots for #${pr.number} (${id})` : `Screenshots for ${branch || 'detached'} (${id})`);
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
  result.markdown = buildComment(result, { version: opts.version, headSha: headSha(root), now });

  if (gh && (opts.comment ?? true)) {
    if (pr) {
      // The description is what a reviewer reads first, so put the images there
      // and fall back to a comment only when the PR cannot be edited.
      const described = await upsertPrDescription(gh, ownerRepo, pr.number, result.markdown, 'pre-post');
      if (described.updated) {
        result.commentUrl = described.html_url;
        log(`Updated PR description: ${described.html_url}`);
      } else {
        const comment = await upsertStickyComment(gh, ownerRepo, pr.number, result.markdown, STICKY_MARKER);
        result.commentUrl = comment.html_url;
        log(`Cannot edit the PR description; ${comment.created ? 'posted' : 'updated'} a comment instead: ${comment.html_url}`);
      }
    } else {
      log(`No open PR for branch "${branch}". Open one and re-run, or paste the markdown below.`);
    }
  }
  return result;
}
