/**
 * The capture → diff pipeline shared by `pr` and the two-URL mode.
 * Every route/viewport pair runs concurrently; the browser's page pool bounds it.
 */

import fs from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { ArtifactKind, artifactSuffix, AuthOptions, BlockedSide, CaptureResult, RouteCaptureOutcome, RouteShift, ViewportSize } from './types.js';
import { captureScreenshot } from './browser.js';
import { checkLanding, signInHint } from './landing.js';
import { differentSitesHint, looksLikeDifferentSites, textOverlap, titleOverlap } from './sameness.js';
import { HttpStatusError, NavigationError } from './errors.js';
import { DiffPool } from './diff-pool.js';
import { authHint } from './doctor.js';
import { hostOf, joinUrl } from './url.js';

export interface CaptureTask {
  route: string;
  resolvedRoute: string;
  viewport: string;
  size: ViewportSize;
  beforeUrl: string;
  afterUrl: string;
}

/** Where the two sides came from, so a verdict about them can say which is which. */
export interface RunSides {
  before: { url: string; detail?: string };
  after: { url: string; detail?: string };
  /**
   * How this caller's user would fix a wrong pairing. Only the command knows:
   * `pr` chose the baseline and can offer `--before`, while the two-URL mode
   * was handed both sides as positional arguments, where that flag means
   * nothing.
   */
  fix?: string;
}

/**
 * Why this run cannot be reported as a comparison.
 *
 * Two ways to reach the same conclusion, kept apart because they need
 * different advice: a wall wants credentials, a wrong baseline wants a URL.
 */
export interface RunVerdict {
  kind: 'walled' | 'different-sites';
  /** The single actionable sentence a human needs. */
  hint: string;
}

export interface RunResult {
  outcomes: RouteCaptureOutcome[];
  /** Non-null when the run did not compare what it claims to have compared. */
  verdict: RunVerdict | null;
}

export interface PipelineOptions {
  outputDir: string;
  fullPage: boolean;
  maxHeight: number;
  scale: number;
  threshold: number;
  minChangedArea: number;
  wait?: number;
  auth?: AuthOptions;
  /**
   * How resolution chose the two sides. Optional: without it a verdict still
   * fires and names the URLs the captures actually used, which is enough to
   * act on — it just cannot say *why* that baseline was picked.
   */
  sides?: RunSides;
  log?: (msg: string) => void;
}

