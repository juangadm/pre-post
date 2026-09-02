/**
 * `pre-post pr` — the one-shot path: detect → capture → diff → publish → comment.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { ARTIFACT_KINDS, ArtifactSet, Framework, PrRunResult } from '../types.js';
import { CONFIG_FILENAME, loadConfig, resolveSettings, Settings, updateConfig } from '../config.js';
import { currentBranch, headSha, repoRoot, resolveOwnerRepo } from '../git.js';
import { detectRoutesForRepo, resolveSample } from '../routes.js';
import { closeBrowser } from '../browser.js';
import { parseViewport } from '../viewport.js';
import { authHint, detectDevServer, ensureBrowser, NeedsHumanError, probeUrl } from '../doctor.js';
import { AssetFile, findOpenPr, getPr, GitHub, publishAssets, requireToken, upsertStickyComment } from '../github.js';
import { buildComment, STICKY_MARKER } from '../report.js';
import { resolveAuth } from '../sessions.js';
import { readPackage } from '../pkg.js';
import { CaptureTask, joinUrl, normalizeUrl, routeSlug, runTasks } from '../run.js';
import { deploymentUrlForSha } from '../deployments.js';

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
  version?: string;
  log?: (msg: string) => void;
}

/** Where a base URL came from, so failures can name the thing to change. */
export type UrlSource = 'flag' | 'config' | 'deployment' | 'dev-server' | 'homepage';

const SOURCE_FIX: Record<UrlSource, string> = {
  flag: 'Check the URL you passed.',
  config: `Check "before" in ${CONFIG_FILENAME}.`,
  deployment: 'That URL came from the deployment GitHub has for this commit — the deploy may have been removed, or your network may not reach it.',
  'dev-server': 'Is the dev server still running?',
  homepage: 'That URL came from "homepage" in package.json. Pass --before to override it.',
};

function unreachable(side: string, url: string, source: UrlSource): string {
  return `Cannot reach ${url} (${side}). ${SOURCE_FIX[source]}`;
}

