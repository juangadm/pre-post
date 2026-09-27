/**
 * Output formatting: the PR comment (for humans) and the terminal summary
 * (for the developer or the agent that invoked the CLI).
 */

import path from 'path';
import { ArtifactSet, isBrokenVerdict, PrRunResult, RouteCaptureOutcome, sideName } from './types.js';
import { describePageError, describeShift } from './run.js';
import { hostOf, isLocalUrl } from './url.js';
import { capNotice } from './routes.js';
import { MAX_MOMENTS, quote, skippedNote } from './moments.js';

export const STICKY_MARKER = '<!-- pre-post:visual-changes -->';

function code(s: string): string {
  return `\`${s}\``;
}

function viewportLabel(v: string): string {
  return v.charAt(0).toUpperCase() + v.slice(1);
}

function groupByRoute(outcomes: RouteCaptureOutcome[]): Map<string, RouteCaptureOutcome[]> {
  const map = new Map<string, RouteCaptureOutcome[]>();
  for (const o of outcomes) map.set(o.route, [...(map.get(o.route) ?? []), o]);
  return map;
}

/** One change to show, and the other routes that show exactly the same change. */
export interface ChangeGroup {
  lead: RouteCaptureOutcome;
  others: RouteCaptureOutcome[];
}

/**
 * Collapse routes that show the same change into one entry.
 *
 * A nav edit touches every page, and the report used to repeat it: six
 * sections, 24 images, one change. Routes whose change has the same
 * fingerprint, at the same viewport, are one entry led by the first of them.
 * So are routes whose only change is the same move: the sentence ("Content
 * shifted down 8px. Nothing else changed.") is the whole report, and eight
 * pages of it was twelve full-page images saying one thing. A move with
 * something else on top, or a change with no fingerprint, stands alone.
 */
export function groupChanges(outcomes: RouteCaptureOutcome[]): ChangeGroup[] {
  const groups: ChangeGroup[] = [];
  const byKey = new Map<string, ChangeGroup>();
  // Filtered here, not by callers: `pr` groups to choose what to upload and
  // the report groups to render, and both must pick the same lead.
  for (const o of outcomes.filter(o => o.status === 'changed' && (o.urls || o.files))) {
    const key = o.shift
      ? (o.shift.otherChange ? null : `${o.viewport}:move:${Math.round(o.shift.px)}`)
      : o.fingerprint ? `${o.viewport}:${o.fingerprint}` : null;
    const existing = key ? byKey.get(key) : undefined;
    if (existing) {
      existing.others.push(o);
      continue;
    }
    const group = { lead: o, others: [] };
    groups.push(group);
    if (key) byKey.set(key, group);
  }
  return groups;
}

/** A reviewer's name for a side: its label, else the host a deployment answers on. */
export function sideLabel(url: string, label: string | undefined, localName: string): string {
  return label ?? (isLocalUrl(url) ? localName : hostOf(url));
}

export interface CommentOptions {
  version?: string;
  headSha?: string | null;
  now?: Date;
  /**
   * The folder local screenshots were written to. When nothing was published
   * (a dry run), images are linked relative to it: an absolute temp path is
   * noise in the markdown and names nothing a reader can open anywhere else,
   * and the CLI already prints the folder on its own line.
   */
  filesDir?: string;
}

/**
 * The clips, above the screenshots: they show what screenshots cannot, and a
 * reviewer who presses play once has seen the change.
 *
 * An attachment URL on its own line is what GitHub turns into a player. A
 * clip on the assets branch cannot play there, so its last frame links to it,
 * with the one thing that would make it play.
 */
