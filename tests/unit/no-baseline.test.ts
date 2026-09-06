import { describe, it, expect } from 'vitest';
import { buildComment, buildSummary } from '../../src/report';
import { PrRunResult, RouteCaptureOutcome } from '../../src/types';

const run = (outcomes: RouteCaptureOutcome[]): PrRunResult => ({
  repo: 'acme/web',
  prNumber: 7,
  beforeBase: 'https://acme.com',
  afterBase: 'https://preview.vercel.app',
  skippedDynamic: [],
  durationMs: 1000,
  markdown: '',
  outputDir: '/tmp/x',
  outcomes,
});

const added: RouteCaptureOutcome = {
  route: '/new', resolvedRoute: '/new', viewport: 'desktop', status: 'added',
  note: 'new page — no baseline (acme.com returned 404)',
  urls: { after: 'https://u/post.png' },
};

describe('a route with no baseline', () => {
  const md = buildComment(run([added]));

  it('is shown as one screenshot, not a Pre/Post pair', () => {
    expect(md).toContain('New page');
    expect(md).toContain('![Post](https://u/post.png)');
    expect(md).not.toContain('| Pre | Post |');
  });

  it('quotes no percentage, because there is nothing to take a ratio of', () => {
    expect(md).not.toMatch(/\d+\.\d+%/);
  });

  it('says why there is no before', () => {
    expect(md).toContain('no baseline');
    expect(md).toContain('acme.com');
  });

  it('does not claim there were no visual changes', () => {
    expect(md).not.toContain('No visual changes.');
  });

  it('is labelled in the terminal summary', () => {
    expect(buildSummary(run([added]))).toContain('new page');
  });
});

describe('a route the branch removed', () => {
  const removed: RouteCaptureOutcome = {
    route: '/gone', resolvedRoute: '/gone', viewport: 'desktop', status: 'removed',
    urls: { before: 'https://u/pre.png' },
  };
  const md = buildComment(run([removed]));

  it('shows the page that is going away', () => {
    expect(md).toContain('Page removed');
    expect(md).toContain('![Pre](https://u/pre.png)');
    expect(md).not.toContain('| Pre | Post |');
  });
});