export function routeSlug(route: string): string {
  const slug = route.replace(/^\/+|\/+$/g, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'home';
}

/**
 * Did this capture change?
 *
 * Two arms, because they cover different regimes and neither covers both:
 *
 * - Painted area, in CSS pixels² — the rule for pages. Measured against the
 *   fixture ladder, every deliberate change covers 242 CSS px² or more while
 *   every no-op covers exactly 0, so the floor sits in a wide empty band. CSS
 *   pixels rather than device pixels so it means the same at --scale 1 as at
 *   --scale 2; the old device-pixel constant was silently four times stricter
 *   at scale 1, and at ~10 CSS px² amounted to a third of one letter.
 * - Share of the canvas — the rule for small images. One pixel of a 20x20 icon
 *   is a quarter of a percent of it and obviously a change, but it will never
 *   reach an area floor sized for pages.
 *
 * On a full page the ratio arm effectively never fires on its own (a recoloured
 * 16px icon is 0.024% of one), and on a small image the area arm never does.
 * Dropping either one loses real changes, which is the worse error: reporting
 * "no visual changes" on a PR that changed something is the one answer that
 * makes a reviewer stop looking.
 */
export function isChanged(
  diff: { changedRatio: number; changedPixels: number },
  opts: { minChangedArea: number; threshold: number; scale: number },
): boolean {
  if (diff.changedPixels === 0) return false;
  return diff.changedPixels / (opts.scale * opts.scale) >= opts.minChangedArea
    || diff.changedRatio >= opts.threshold;
}

/** "shifted down 48px" — the direction spelled out, because the sign is not. */
export function describeShift(px: number): string {
  const rounded = Math.round(Math.abs(px));
  return `shifted ${px < 0 ? 'up' : 'down'} ${rounded}px`;
}

function describeError(err: unknown, side: 'before' | 'after', url: string): string {
  if (err instanceof HttpStatusError) return authHint(err);
  if (err instanceof NavigationError) {
    switch (err.kind) {
      case 'refused': return `connection refused at ${url} (is the ${side === 'after' ? 'dev server' : 'site'} running?)`;
      case 'timeout': return `timed out loading ${url}`;
      case 'dns': return `cannot resolve ${hostOf(url)}`;
      default: return `${side}: ${err.message.slice(0, 160)}`;
    }
  }
  const msg = (err as Error)?.message || String(err);
  return `${side}: ${msg.split('\n')[0].slice(0, 160)}`;
}

/** Did this side reach the site, or a wall standing in front of it? */
function blockedSide(requested: string, result: CaptureResult, side: 'before' | 'after'): BlockedSide | null {
  const landing = checkLanding(requested, result.finalUrl ?? requested, result.title ?? '');
  return landing.blocked ? { side, finalUrl: landing.finalUrl, vercel: Boolean(result.vercel) } : null;
}

async function runTask(task: CaptureTask, opts: PipelineOptions, pool: DiffPool): Promise<RouteCaptureOutcome> {
  const started = Date.now();
  const base: RouteCaptureOutcome = { route: task.route, resolvedRoute: task.resolvedRoute, viewport: task.viewport, status: 'error' };
  const captureOpts = {
    viewport: task.size,
    fullPage: opts.fullPage,
    maxHeight: opts.maxHeight,
    scale: opts.scale,
    wait: opts.wait,
    auth: opts.auth,
  };

  const [beforeRes, afterRes] = await Promise.allSettled([
    captureScreenshot(task.beforeUrl, captureOpts),
    captureScreenshot(task.afterUrl, captureOpts),
  ]);
  if (beforeRes.status === 'rejected' || afterRes.status === 'rejected') {
    const errors: string[] = [];
    if (beforeRes.status === 'rejected') errors.push(describeError(beforeRes.reason, 'before', task.beforeUrl));
    if (afterRes.status === 'rejected') errors.push(describeError(afterRes.reason, 'after', task.afterUrl));
    return { ...base, error: errors.join('; '), durationMs: Date.now() - started };
  }

  const before = beforeRes.value;
  const after = afterRes.value;

  // A sign-in wall answers with 200, so both captures "succeeded" — of a login
  // page. Diffing those and calling the result a visual change is the failure
  // this check exists to prevent, so nothing is compared when either side is
  // walled.
  const blocked = blockedSide(task.beforeUrl, before, 'before') ?? blockedSide(task.afterUrl, after, 'after');
  if (blocked) {
    const label = blocked.side === 'before' ? 'Pre' : 'Post';
    return {
      ...base,
      blocked,
      error: `${label} landed on a sign-in page (${blocked.finalUrl}), so the site was never captured`,
      durationMs: Date.now() - started,
    };
  }

  if (before.status === 404 && after.status === 404) {
    return { ...base, error: `404 on both ${task.beforeUrl} and ${task.afterUrl} (wrong route or missing sample?)`, durationMs: Date.now() - started };
  }

  const prefix = `${routeSlug(task.route)}-${task.viewport}`;
  const file = (kind: ArtifactKind) => path.join(opts.outputDir, `${prefix}-${artifactSuffix(kind)}.png`);
  const outputs = { before: file('before'), after: file('after'), diff: file('diff'), cropBefore: file('cropBefore'), cropAfter: file('cropAfter') };

  // A route that exists on only one side is not a comparison, and the moment to
  // notice is here — before the diff, not after it in a footnote.
  //
  // The old path diffed anyway. For a page this branch adds, "Pre" was a
  // screenshot of the baseline's 404 and the percentage measured the distance
  // between an error page and a new one: 10.81% for a coloured box on white,
  // 0.05% for a light-grey one, neither a fact about the change. Worse, both
  // numbers were published as a Pre/Post pair, so a reviewer was shown a
  // comparison that never existed and four images where one was true.
  //
  // Nothing can be recovered by trying harder — a page the baseline does not
  // serve has no "before" to find — so the honest move is to keep the side that
  // rendered, name why the other is missing, and skip the diff entirely.
  const absent = absentSide(before, after);
  if (absent) {
    const present = absent === 'before' ? after : before;
    const target = absent === 'before' ? outputs.after : outputs.before;
    fs.writeFileSync(target, Buffer.from(present.image));
    const status = absent === 'before' ? 'added' : 'removed';
    const missingHost = hostOf(absent === 'before' ? task.beforeUrl : task.afterUrl);
    opts.log?.(`  ${status === 'added' ? 'new     ' : 'removed '} ${task.route} @ ${task.viewport} (no ${absent === 'before' ? 'Pre' : 'Post'}, ${Date.now() - started}ms)`);
    return {
      ...base,
      status,
      files: absent === 'before' ? { after: outputs.after } : { before: outputs.before },
      // Deliberately no changedRatio: there is nothing to take a ratio of.
      // Deliberately no textOverlap either — a 404's wording is evidence about
      // an error page, not about whether the two sides are the same site.
      note: absent === 'before'
        ? `new page — no baseline (${missingHost} returned 404)`
        : `page removed — ${missingHost} returned 404`,
      durationMs: Date.now() - started,
    };
  }

  // Copy into standalone buffers so they can be transferred to the worker.
  const diff = await pool.run({
    before: new Uint8Array(before.image),
    after: new Uint8Array(after.image),
    outputs,
    options: {
      padding: 40 * opts.scale,
      minCrop: { width: 400 * opts.scale, height: 200 * opts.scale },
      highlightDownscale: opts.scale >= 2 ? 2 : 1,
      highlight: false,
    },
  });

  const notes: string[] = [];
  // The 404-on-one-side cases returned above; what is left is a page both sides
  // served with an unhappy status, which is still worth diffing and flagging.
  if (before.status && before.status >= 400) notes.push(`production returned ${before.status}`);
  if (after.status && after.status >= 400) notes.push(`local returned ${after.status}`);

  const changed = isChanged(diff, opts);
  // Cheap fingerprint of the baseline, kept so the run can notice a host that
  // answers every route with the same page. See softNotFoundWarning.
  const baselineHash = createHash('sha1').update(Buffer.from(before.image)).digest('hex');
  // Recorded on every outcome, judged only across the whole run: one route
  // sharing no words is a rewrite, every route sharing none is the wrong site.
  const overlap = textOverlap(before.text ?? '', after.text ?? '');
  const titles = titleOverlap(before.title ?? '', after.title ?? '');
  // A shift is measured in device pixels; everything a reader sees is in CSS
  // pixels. Whether anything changed besides the move is judged by the same
  // rule as any other capture, against the aligned numbers.
  const shift: RouteShift | undefined = diff.shift
    ? {
        px: diff.shift.dy / opts.scale,
        otherChange: isChanged(
          { changedPixels: diff.shift.alignedChangedPixels, changedRatio: diff.shift.alignedChangedRatio },
          opts,
        ),
      }
    : undefined;
  const shiftNote = shift ? `${describeShift(shift.px)}, ` : '';
  opts.log?.(`  ${changed ? 'changed ' : 'same    '} ${task.route} @ ${task.viewport} (${shiftNote}${(diff.changedRatio * 100).toFixed(2)}%, ${Date.now() - started}ms)`);
  return {
    ...base,
    status: changed ? 'changed' : 'unchanged',
    baselineHash,
    changedRatio: diff.changedRatio,
    sizeChanged: diff.sizeChanged,
    textOverlap: overlap,
    titleOverlap: titles,
    shift,
    files: {
      before: outputs.before,
      after: outputs.after,
      diff: diff.hasHighlight ? outputs.diff : undefined,
      cropBefore: diff.hasCrop ? outputs.cropBefore : undefined,
      cropAfter: diff.hasCrop ? outputs.cropAfter : undefined,
    },
    note: notes.join('; ') || undefined,
    durationMs: Date.now() - started,
  };
}

/**
 * Did this run compare the two sites, or something standing in front of them?
 *
 * This lives beside the code that produces the evidence, not in the command
 * that happens to want it. Both checks used to be written out in `pr`, and
 * `compare` — the other caller of this pipeline — therefore had neither, and
 * would print a confident percentage for two unrelated sites. Returning the
 * verdict with the outcomes makes that omission impossible to repeat: a caller
 * cannot get the numbers without also being handed the reason not to trust
 * them.
 *
 * Order matters. A wall is the more specific diagnosis and has the more
 * actionable fix, and a walled run also looks like two different sites — the
 * sign-in page shares no words with the site — so it is answered first.
 */
/**
 * Which side, if either, does not have this page at all.
 *
 * The signal is the HTTP status, not the page's wording. A 404 status is a fact
 * the server states about the route; the string "404" in the body is just text,
 * and it is present on pages that are merely *about* error codes and absent
 * from every custom or localised not-found page ever shipped. Sniffing for it
 * would mean this tool's own marketing page — which shows a 404 in a mockup —
 * could be mistaken for a missing route.
 *
 * Soft 404s (a not-found view served with status 200, the usual SPA shape) are
 * therefore invisible here by design; they are caught at the run level instead,
 * where identical baselines across unrelated routes give them away.
 */
function absentSide(before: CaptureResult, after: CaptureResult): 'before' | 'after' | null {
  const gone = (c: CaptureResult) => c.status === 404;
  const served = (c: CaptureResult) => !c.status || c.status < 400;
  if (gone(before) && served(after)) return 'before';
  if (gone(after) && served(before)) return 'after';
  return null;
}

/**
 * Did the baseline answer unrelated routes with the same page?
 *
 * This is the soft 404 — a not-found view served with status 200, which no
 * status check can see and which a keyword hunt for "404" would catch only in
 * English, only when the page says it, and only when no real page happens to
 * mention it. The durable signal is not the wording but the sameness: a host
 * that returns pixel-identical bytes for several different routes is serving a
 * catch-all, and every comparison against it is measuring the distance from
 * that catch-all rather than from the page.
 *
 * It warns rather than reclassifies. Two routes can legitimately render the
 * same page, and silently turning a real diff into "new page" on a heuristic
 * would hide exactly the change this tool exists to show. The authoritative
 * signal (a 404 status) acts; this one only tells the reader what it sees.
 */
export function softNotFoundWarning(outcomes: RouteCaptureOutcome[], beforeUrl: string): string | null {
  const routesByHash = new Map<string, Set<string>>();
  for (const o of outcomes) {
    if (!o.baselineHash) continue;
    const seen = routesByHash.get(o.baselineHash) ?? new Set<string>();
    seen.add(o.route);
    routesByHash.set(o.baselineHash, seen);
  }
  let worst: Set<string> | null = null;
  for (const routes of routesByHash.values()) {
    if (routes.size > 1 && (!worst || routes.size > worst.size)) worst = routes;
  }
  if (!worst) return null;
  const shown = [...worst].sort().slice(0, 4).join(', ');
  const more = worst.size > 4 ? `, and ${worst.size - 4} more` : '';
  return `Note: ${hostOf(beforeUrl)} served an identical page for ${worst.size} routes (${shown}${more}). `
    + 'If that is a catch-all or a not-found page, those comparisons are against it, not against the real baseline.';
}

export function verdictFor(outcomes: RouteCaptureOutcome[], sides: RunSides): RunVerdict | null {
  // Every route walled means the run never saw the site. Publishing anything
  // from that, "no visual changes" included, would be a confident lie.
  const walled = outcomes.filter(o => o.blocked);
  if (walled.length > 0 && walled.length === outcomes.length) {
    const { side, vercel } = walled[0].blocked!;
    return { kind: 'walled', hint: signInHint(side === 'before' ? sides.before.url : sides.after.url, vercel) };
  }
  if (looksLikeDifferentSites(outcomes)) {
    return { kind: 'different-sites', hint: differentSitesHint(sides.before.url, sides.before.detail, sides.after.url, sides.fix) };
  }
  return null;
}

export async function runTasks(tasks: CaptureTask[], opts: PipelineOptions): Promise<RunResult> {
  fs.mkdirSync(opts.outputDir, { recursive: true });
  const pool = new DiffPool();
  let outcomes: RouteCaptureOutcome[];
  try {
    outcomes = await Promise.all(tasks.map(t => runTask(t, opts, pool)));
  } finally {
    await pool.close();
  }
  // Falling back to the first task's URLs keeps the verdict available to a
  // caller that never resolved a pair — `compare`, given two URLs by hand.
  const sides = opts.sides ?? {
    before: { url: tasks[0]?.beforeUrl ?? '' },
    after: { url: tasks[0]?.afterUrl ?? '' },
  };
  const softNotFound = softNotFoundWarning(outcomes, sides.before.url);
  if (softNotFound) opts.log?.(softNotFound);
  return { outcomes, verdict: verdictFor(outcomes, sides) };
}