export function momentLines(result: Pick<PrRunResult, 'moments' | 'momentsSkipped' | 'momentsHint'>, local: (f?: string) => string | undefined = f => f): string[] {
  const lines: string[] = [];
  const recorded = (result.moments ?? []).filter(m => m.status === 'recorded');
  const failed = (result.moments ?? []).filter(m => m.status === 'error');
  for (const m of recorded) {
    const seconds = m.durationMs ? ` · ${(m.durationMs / 1000).toFixed(1)}s` : '';
    lines.push(`### ▶ ${m.name} — ${viewportLabel(m.viewport)}`, '', `${code(m.route)}${seconds}${m.preNote ? ` · ${m.preNote}` : ''}`, '');
    // A published poster with no published clip is a private repo, where no
    // link would play: the poster stands alone rather than point at a local file.
    const video = m.videoUrl ?? (m.posterUrl ? undefined : local(m.file));
    const poster = m.posterUrl ?? local(m.poster);
    if (m.inline && m.videoUrl) lines.push(m.videoUrl, '');
    else if (video && poster) lines.push(`[![${m.name} — open the video](${poster})](${video})`, '');
    else if (video) lines.push(`[Open the video](${video})`, '');
    else if (poster) lines.push(`![${m.name}](${poster})`, '');
    if (m.note) lines.push(`<sub>${m.note}</sub>`, '');
  }
  if (recorded.some(m => !m.inline) && result.momentsHint) lines.push(`<sub>${result.momentsHint}</sub>`, '');
  if (failed.length) {
    lines.push('**Could not record:**');
    for (const m of failed) lines.push(`- ${quote(m.name)}: ${m.error}`);
    lines.push('');
  }
  if (result.momentsSkipped?.length) {
    lines.push(`**Also listed, not recorded (over the ${MAX_MOMENTS}-Moment limit):** ${result.momentsSkipped.map(quote).join(', ')}`, '');
  }
  return lines;
}

/** A run shorter than this says how long it took in the PR description. */
const FAST_RUN_MS = 30_000;

/**
 * Markdown body for the sticky PR comment.
 */
