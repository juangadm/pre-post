/**
 * Record a run's Moments: both sides of each, in parallel, then one clip each.
 *
 * Optional by the same rule as the summary sheet: a Moment that cannot be
 * recorded becomes one plain sentence in the PR, never a failed run. The
 * screenshots are the record; the clips show what screenshots cannot.
 */

import path from 'path';
import { AuthOptions, MomentOutcome } from './types.js';
import { Moment, longClipNote, quote } from './moments.js';
import { recordSide, SideRecording } from './record.js';
import { Card, composeMoment, layoutFor } from './compose.js';
import { parseViewport } from './viewport.js';
import { describeError, routeSlug } from './run.js';
import { joinUrl } from './url.js';

export interface RecordMomentsOptions {
  before: string;
  after: string;
  auth?: AuthOptions;
  outputDir: string;
  log?: (msg: string) => void;
}

function size(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/**
 * What the Pre pane shows: the recording (null when there is none to show),
 * and the card and note when Pre could not play the Moment. A missing page or
 * a missing button on Pre is the normal case for a new feature, so it reads
 * as news, not as a failure.
 */
function preSide(pre: PromiseSettledResult<SideRecording>, url: string): { pre: SideRecording | null; card?: Card; note?: string } {
  if (pre.status === 'rejected') {
    const why = describeError(pre.reason, 'before', url);
    return { pre: null, card: { title: 'Pre could not be loaded', detail: why.slice(0, 90) }, note: `Pre could not be loaded (${why}).` };
  }
  const rec = pre.value;
  if (rec.status !== undefined && rec.status >= 400) {
    return rec.status === 404
      ? { pre: null, card: { title: 'New page in this PR', detail: 'No page here on Pre' }, note: 'This page is new, so Pre has nothing to show.' }
      : { pre: null, card: { title: `Pre answered HTTP ${rec.status}` }, note: `Pre answered HTTP ${rec.status}.` };
  }
  if (rec.failure) {
    return { pre: rec, card: { title: 'Not in the old version', detail: `${rec.failure.message} on Pre` }, note: `${rec.failure.message} on Pre, so it is shown as new.` };
  }
  return { pre: rec };
}

async function recordOne(moment: Moment, index: number, opts: RecordMomentsOptions): Promise<MomentOutcome> {
  const vp = parseViewport(moment.viewport);
  const base: MomentOutcome = { name: moment.name, route: moment.route, viewport: vp.label, status: 'error' };
  const beforeUrl = joinUrl(opts.before, moment.route);
  const afterUrl = joinUrl(opts.after, moment.route);
  const side = { auth: opts.auth, maxWidth: layoutFor(vp.size).paneWidth };
  const [pre, post] = await Promise.allSettled([
    recordSide(beforeUrl, moment, vp.size, side),
    recordSide(afterUrl, moment, vp.size, side),
  ]);

  // Post is the change under review: if it cannot play the Moment there is no
  // clip worth showing, only the sentence that says why.
  if (post.status === 'rejected') return { ...base, error: `Post: ${describeError(post.reason, 'after', afterUrl)}` };
  if (post.value.status !== undefined && post.value.status >= 400) return { ...base, error: `Post answered HTTP ${post.value.status} for ${moment.route}.` };
  if (post.value.failure) return { ...base, error: `${post.value.failure.message} on Post (step ${post.value.failure.step + 1}).` };

  const shown = preSide(pre, beforeUrl);
  const stem = path.join(opts.outputDir, `moment-${routeSlug(moment.name.toLowerCase())}-${vp.label}`);
  try {
    const clip = await composeMoment({
      name: moment.name,
      steps: moment.steps,
      pre: shown.pre,
      post: post.value,
      preCard: shown.card,
      out: `${stem}.webm`,
      poster: `${stem}.jpg`,
    });
    return {
      ...base,
      status: 'recorded',
      preNote: shown.note,
      durationMs: clip.durationMs,
      bytes: clip.bytes,
      file: `${stem}.webm`,
      poster: `${stem}.jpg`,
      note: longClipNote(moment.name, clip.durationMs) ?? undefined,
    };
  } catch (err) {
    return { ...base, error: `Couldn't make the video: ${(err as Error)?.message?.split('\n')[0] ?? err}` };
  }
}

/** Record every Moment; never throws for a Moment's own failure. */
export async function recordMoments(moments: Moment[], opts: RecordMomentsOptions): Promise<MomentOutcome[]> {
  const log = opts.log ?? (() => undefined);
  if (!moments.length) return [];
  log(`Recording ${moments.length} Moment(s) ...`);
  // All at once: the page pool bounds how many pages are open, so wall time
  // is about the longest clip, not the sum of them.
  // Each Moment settles on its own: one that throws is one sentence in the PR,
  // never the loss of the others.
  const outcomes = await Promise.all(moments.map((m, i) => recordOne(m, i, opts).catch((err): MomentOutcome => ({
    name: m.name, route: m.route, viewport: m.viewport, status: 'error',
    error: `Couldn't record it: ${(err as Error)?.message?.split('\n')[0] ?? err}`,
  }))));
  for (const o of outcomes) {
    log(o.status === 'recorded'
      ? `  ${quote(o.name)} ${(o.durationMs! / 1000).toFixed(1)}s, ${size(o.bytes!)}${o.preNote ? ` — ${o.preNote}` : ''}`
      : `  ${quote(o.name)} not recorded: ${o.error}`);
    if (o.note) log(`  Note: ${o.note}`);
  }
  return outcomes;
}
