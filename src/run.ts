/**
 * The capture → diff pipeline shared by `pr` and the two-URL mode.
 * Every route/viewport pair runs concurrently; the browser's page pool bounds it.
 */

import fs from 'fs';
import path from 'path';
import { AuthOptions, RouteCaptureOutcome, ViewportSize } from './types.js';
import { captureScreenshot } from './browser.js';
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

export interface PipelineOptions {
  outputDir: string;
  fullPage: boolean;
  maxHeight: number;
  scale: number;
  threshold: number;
  minChangedArea: number;
  wait?: number;
  auth?: AuthOptions;
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
  if (before.status === 404 && after.status === 404) {
    return { ...base, error: `404 on both ${task.beforeUrl} and ${task.afterUrl} (wrong route or missing sample?)`, durationMs: Date.now() - started };
  }

  const prefix = `${routeSlug(task.route)}-${task.viewport}`;
  const file = (kind: string) => path.join(opts.outputDir, `${prefix}-${kind}.png`);
  const outputs = { before: file('pre'), after: file('post'), diff: file('diff'), cropBefore: file('pre-crop'), cropAfter: file('post-crop') };

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
  if (before.status === 404 && after.status && after.status < 400) notes.push('new page (404 on production)');
  else if (before.status && before.status >= 400) notes.push(`production returned ${before.status}`);
  if (after.status && after.status >= 400) notes.push(`local returned ${after.status}`);

  const changed = isChanged(diff, opts);
  opts.log?.(`  ${changed ? 'changed ' : 'same    '} ${task.route} @ ${task.viewport} (${(diff.changedRatio * 100).toFixed(2)}%, ${Date.now() - started}ms)`);
  return {
    ...base,
    status: changed ? 'changed' : 'unchanged',
    changedRatio: diff.changedRatio,
    sizeChanged: diff.sizeChanged,
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

export async function runTasks(tasks: CaptureTask[], opts: PipelineOptions): Promise<RouteCaptureOutcome[]> {
  fs.mkdirSync(opts.outputDir, { recursive: true });
  const pool = new DiffPool();
  try {
    return await Promise.all(tasks.map(t => runTask(t, opts, pool)));
  } finally {
    await pool.close();
  }
}