function packageHomepage(root: string): string | undefined {
  const hp = readPackage(root)?.homepage;
  return typeof hp === 'string' && /^https?:\/\//.test(hp) && !/github\.com/.test(hp) ? hp : undefined;
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

  // --- "Post": the branch under review ----------------------------------------
  // A preview deployment is preferred over a local dev server so that anyone on
  // the team can screenshot a PR without checking the branch out.
  let after: string;
  let afterSource: UrlSource;
  const afterOverride = opts.after || config.after;
  const preview = !afterOverride && gh && pr ? await deploymentUrlForSha(gh, ownerRepo, pr.head.sha, { production: false }) : null;
  if (afterOverride) {
    after = normalizeUrl(afterOverride);
    afterSource = opts.after ? 'flag' : 'config';
  } else if (preview) {
    after = normalizeUrl(preview.url);
    afterSource = 'deployment';
    log(`Post: ${after} (${preview.environment} deployment for ${pr!.head.sha.slice(0, 7)})`);
  } else {
    const local = await devServer;
    if (!local) {
      throw new NeedsHumanError(
        'No preview deployment for this commit and no dev server on the usual ports (3000, 5173, ...). Start the dev server (e.g. npm run dev), then re-run — or pass --after http://localhost:PORT.',
      );
    }
    after = normalizeUrl(local);
    afterSource = 'dev-server';
    log(`Post: ${after} (local dev server)`);
  }

  // --- "Pre": what this branch forked from ------------------------------------
  let beforeRaw = opts.before || config.before;
  let beforeSource: UrlSource = opts.before ? 'flag' : beforeRaw ? 'config' : 'flag';
  if (!beforeRaw && gh && pr) {
    const baseline = await deploymentUrlForSha(gh, ownerRepo, pr.base.sha, { production: true });
    if (baseline) {
      beforeRaw = baseline.url;
      beforeSource = 'deployment';
      log(`Pre: ${beforeRaw} (${baseline.environment} deployment for ${pr.base.sha.slice(0, 7)})`);
    }
  }
  if (!beforeRaw) {
    beforeRaw = packageHomepage(root);
    if (beforeRaw) beforeSource = 'homepage';
  }
  if (!beforeRaw) {
    throw new NeedsHumanError(
      'No production URL known for the "before" state. Re-run with --before https://your-production-url (it is saved to .pre-post.json for next time).',
    );
  }
  const before = normalizeUrl(beforeRaw);
  if (opts.before && config.before !== before) {
    updateConfig(root, { before });
    log('Saved production URL to .pre-post.json');
  }

  // Headers alone are enough to probe production; cookies need the final URL list.
  const headers = resolveAuth({ configHeaders: config.headers, headers: opts.headers, urls: [before] })?.headers ?? {};
  const beforeProbe = probeUrl(before, headers);

  // --- Routes (sync: git + import graph) ----------------------------------------
  const samples = config.samples || {};
  let routes: string[];
  let skippedDynamic: string[] = [];
  if (opts.routes?.length) {
    routes = opts.routes;
  } else {
    const detection = detectRoutesForRepo({ cwd: root, config, maxRoutes: settings.maxRoutes, framework: opts.framework });
    routes = detection.routes.map(r => r.path);
    skippedDynamic = detection.skippedDynamic;
    log(`Routes (${detection.framework}, ${detection.durationMs}ms): ${routes.length ? routes.join(', ') : 'none detected'}`);
    for (const r of detection.routes) log(`  ${r.path.padEnd(28)} ${r.confidence.padEnd(6)} ${r.reason}`);
    if (routes.length === 0) {
      routes = ['/'];
      log('No routes detected from the diff; capturing / only.');
    }
  }

  // --- Reachability --------------------------------------------------------------
  const [probe, afterProbe] = await Promise.all([beforeProbe, probeUrl(after, headers)]);
  if (probe.status === null) throw new NeedsHumanError(unreachable('Pre', before, beforeSource));
  if (probe.status === 401 || probe.status === 403) throw new NeedsHumanError(authHint({ url: before, vercel: probe.vercel }));
  if (afterProbe.status === null) throw new NeedsHumanError(unreachable('Post', after, afterSource));
  if (afterProbe.status === 401 || afterProbe.status === 403) throw new NeedsHumanError(authHint({ url: after, vercel: afterProbe.vercel }));

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
  }

  // --- Publish -------------------------------------------------------------------
  const changed = outcomes.filter(o => o.status === 'changed' && o.files);
  if (gh && changed.length) {
    const folder = pr ? `pr-${pr.number}/${id}` : `branch/${routeSlug(branch || 'detached')}/${id}`;
    const keyFor = (o: typeof changed[number], kind: keyof ArtifactSet) => `${folder}/${routeSlug(o.route)}-${o.viewport}-${kind}.png`;
    const files: AssetFile[] = [];
    for (const o of changed) {
      for (const kind of ARTIFACT_KINDS) {
        const local = o.files![kind];
        if (local) files.push({ path: keyFor(o, kind), content: fs.readFileSync(local) });
      }
    }
    log(`Publishing ${files.length} image(s) to ${ownerRepo}@${settings.assetsBranch} ...`);
    const published = await publishAssets(gh, ownerRepo, settings.assetsBranch, files, pr ? `Screenshots for #${pr.number} (${id})` : `Screenshots for ${branch || 'detached'} (${id})`);
    for (const o of changed) {
      const urls: Partial<ArtifactSet> = {};
      for (const kind of ARTIFACT_KINDS) if (o.files![kind]) urls[kind] = published.urls.get(keyFor(o, kind));
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
      const comment = await upsertStickyComment(gh, ownerRepo, pr.number, result.markdown, STICKY_MARKER);
      result.commentUrl = comment.html_url;
      log(`${comment.created ? 'Posted' : 'Updated'} PR comment: ${comment.html_url}`);
    } else {
      log(`No open PR for branch "${branch}". Open one and re-run, or paste the markdown below.`);
    }
  }
  return result;
}
