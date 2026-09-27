/**
 * `pre-post pr` — the one-shot path: detect → capture → diff → publish → comment.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { ArtifactKind, ARTIFACT_KINDS, ArtifactSet, artifactSuffix, Framework, isBrokenVerdict, PrePostConfig, PrRunResult } from '../types.js';
import { loadConfig, resolveSettings, Settings, updateConfig } from '../config.js';
import { currentBranch, headSha, repoRoot, resolveOwnerRepo } from '../git.js';
import { detectRoutesForRepo, resolveSample } from '../routes.js';
import { closeBrowser } from '../browser.js';
import { parseViewport } from '../viewport.js';
import { authHint, detectDevServer, ensureBrowser, NeedsHumanError, probeUrl } from '../doctor.js';
import { API_BASE, AssetFile, cannotPublishHint, checkWriteAccess, findOpenPr, findOpenPrForCommit, findToken, getPr, GitHub, GitHubError, loginHint, publishAssets, upsertPrDescription, upsertStickyComment } from '../github.js';
import { buildComment, STICKY_MARKER } from '../report.js';
import { resolveAuth } from '../sessions.js';
import { CaptureTask, routeSlug, runTasks } from '../run.js';
import { joinUrl } from '../url.js';
import { Comparison, describeComparison, resolveComparison } from '../comparison.js';
import { Stopwatch } from '../timings.js';
import { buildSheet } from '../sheet.js';

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
  /** Stop, successfully, before any work when GitHub says there is no open PR */
  requirePr?: boolean;
  /** Build both sides on this machine; never use deployments */
  local?: boolean;
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
const PUBLISHED_KINDS = ARTIFACT_KINDS.filter(kind => kind !== 'diff');

function headersFor(config: PrePostConfig, opts: PrCommandOptions): Record<string, string> {
  return resolveAuth({ configHeaders: config.headers, headers: opts.headers, urls: [] })?.headers ?? {};
}

/**
 * The Post URL the caller fixed, if any.
 *
 * `--local` promises Post is built from this checkout. A `.pre-post.json`
 * `after` is usually the author's own localhost, which a CI runner cannot
 * reach, so in local mode only a flag on this very command overrides it.
 */
export function afterFor(opts: Pick<PrCommandOptions, 'after' | 'local'>, config: Pick<PrePostConfig, 'after'>): string | undefined {
  return opts.after ?? (opts.local ? undefined : config.after);
}