export function buildComment(result: PrRunResult, options: CommentOptions = {}): string {
  const lines: string[] = [STICKY_MARKER, '## Visual changes', ''];
  /** Published URLs when there are any, else the local files. */
  const dir = options.filesDir;
  const local = (f?: string) => f && dir && path.isAbsolute(f) ? path.relative(dir, f).split(path.sep).join('/') : f;
  const images = (o: RouteCaptureOutcome): ArtifactSet => {
    if (o.urls) return o.urls;
    if (!dir || !o.files) return o.files ?? {};
    return Object.fromEntries(Object.entries(o.files).map(([k, f]) => [k, local(f)])) as ArtifactSet;
  };
  const clips = momentLines(result, local);
  const hasClips = (result.moments ?? []).some(m => m.status === 'recorded');
  const changed = result.outcomes.filter(o => o.status === 'changed');
  const unchanged = result.outcomes.filter(o => o.status === 'unchanged');
  const errors = result.outcomes.filter(o => o.status === 'error');
  // Only the baseline can be broken here: a broken Post is a verdict, above.
  const notCompared = result.outcomes.filter(o => o.status === 'broken');
  // A page that only one side has is still something a reviewer must see, so it
  // counts as a change for "did anything happen" — but it is shown as one
  // screenshot, never as a Pre/Post pair, because there is no pair.
  const oneSided = result.outcomes.filter(o => (o.status === 'added' || o.status === 'removed') && (o.urls || o.files));

  // Both sides can now be a deployment, so name the actual hosts rather than
  // assuming Post is the reader's own checkout.
  // Named for the reviewer. A local side is served on a throwaway port, so its
  // URL named nothing and changed on every run; the label says what it is.
  const preLabel = sideLabel(result.beforeBase, result.beforeLabel, 'a local server');
  const postLabel = sideLabel(result.afterBase, result.afterLabel, 'this branch');
  const sha = options.headSha ? ` @ ${code(options.headSha.slice(0, 7))}` : '';
  // Only a quick run earns a mention: the number is there to show the tool is
  // cheap to run, and a slow one would say the opposite.
  const took = result.durationMs > 0 && result.durationMs < FAST_RUN_MS ? ` in ${Math.max(1, Math.round(result.durationMs / 1000))}s` : '';
  // No sides means nothing was served — a run that stopped before the dev
  // servers because no page could be captured. Naming empty sides says nothing.
  if (result.beforeBase || result.afterBase) {
    lines.push(`**Pre** = ${preLabel} · **Post** = ${postLabel}${sha} · <a href="https://github.com/juangadm/pre-post">pre-post</a>${took}`, '');
  }

  // A side that renders an error page is the whole story. One sentence and
  // where it happened; no screenshots, because a picture of an error panel in a
  // Pre/Post table reads as a design, and that is how it used to ship.
  if (isBrokenVerdict(result.verdict)) {
    lines.push(`**${result.verdict.hint}**`, '');
    for (const o of result.outcomes.filter(o => o.broken)) {
      lines.push(`- ${code(o.route)} ${viewportLabel(o.viewport)}: ${describePageError(o.broken!.error)}`);
    }
    lines.push('');
    return lines.join('\n');
  }
  // "No visual changes" is a claim about what the two sides looked like, so it
  // may only be made about routes that were actually compared. A run where
  // every capture failed compared nothing, and printing it there — directly
  // above a list of six "Could not capture" lines, which is how it shipped —
  // reports a clean diff for a run that produced no diff at all.
  if (changed.length + unchanged.length + oneSided.length === 0) {
    const failed = errors.length + notCompared.length;
    lines.push(failed
      ? `**Nothing was compared** — ${failed === 1 ? 'the only capture' : `all ${failed} captures`} failed. See below.`
      : result.outcomes.length > 0
        ? '**Nothing was compared** — no route produced a screenshot.'
        : result.skippedDynamic.length
          ? '**Nothing was compared yet** — the only pages this branch affects need a sample URL. See below.'
          : '**No pages affected** — nothing this branch changed renders on a page.', '');
  } else if (changed.length === 0 && oneSided.length === 0) {
    // A clip can show a change no still frame does (a transition, a hover), so
    // with clips the claim is only about the screenshots.
    lines.push(hasClips ? 'No visual changes in the screenshots.' : 'No visual changes.', '');
  }

  lines.push(...clips);

  for (const { lead: o, others } of groupChanges(result.outcomes)) {
    const u = images(o);
    if (others.length) {
      const all = [o, ...others].map(r => code(r.route)).join(', ');
      lines.push(`### Same change on ${others.length + 1} pages — ${viewportLabel(o.viewport)}`, '', `${all}. Shown on ${code(o.route)}:`, '');
    } else {
      lines.push(`### ${code(o.route)} — ${viewportLabel(o.viewport)}`, '');
    }
    // A move repaints everything below it, so the percentage says nothing a
    // reviewer can use. Say how far it moved instead, and whether the branch
    // changed anything else.
    if (o.shift) {
      lines.push(o.shift.otherChange
        ? `Content ${describeShift(o.shift.px)}. The pair below is aligned on that move, so it shows what changed besides it.`
        : `Content ${describeShift(o.shift.px)}. Nothing else changed.`, '');
    }
    const cropped = Boolean(u.cropBefore && u.cropAfter);
    const pre = u.cropBefore ?? u.before!;
    const post = u.cropAfter ?? u.after!;
    lines.push('| Pre | Post |', '|:---:|:---:|', `| ![Pre](${pre}) | ![Post](${post}) |`, '');
    // Without a crop the pair above is already the full page; repeating it
    // under a fold gives a reviewer two more identical images to scroll past.
    if (cropped) {
      lines.push('<details>', `<summary>Full page</summary>`, '');
      lines.push('| Pre (full) | Post (full) |', '|:---:|:---:|', `| ![Pre full](${u.before}) | ![Post full](${u.after}) |`, '');
      lines.push('</details>', '');
    }
  }

  for (const o of oneSided) {
    const u = images(o);
    const image = o.status === 'added' ? u.after : u.before;
    if (!image) continue;
    const what = o.status === 'added' ? 'New page' : 'Page removed';
    const side = o.status === 'added' ? 'Post' : 'Pre';
    lines.push(`### ${code(o.route)} — ${viewportLabel(o.viewport)} · ${what}`, '');
    lines.push(o.status === 'added'
      ? `This route has no baseline — ${preLabel} returns 404 for it — so there is no "before" to show and no percentage to quote. ${side} only:`
      : `This route is gone on this branch, so there is no "after". ${side} only:`, '');
    lines.push(`![${side}](${image})`, '');
  }

  if (unchanged.length) {
    const byRoute = groupByRoute(unchanged);
    const parts = Array.from(byRoute.entries()).map(([route, os]) => `${code(route)} (${os.map(o => o.viewport).join(', ')})`);
    lines.push(`**No visual change:** ${parts.join(' · ')}`, '');
  }

  if (errors.length) {
    lines.push('**Could not capture:**');
    for (const o of errors) lines.push(`- ${code(o.route)} ${o.viewport}: ${o.error}`);
    lines.push('');
  }

  if (notCompared.length) {
    lines.push('**Not compared** (the baseline shows an error on these pages, not caused by this branch):');
    for (const o of notCompared) lines.push(`- ${code(o.route)} ${o.viewport}: ${describePageError(o.broken!.error)}`);
    lines.push('');
  }

  if (result.skippedDynamic.length) {
    lines.push(
      `**Needs a sample URL:** ${result.skippedDynamic.map(code).join(', ')} — add them under ${code('"samples"')} in ${code('.pre-post.json')}.`,
      '',
    );
  }

  // A route list that silently stops at the cap reads as "these are all the
  // pages this branch touches". Name the rest.
  if (result.omitted) {
    lines.push(`**Also affected, not captured (over the ${result.omitted.cap}-page limit):** ${result.omitted.routes.map(code).join(', ')}`, '');
  }

  return lines.join('\n');
}

