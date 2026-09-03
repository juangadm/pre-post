/**
 * `pre-post <before> <after>` — compare two URLs (or two PNG files) without
 * any GitHub involvement. Writes pre/post/diff images and prints a summary.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { PrRunResult, RouteCaptureOutcome } from '../types.js';
import { resolveSettings, Settings } from '../config.js';
import { closeBrowser } from '../browser.js';
import { ensureBrowser } from '../doctor.js';
import { diffImages } from '../diff.js';
import { parseViewport } from '../viewport.js';
import { resolveAuth } from '../sessions.js';
import { CaptureTask, isChanged, joinUrl, normalizeUrl, runTasks } from '../run.js';

export interface CompareOptions extends Partial<Settings> {
  before: string;
  after: string;
  routes?: string[];
  wait?: number;
  headers?: Record<string, string>;
  output?: string;
  log?: (msg: string) => void;
}

export function isImageFile(p: string): boolean {
  return /\.png$/i.test(p) && fs.existsSync(p);
}

export async function runCompare(opts: CompareOptions): Promise<PrRunResult> {
  const started = Date.now();
  const outputDir = opts.output || path.join(os.tmpdir(), 'pre-post', 'compare', String(Date.now()));
  fs.mkdirSync(outputDir, { recursive: true });
  // Ad-hoc comparisons default to the first screen and one viewport; `pr` is the full-page path.
  const settings = resolveSettings({}, { fullPage: false, viewports: ['desktop'], ...opts });

  let outcomes: RouteCaptureOutcome[];
  let before = opts.before;
  let after = opts.after;

  if (isImageFile(before) && isImageFile(after)) {
    const diff = diffImages(fs.readFileSync(before), fs.readFileSync(after));
    const diffPath = path.join(outputDir, 'diff.png');
    if (diff.highlight) fs.writeFileSync(diffPath, diff.highlight);
    outcomes = [{
      route: path.basename(before),
      resolvedRoute: before,
      viewport: 'image',
      // Two PNGs off disk were not captured at our scale — their pixels are
      // already whatever scale they were saved at, so compare area 1:1.
      status: isChanged(diff, { minChangedArea: settings.minChangedArea, threshold: settings.threshold, scale: 1 }) ? 'changed' : 'unchanged',
      changedRatio: diff.changedRatio,
      sizeChanged: diff.sizeChanged,
      files: { before, after, diff: diff.highlight ? diffPath : undefined },
    }];
  } else {
    before = normalizeUrl(before);
    after = normalizeUrl(after);
    const routes = opts.routes?.length ? opts.routes : ['/'];
    const viewports = settings.viewports.map(parseViewport);
    const tasks: CaptureTask[] = [];
    for (const route of routes) {
      for (const vp of viewports) {
        tasks.push({ route, resolvedRoute: route, viewport: vp.label, size: vp.size, beforeUrl: joinUrl(before, route), afterUrl: joinUrl(after, route) });
      }
    }
    const auth = resolveAuth({ headers: opts.headers, urls: [before, after] });
    await ensureBrowser();
    try {
      outcomes = await runTasks(tasks, { outputDir, ...settings, wait: opts.wait, auth, log: opts.log });
    } finally {
      await closeBrowser();
    }
  }

  return { repo: '', beforeBase: before, afterBase: after, outcomes, skippedDynamic: [], durationMs: Date.now() - started, markdown: '', outputDir };
}
