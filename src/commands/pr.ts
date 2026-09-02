/**
 * `pre-post pr` — the one-shot path: detect → capture → diff → publish → comment.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { ARTIFACT_KINDS, ArtifactSet, Framework, PrRunResult } from '../types.js';
import { loadConfig, resolveSettings, Settings, updateConfig } from '../config.js';
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

  // --- Production URL --------------------------------------------------------
  const beforeRaw = opts.before || config.before || packageHomepage(root);
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

  // --- GitHub access (checked before any time is spent) -----------------------
  const gh = opts.dryRun ? null : new GitHub(requireToken());

  // --- Start the slow, independent things now; they overlap route detection ----
  const browserReady = ensureBrowser();
  const prLookup = gh
    ? opts.pr ? getPr(gh, ownerRepo, opts.pr) : branch ? findOpenPr(gh, ownerRepo, branch) : Promise.resolve(null)
    : Promise.resolve(null);
  const devServer = opts.after || config.after ? Promise.resolve(opts.after || config.after!) : detectDevServer();

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

  // --- Dev server and reachability --------------------------------------------
  const afterRaw = await devServer;
  if (!afterRaw) {
    throw new NeedsHumanError(
      'No dev server found on the usual ports (3000, 5173, ...). Start it (e.g. npm run dev), then re-run — or pass --after http://localhost:PORT.',
    );
  }
  const after = normalizeUrl(afterRaw);
  if (!opts.after && !config.after) log(`Dev server: ${after}`);

  const [probe, afterProbe] = await Promise.all([beforeProbe, probeUrl(after, headers)]);
  if (probe.status === null) throw new NeedsHumanError(`Cannot reach ${before}. Check the URL (or your VPN) and re-run.`);
  if (probe.status === 401 || probe.status === 403) throw new NeedsHumanError(authHint({ url: before, vercel: probe.vercel }));
  if (afterProbe.status === null) throw new NeedsHumanError(`Cannot reach ${after}. Is the dev server running?`);

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
  const pr = await prLookup;
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
