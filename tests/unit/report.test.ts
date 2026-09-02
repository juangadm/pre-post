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

describe('buildComment', () => {
  const md = buildComment(base, { version: '1.0.0', headSha: 'abcdef1234567890', now: new Date('2026-01-15T12:00:00Z') });

  it('starts with the sticky marker', () => {
    expect(md.startsWith(STICKY_MARKER)).toBe(true);
  });

  it('leads with the cropped pair and tucks the full page into details', () => {
    expect(md).toContain('### `/` — Desktop · 4.2% of pixels changed');
    expect(md).toContain('| ![Pre](https://u/pre-crop.png) | ![Post](https://u/post-crop.png) |');
    expect(md).toContain('<details>');
    expect(md).toContain('![Diff](https://u/diff.png)');
  });

  it('collapses unchanged captures into one line', () => {
    expect(md).toContain('**No visual change:** `/` (mobile) · `/pricing` (desktop)');
  });

  it('lists errors and dynamic routes needing samples', () => {
    expect(md).toContain('- `/pricing` mobile: timed out loading http://localhost:3000/pricing');
    expect(md).toContain('**Needs a sample URL:** `/blog/[slug]`');
  });

  it('includes version, sha, and timing in the footer', () => {
    expect(md).toContain('v1.0.0');
    expect(md).toContain('`abcdef1`');
    expect(md).toContain('12.3s');
  });

  it('says so when nothing changed', () => {
    const none = buildComment({ ...base, outcomes: base.outcomes.filter(o => o.status === 'unchanged') });
    expect(none).toContain('No visual changes detected');
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
    const summary = buildSummary({ ...base, commentUrl: 'https://github.com/acme/web/pull/42#issuecomment-1' });
    const lines = summary.split('\n');
    expect(lines[0]).toBe('pre-post · PR #42 · 2 route(s) · 2 viewport(s) · 12.3s');
    expect(summary).toContain('4.2% changed');
    expect(summary).toContain('no change');
    expect(summary).toContain('error');
    expect(summary).toContain('needs sample URL: /blog/[slug]');
    expect(lines[lines.length - 1]).toBe('Comment: https://github.com/acme/web/pull/42#issuecomment-1');
  });
});
