/**
 * Output formatting: the PR comment (for humans) and the terminal summary
 * (for the developer or the agent that invoked the CLI).
 */

import { PrRunResult, RouteCaptureOutcome } from './types.js';
import { hostOf } from './run.js';

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

  // Both sides can now be a deployment, so name the actual hosts rather than
  // assuming Post is the reader's own checkout.
  const postLabel = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(result.afterBase)
    ? 'this branch (local)'
    : hostOf(result.afterBase);
  const sha = options.headSha ? ` @ ${code(options.headSha.slice(0, 7))}` : '';
  lines.push(`**Pre** = ${hostOf(result.beforeBase)} · **Post** = ${postLabel}${sha} · <a href="https://github.com/juangadm/pre-post">pre-post</a>`, '');
  if (changed.length === 0) lines.push('No visual changes.', '');

  for (const [route, outcomes] of routes) {
    const changedHere = outcomes.filter(o => o.status === 'changed' && (o.urls || o.files));
    if (changedHere.length === 0) continue;
    for (const o of changedHere) {
      const u = o.urls ?? o.files!;
      lines.push(`### ${code(route)} — ${viewportLabel(o.viewport)}`, '');
      const pre = u.cropBefore ?? u.before;
      const post = u.cropAfter ?? u.after;
      lines.push('| Pre | Post |', '|:---:|:---:|', `| ![Pre](${pre}) | ![Post](${post}) |`, '');
      lines.push('<details>', `<summary>Full page and diff</summary>`, '');
      const diffCol = u.diff ? ` ![Diff](${u.diff}) |` : '';
      lines.push(`| Pre (full) | Post (full) |${u.diff ? ' Diff |' : ''}`, `|:---:|:---:|${u.diff ? ':---:|' : ''}`, `| ![Pre full](${u.before}) | ![Post full](${u.after}) |${diffCol}`, '');
      lines.push('</details>', '');
    }
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
    o.status === 'error' ? 'error' : o.status === 'changed' ? 'changed' : 'no change',
    o.status === 'error' ? (o.error ?? '') : (o.note || ''),
  ]);
  const widths = [0, 1, 2].map(i => Math.max(...rows.map(r => r[i].length), 0));
  for (const r of rows) {
    lines.push(`  ${r[0].padEnd(widths[0])}  ${r[1].padEnd(widths[1])}  ${r[2].padEnd(widths[2])}  ${r[3]}`.trimEnd());
  }
  if (result.skippedDynamic.length) {
    lines.push(`  needs sample URL: ${result.skippedDynamic.join(', ')} (add to .pre-post.json "samples")`);
  }
  if (result.commentUrl) lines.push(`Comment: ${result.commentUrl}`);
  return lines.join('\n');
}