/**
 * Compact terminal summary — designed to be the only thing an agent reads.
 */
export function buildSummary(result: PrRunResult): string {
  const lines: string[] = [];
  const header = [
    result.prNumber ? `PR #${result.prNumber}` : 'no PR',
    `${new Set(result.outcomes.map(o => o.route)).size} route(s)`,
    `${new Set(result.outcomes.map(o => o.viewport)).size} viewport(s)`,
    `${(result.durationMs / 1000).toFixed(1)}s`,
  ];
  lines.push(`pre-post · ${header.join(' · ')}`);

  const rows = result.outcomes.map(o => [
    o.route,
    o.viewport,
    o.status === 'error' ? 'error'
      : o.status === 'broken' ? 'broken'
      : o.status === 'changed' ? 'changed'
      : o.status === 'added' ? 'new page'
      : o.status === 'removed' ? 'removed'
      : 'no change',
    o.status === 'error' ? (o.error ?? '')
      : o.broken ? `${sideName(o.broken.side)}: ${describePageError(o.broken.error)}`
      : (o.note || ''),
  ]);
  const widths = [0, 1, 2].map(i => Math.max(...rows.map(r => r[i].length), 0));
  for (const r of rows) {
    lines.push(`  ${r[0].padEnd(widths[0])}  ${r[1].padEnd(widths[1])}  ${r[2].padEnd(widths[2])}  ${r[3]}`.trimEnd());
  }
  if (result.skippedDynamic.length) {
    lines.push(`  needs sample URL: ${result.skippedDynamic.join(', ')} (add to .pre-post.json "samples")`);
  }
  if (result.omitted) lines.push(`  ${capNotice(result.omitted.routes, result.omitted.cap)}`);
  for (const m of result.moments ?? []) {
    lines.push(m.status === 'recorded'
      ? `  ▶ ${quote(m.name)}  ${m.viewport}  ${(m.durationMs! / 1000).toFixed(1)}s${m.inline ? '  inline in PR' : ''}${m.preNote ? `  (${m.preNote})` : ''}`
      : `  ▶ ${quote(m.name)}  not recorded: ${m.error}`);
  }
  const skipped = skippedNote(result.momentsSkipped ?? []);
  if (skipped) lines.push(`  ${skipped}`);
  // Named for what actually happened. The images normally go in the PR
  // description and only fall back to a comment, so "Comment:" sent a reader
  // looking for a comment that a run with zero comments had never created.
  //
  // Only an explicit 'description' changes the label: `commentKind` is optional
  // and `buildSummary` is exported, so a caller that predates it — or a result
  // persisted before it existed — still means what it always meant.
  if (result.commentUrl) {
    lines.push(`${result.commentKind === 'description' ? 'PR description' : 'Comment'}: ${result.commentUrl}`);
  }
  return lines.join('\n');
}
