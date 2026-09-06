/**
 * Output formatting: the PR comment (for humans) and the terminal summary
 * (for the developer or the agent that invoked the CLI).
 */

import { PrRunResult, RouteCaptureOutcome } from './types.js';
import { describeShift } from './run.js';
import { hostOf, isLocalUrl } from './url.js';

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

export interface CommentOptions {
  version?: string;
  headSha?: string | null;
  now?: Date;
}

/**
 * Markdown body for the sticky PR comment.
 */
export function buildComment(result: PrRunResult, options: CommentOptions = {}): string {
  const lines: string[] = [STICKY_MARKER, '## Visual changes', ''];
  const routes = groupByRoute(result.outcomes);
  const changed = result.outcomes.filter(o => o.status === 'changed');
  const unchanged = result.outcomes.filter(o => o.status === 'unchanged');
  const errors = result.outcomes.filter(o => o.status === 'error');
  // A page that only one side has is still something a reviewer must see, so it
  // counts as a change for "did anything happen" — but it is shown as one
  // screenshot, never as a Pre/Post pair, because there is no pair.
  const oneSided = result.outcomes.filter(o => (o.status === 'added' || o.status === 'removed') && (o.urls || o.files));

  // Both sides can now be a deployment, so name the actual hosts rather than
  // assuming Post is the reader's own checkout.
  const postLabel = isLocalUrl(result.afterBase) ? 'this branch (local)' : hostOf(result.afterBase);
  const sha = options.headSha ? ` @ ${code(options.headSha.slice(0, 7))}` : '';
  lines.push(`**Pre** = ${hostOf(result.beforeBase)} · **Post** = ${postLabel}${sha} · <a href="https://github.com/juangadm/pre-post">pre-post</a>`, '');
  if (changed.length === 0 && oneSided.length === 0) lines.push('No visual changes.', '');

  for (const [route, outcomes] of routes) {
    const changedHere = outcomes.filter(o => o.status === 'changed' && (o.urls || o.files));
    if (changedHere.length === 0) continue;
    for (const o of changedHere) {
      const u = o.urls ?? o.files!;
      lines.push(`### ${code(route)} — ${viewportLabel(o.viewport)}`, '');
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
  }

  for (const o of oneSided) {
    const u = o.urls ?? o.files!;
    const image = o.status === 'added' ? u.after : u.before;
    if (!image) continue;
    const what = o.status === 'added' ? 'New page' : 'Page removed';
    const side = o.status === 'added' ? 'Post' : 'Pre';
    lines.push(`### ${code(o.route)} — ${viewportLabel(o.viewport)} · ${what}`, '');
    lines.push(o.status === 'added'
      ? `This route has no baseline — ${hostOf(result.beforeBase)} returns 404 for it — so there is no "before" to show and no percentage to quote. ${side} only:`
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

  if (result.skippedDynamic.length) {
    lines.push(
      `**Needs a sample URL:** ${result.skippedDynamic.map(code).join(', ')} — add them under ${code('"samples"')} in ${code('.pre-post.json')}.`,
      '',
    );
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
      : o.status === 'changed' ? 'changed'
      : o.status === 'added' ? 'new page'
      : o.status === 'removed' ? 'removed'
      : 'no change',
    o.status === 'error' ? (o.error ?? '') : (o.note || ''),
  ]);
  const widths = [0, 1, 2].map(i => Math.max(...rows.map(r => r[i].length), 0));
  for (const r of rows) {
    lines.push(`  ${r[0].padEnd(widths[0])}  ${r[1].padEnd(widths[1])}  ${r[2].padEnd(widths[2])}  ${r[3]}`.trimEnd());
  }
  if (result.skippedDynamic.length) {
    lines.push(`  needs sample URL: ${result.skippedDynamic.join(', ')} (add to .pre-post.json "samples")`);
  }
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
