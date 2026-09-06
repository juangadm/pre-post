import { describe, it, expect } from 'vitest';
import { buildComment, buildSummary, STICKY_MARKER } from '../../src/report';
import { PrRunResult } from '../../src/types';

const base: PrRunResult = {
  repo: 'acme/web',
  prNumber: 42,
  beforeBase: 'https://acme.com',
  afterBase: 'http://localhost:3000',
  skippedDynamic: ['/blog/[slug]'],
  durationMs: 12_345,
  markdown: '',
  outputDir: '/tmp/x',
  outcomes: [
    {
      route: '/', resolvedRoute: '/', viewport: 'desktop', status: 'changed', changedRatio: 0.0423,
      urls: { before: 'https://u/pre.png', after: 'https://u/post.png', diff: 'https://u/diff.png', cropBefore: 'https://u/pre-crop.png', cropAfter: 'https://u/post-crop.png' },
    },
    { route: '/', resolvedRoute: '/', viewport: 'mobile', status: 'unchanged', changedRatio: 0 },
    { route: '/pricing', resolvedRoute: '/pricing', viewport: 'desktop', status: 'unchanged', changedRatio: 0 },
    { route: '/pricing', resolvedRoute: '/pricing', viewport: 'mobile', status: 'error', error: 'timed out loading http://localhost:3000/pricing' },
  ],
};

/** A route whose Post moved, with and without a change on top of the move. */
function shifted(shift: { px: number; otherChange: boolean }, cropped: boolean): PrRunResult {
  return {
    ...base,
    outcomes: [{
      route: '/', resolvedRoute: '/', viewport: 'desktop', status: 'changed', changedRatio: 0.62, shift,
      urls: cropped
        ? { before: 'https://u/pre.png', after: 'https://u/post.png', cropBefore: 'https://u/pre-crop.png', cropAfter: 'https://u/post-crop.png' }
        : { before: 'https://u/pre.png', after: 'https://u/post.png' },
    }],
  };
}

describe('buildComment', () => {
  const md = buildComment(base, { version: '1.0.0', headSha: 'abcdef1234567890', now: new Date('2026-01-15T12:00:00Z') });

  it('starts with the sticky marker', () => {
    expect(md.startsWith(STICKY_MARKER)).toBe(true);
  });

  it('leads with the cropped pair and tucks the full page into details', () => {
    expect(md).toContain('### `/` — Desktop');
    expect(md).toContain('| ![Pre](https://u/pre-crop.png) | ![Post](https://u/post-crop.png) |');
    expect(md).toContain('<details>');
    // Pre beside Post is the comparison; the overlay is not shown.
    expect(md).not.toContain('diff.png');
  });

  it('collapses unchanged captures into one line', () => {
    expect(md).toContain('**No visual change:** `/` (mobile) · `/pricing` (desktop)');
  });

  it('lists errors and dynamic routes needing samples', () => {
    expect(md).toContain('- `/pricing` mobile: timed out loading http://localhost:3000/pricing');
    expect(md).toContain('**Needs a sample URL:** `/blog/[slug]`');
  });

  it('states how it was captured on one line, with no footer', () => {
    const header = md.split('\n').find(l => l.startsWith('**Pre**'))!;
    expect(header).toContain('`abcdef1`');
    expect(header).toContain('pre-post');
    // No timing, version banner, or trailing rule to scroll past.
    expect(md).not.toContain('12.3s');
    expect(md).not.toContain('<sub>');
  });

  it('says so when nothing changed', () => {
    const none = buildComment({ ...base, outcomes: base.outcomes.filter(o => o.status === 'unchanged') });
    expect(none).toContain('No visual changes.');
  });

  it('falls back to local files when nothing was published', () => {
    const local = buildComment({
      ...base,
      outcomes: [{ route: '/', resolvedRoute: '/', viewport: 'desktop', status: 'changed', changedRatio: 0.5, files: { before: '/tmp/pre.png', after: '/tmp/post.png', diff: '/tmp/diff.png' } }],
    });
    expect(local).toContain('![Pre](/tmp/pre.png)');
  });
});

describe('buildSummary', () => {
  it('is a compact table with one line per capture', () => {
    const summary = buildSummary({ ...base, commentUrl: 'https://github.com/acme/web/pull/42#issuecomment-1', commentKind: 'comment' });
    const lines = summary.split('\n');
    expect(lines[0]).toBe('pre-post · PR #42 · 2 route(s) · 2 viewport(s) · 12.3s');
    expect(summary).toContain('changed');
    expect(summary).toContain('no change');
    expect(summary).toContain('error');
    expect(summary).toContain('needs sample URL: /blog/[slug]');
    expect(lines[lines.length - 1]).toBe('Comment: https://github.com/acme/web/pull/42#issuecomment-1');
  });

  // The usual path edits the description; calling that a comment sent a reader
  // hunting for one on a PR that had none.
  it('names the description when that is what was updated', () => {
    const summary = buildSummary({ ...base, commentUrl: 'https://github.com/acme/web/pull/42', commentKind: 'description' });
    expect(summary.split('\n').pop()).toBe('PR description: https://github.com/acme/web/pull/42');
  });
});

describe('buildComment with a layout shift', () => {
  it('says how far the content moved instead of leaving a percentage to read', () => {
    const md = buildComment(shifted({ px: 48, otherChange: false }, false));
    expect(md).toContain('Content shifted down 48px. Nothing else changed.');
  });

  it('names the direction when content moved up', () => {
    const md = buildComment(shifted({ px: -32, otherChange: false }, false));
    expect(md).toContain('Content shifted up 32px.');
  });

  it('says the pair is aligned when something changed besides the move', () => {
    const md = buildComment(shifted({ px: 48, otherChange: true }, true));
    expect(md).toContain('The pair below is aligned on that move');
    expect(md).toContain('| ![Pre](https://u/pre-crop.png) | ![Post](https://u/post-crop.png) |');
  });

  it('does not repeat the full page under a fold when there is no crop', () => {
    const md = buildComment(shifted({ px: 48, otherChange: false }, false));
    expect(md).toContain('| ![Pre](https://u/pre.png) | ![Post](https://u/post.png) |');
    expect(md).not.toContain('<details>');
  });
});