function runId(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

export async function runPr(opts: PrCommandOptions = {}): Promise<PrRunResult> {
  const started = Date.now();
  const timings = new Stopwatch();
  const log = opts.log ?? (() => undefined);
  const root = repoRoot(opts.cwd);
  const config = loadConfig(root);
  const settings = resolveSettings(config, opts);
  const ownerRepo = resolveOwnerRepo(root);
  // A pull_request job checks out a merge commit with no branch, but names the
  // PR's branch in GITHUB_HEAD_REF.
  const branch = currentBranch(root) ?? (process.env.GITHUB_HEAD_REF?.trim() || null);
  const head = headSha(root);
  /** Tears down anything resolution started (a local dev server). */
  let cleanupComparison: () => Promise<void> = async () => undefined;

  // --- GitHub access (checked before any time is spent) -----------------------
  // A dry run still has to *read* GitHub: the PR, and the deployments that
  // decide what Pre and Post are. Only writing is off. Withholding the client
  // entirely made --dry-run the one mode that could never use a deployment,
  // so it always demanded a dev server — from the person least likely to have
  // one. Reads use `gh`; publishing and commenting use `writeGh`.
  //
  // A real run without working GitHub access still captures. Refusing up front
  // was right for someone at a laptop, who can log in and re-run; in a hosted
  // agent sandbox nobody is at the machine and the platform's own token is the
  // one refused, so stopping left the user with nothing to look at. The run now
  // captures, publishes nothing, and ends with the one sentence that fixes it.
  const found = findToken();
  let gh = found ? new GitHub(found.token) : null;
  let writeGh = opts.dryRun ? null : gh;
  /** Why nothing will be published, one per way of finding out; the most specific wins. */
  const notPublished: { noToken?: string; lookup?: string; write?: string } = {
    noToken: !opts.dryRun && !found ? `GitHub access is needed to publish screenshots. ${loginHint()}` : undefined,
  };

  // Whether the token may write, asked at the same time as the PR lookup so it
  // costs no wall clock, and answered before anything expensive begins. A token
  // that cannot read fails the lookup below and never reaches capture; one that
  // reads but cannot write passes every check this run makes until the publish,
  // which is a whole capture pass later — 22.7s for one route at one viewport,
  // measured on a runner.
  const writeAccess = writeGh && found
    ? checkWriteAccess(writeGh, ownerRepo).then(access => ({ access, source: found.source }))
    : null;
  // Without a branch name (a detached checkout, as a deployment-triggered job
  // has) the PR is found from the commit it is headed by.
  const lookup = gh
    ? opts.pr ? getPr(gh, ownerRepo, opts.pr)
      : branch ? findOpenPr(gh, ownerRepo, branch)
        : head ? findOpenPrForCommit(gh, ownerRepo, head) : Promise.resolve(null)
    : Promise.resolve(null);
  // A dry run used to touch GitHub not at all, and must still work when it
  // cannot: it is what someone runs before anything is set up. A stale token or
  // an unreachable API degrades it to "no PR", never ends the run. A real run
  // degrades the same way and records why, so it can say so at the end.
  let lookupFailed = false;
  const prLookup = lookup.catch(err => {
    lookupFailed = true;
    const message = err instanceof Error ? err.message : String(err);
    if (opts.dryRun) {
      log(`GitHub lookup failed (${message}); continuing without it.`);
    } else {
      // A refused token already carries its fix; an answer from GitHub names
      // itself; anything else never reached GitHub at all.
      notPublished.lookup = err instanceof NeedsHumanError || err instanceof GitHubError
        ? message
        : `GitHub could not be reached (${message}), so nothing was published: check that this environment can reach ${API_BASE}, then re-run.`;
    }
    return null;
  });
  // A deployment-triggered job fires for pushes to main and for branches with
  // no PR, too. Capturing there would add images to the assets branch that no
  // PR will ever show. Asked before detection, which can fetch history and
  // fail on its own, because none of it matters when there is nothing to post
  // to. Only an answer from GitHub counts as "no PR": a lookup that failed
  // says nothing either way, and neither does one never made for want of a
  // token, so those runs carry on and end on the instruction that fixes them.
  if (opts.requirePr && gh && !(await prLookup) && !lookupFailed) {
    log('No open PR for this commit; nothing to do.');
    return {
      repo: ownerRepo, beforeBase: '', afterBase: '', outcomes: [], skippedDynamic: [],
      durationMs: Date.now() - started, markdown: '', outputDir: '',
      delivery: { status: 'no-pr' },
    };
  }

  // --- Start the slow, independent things now; they overlap route detection ----
  // Only after the --require-pr answer: a fresh runner would otherwise
  // download and launch Chromium for a run that is about to do nothing.
  const browserReady = timings.time('browser', ensureBrowser(), { background: true });
  /**
   * Everything this run started, in a form every early exit can call.
   *
   * The browser is launched from here rather than at the capture, so any throw
   * before that block owns closing it: the CLI's `process.exit` hides the
   * difference, but a caller using `runPr()` as a library catches the error and
   * is left with a Chromium nothing references. Awaiting the launch first is
   * what makes it work — `closeBrowser()` drops a pending launch and closes
   * nothing, and the launch then resolves into an orphan.
   */
  const stopEverything = async (): Promise<void> => {
    // Independent, so side by side: the browser and the servers each take
    // their own time to go, and neither needs the other gone first.
    await Promise.all([
      browserReady.catch(() => undefined).then(() => closeBrowser()),
      cleanupComparison(),
    ]);
  };
  // Local detection runs regardless: it is cheap, and it is the fallback when
  // the PR has no preview deployment.
  const explicitAfter = afterFor(opts, config);
  const devServer = explicitAfter ? Promise.resolve(explicitAfter) : detectDevServer();

  // Detection is synchronous git + fs work, so run it while the PR lookup is in
  // flight rather than after it.
  const detection = detectRoutesForRepo({ cwd: root, config, maxRoutes: settings.maxRoutes, framework: opts.framework, diffTarget: opts.base, log });
  timings.add('detect', detection.durationMs);
  const appPrefix = path.relative(root, detection.appRoot) || undefined;
  const pr = await timings.time('github', prLookup);
  // Whatever refused the lookup refuses every later read too: resolution would
  // only spend time asking GitHub for deployments it cannot see.
  if (lookupFailed) gh = null;

  // Before the local baseline, which can install and build a whole app, and
  // long before the captures. An answer that is not about access — a 500, a
  // dropped connection — is not evidence of anything, so it says so and the run
  // continues to fail wherever it really fails.
  const write = await writeAccess;
  if (write && !write.access.writable) {
    if (write.access.reason === 'rejected') notPublished.write = cannotPublishHint(ownerRepo, write.source);
    else log(`Could not check whether the token can publish (${write.access.detail}); continuing.`);
  }
  // The write probe knows which credential was refused, so its sentence is the
  // most precise; a failed lookup is next; a missing token is the fallback.
  const skipReason = notPublished.write ?? notPublished.lookup ?? notPublished.noToken;
  if (skipReason) {
    writeGh = null;
    log('GitHub will not accept this run\'s screenshots; capturing anyway, nothing will be published.');
  }

  // --- What are we comparing? ---------------------------------------------------
  const headers = headersFor(config, opts);
  // Resolution can throw (no baseline, an install that failed): the browser was
  // launched before this and nothing else would close it, so its teardown has
  // to cover the throw as well as the happy path.
  const comparison: Comparison = await timings.time('resolve', resolveComparison({
    gh, ownerRepo, pr, repoRoot: root, appPrefix, config,
    // Detection already established this; the baseline must be built from the
    // same commit, or Pre and the route list disagree about what changed.
    baseSha: detection.base?.sha,
    // --base is a constraint on the baseline, not just on the route list.
    baseExplicit: detection.base?.source === 'explicit',
    // So a preview can be found for a branch that has been pushed but has no
    // PR open yet — the host builds on push, not on PR.
    headSha: head ?? undefined,
    before: opts.before, after: explicitAfter,
    devServer, probe: url => probeUrl(url, headers),
    allowLocalBaseline: opts.localBaseline, localOnly: opts.local, log, timings,
  }), { contains: ['pre', 'post'] }).catch(async err => { await stopEverything(); throw err; });
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
    await stopEverything();
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
  let run;
  let sheetPath: string | undefined;
  try {
    run = await timings.time('capture', runTasks(tasks, {
      outputDir, ...settings, wait: opts.wait, auth, log,
      // So the verdict can name how Pre was chosen, not just where it points.
      sides: { before: comparison.before, after: comparison.after },
    }));
    // Drawn while the browser is still open. A convenience, so a failure to
    // draw it is logged and never costs the run its result.
    if (!run.verdict) {
      sheetPath = await timings.time('sheet', buildSheet(run.outcomes, outputDir))
        .then(p => p ?? undefined)
        .catch(err => { log(`Could not draw the summary sheet (${err instanceof Error ? err.message : err}).`); return undefined; });
    }
  } finally {
    // Timed on its own: deleting the baseline worktree, node_modules and all,
    // is real wall clock that used to show up under no step at all.
    await timings.time('cleanup', stopEverything());
  }
  const { outcomes } = run;

  // The pipeline judges whether it compared the two sites or something standing
  // in front of them — a sign-in wall, or a baseline that is a different site
  // altogether. Either way there is no honest result to publish, so stop with
  // the one thing a human has to do.
  //
  // A broken page is the other kind of verdict: not a setup problem but a
  // finding about the code, and the reviewer is the person who needs it. So it
  // is not thrown. The PR still gets its block, saying so in one sentence, and
  // nothing else: no image of an error page is ever published.
  const broken = isBrokenVerdict(run.verdict);
  if (run.verdict && !broken) throw new NeedsHumanError(run.verdict.hint);

  // --- Publish -------------------------------------------------------------------
  const changed = broken ? [] : outcomes.filter(o => (o.status === 'changed' || o.status === 'added' || o.status === 'removed') && o.files);
  if (writeGh && changed.length) {
    const folder = pr ? `pr-${pr.number}/${id}` : `branch/${routeSlug(branch || 'detached')}/${id}`;
    const keyFor = (o: typeof changed[number], kind: ArtifactKind) => `${folder}/${routeSlug(o.route)}-${o.viewport}-${artifactSuffix(kind)}.png`;
    const files: AssetFile[] = [];
    for (const o of changed) {
      for (const kind of PUBLISHED_KINDS) {
        const local = o.files![kind];
        if (local) files.push({ path: keyFor(o, kind), content: fs.readFileSync(local) });
      }
    }
    log(`Publishing ${files.length} image(s) to ${ownerRepo}@${settings.assetsBranch} ...`);
    const published = await timings.time('publish', () => publishAssets(writeGh, ownerRepo, settings.assetsBranch, files, pr ? `Screenshots for #${pr.number} (${id})` : `Screenshots for ${branch || 'detached'} (${id})`));
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
    sheetPath,
    timings: timings.toJSON(),
    delivery: opts.dryRun ? { status: 'dry-run' } : skipReason ? { status: 'skipped', hint: skipReason } : { status: 'published' },
    verdict: run.verdict ?? undefined,
  };
  result.markdown = buildComment(result, { version: opts.version, headSha: head, now, filesDir: outputDir });

  if (writeGh && (opts.comment ?? true)) await timings.time('describe', async () => {
    if (pr) {
      // The description is what a reviewer reads first, so put the images there
      // and fall back to a comment only when the PR cannot be edited.
      const described = await upsertPrDescription(writeGh, ownerRepo, pr.number, result.markdown, 'pre-post');
      if (described.updated) {
        result.commentUrl = described.html_url;
        result.commentKind = 'description';
        log(`Updated PR description: ${described.html_url}`);
      } else {
        const comment = await upsertStickyComment(writeGh, ownerRepo, pr.number, result.markdown, STICKY_MARKER);
        result.commentUrl = comment.html_url;
        result.commentKind = 'comment';
        log(`Cannot edit the PR description; ${comment.created ? 'posted' : 'updated'} a comment instead: ${comment.html_url}`);
      }
    } else {
      log(`No open PR for branch "${branch}". Open one and re-run, or paste the markdown below.`);
    }
  });
  // Measured again after the description update, so the summary's total and
  // the Timings line below describe the same span. The markdown above keeps
  // the earlier figure: it had to be written before this step could run.
  result.durationMs = Date.now() - started;
  result.timings = timings.toJSON();
  const [first, ...rest] = timings.summary(result.durationMs);
  log(`Timings: ${first}`);
  for (const line of rest) log(line);
  return result;
}
