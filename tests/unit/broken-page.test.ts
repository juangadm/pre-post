import { describe, it, expect, afterEach, vi } from 'vitest';
import { brokenSide, pageFailure, verdictFor, warmUp } from '../../src/run';
import { pageErrorFrom } from '../../src/browser';
import { buildComment, buildSummary } from '../../src/report';
import { CaptureResult, PrRunResult, RouteCaptureOutcome } from '../../src/types';

const capture = (c: Partial<CaptureResult>): CaptureResult =>
  ({ image: Buffer.alloc(0), viewport: { width: 1280, height: 800 }, url: 'http://localhost:3000/', durationMs: 1, status: 200, ...c });

const buildError = { kind: 'Build Error', message: 'Parsing ecmascript source code failed', location: 'app/work/page.tsx (8:5)' };

const sides = {
  before: { url: 'http://localhost:61497', detail: 'base commit 38d9f0b, served locally' },
  after: { url: 'http://localhost:61460' },
};

const outcome = (o: Partial<RouteCaptureOutcome>): RouteCaptureOutcome =>
  ({ route: '/', resolvedRoute: '/', viewport: 'desktop', status: 'changed', ...o });

describe('pageFailure', () => {
  it('is null for a healthy render', () => {
    expect(pageFailure(capture({ status: 200 }))).toBe(null);
    // A 404 is a statement about the route, handled as added/removed, not a failure.
    expect(pageFailure(capture({ status: 404 }))).toBe(null);
  });

  it('treats any 5xx as a failure', () => {
    expect(pageFailure(capture({ status: 500 }))).toEqual({ kind: 'HTTP 500' });
    expect(pageFailure(capture({ status: 503 }))?.kind).toBe('HTTP 503');
  });

  // Next 16 pushes a build error to every open page: /about answers 200 with
  // the dialog over it. Status alone would call that page healthy.
  it('treats an error overlay on a 200 as a failure, and prefers its wording', () => {
    expect(pageFailure(capture({ status: 200, pageError: buildError }))).toEqual(buildError);
    expect(pageFailure(capture({ status: 500, pageError: buildError }))).toEqual(buildError);
  });
});

describe('brokenSide', () => {
  it('names the side that failed, preferring Post when both did', () => {
    expect(brokenSide(capture({}), capture({}))).toBe(null);
    expect(brokenSide(capture({}), capture({ status: 500 }))?.side).toBe('after');
    expect(brokenSide(capture({ status: 500 }), capture({}))?.side).toBe('before');
    const both = brokenSide(capture({ status: 500 }), capture({ pageError: buildError }));
    expect(both?.side).toBe('both');
    expect(both?.error).toEqual(buildError);
  });
});

describe('pageErrorFrom', () => {
  it('pulls the source location out of the overlay text', () => {
    // Overlay text as Next 16.0.7 renders it, measured on the lab's broken-build branch.
    const raw = {
      kind: 'Build Error',
      message: 'Parsing ecmascript source code failed',
      text: '1/1\nNext.js 16.0.7 (stale)\nTurbopack\nBuild Error\nParsing ecmascript source code failed\n./app/work/page.tsx (8:5)\nParsing ecmascript source code failed\n   6 |     <PageShell>',
    };
    expect(pageErrorFrom(raw)).toEqual(buildError);
  });

  it('keeps a runtime error location with its @ frame', () => {
    const raw = { kind: 'Runtime Error', message: 'client boom', text: 'Runtime Error\nclient boom\ncomponents/sections/Boom.tsx (3:50) @ Boom.useEffect\n  1 | "use client"' };
    expect(pageErrorFrom(raw)?.location).toBe('components/sections/Boom.tsx (3:50)');
  });

  it('is undefined when there is no overlay', () => {
    expect(pageErrorFrom(null)).toBeUndefined();
  });
});

describe('verdictFor, broken pages', () => {
  const brokenPost = outcome({ route: '/work', status: 'broken', broken: { side: 'after', status: 500, error: buildError } });
  const brokenPre = (route: string) => outcome({ route, status: 'broken', broken: { side: 'before', status: 500, error: buildError } });

  it('stops the run when any Post page is broken', () => {
    const verdict = verdictFor([brokenPost, outcome({ route: '/', textOverlap: 0.9, titleOverlap: 1 })], sides);
    expect(verdict?.kind).toBe('post-broken');
    expect(verdict?.hint).toContain('`/work`');
    expect(verdict?.hint).toContain('Build Error: Parsing ecmascript source code failed in app/work/page.tsx (8:5)');
  });

  // An error page shares no words with the real one. Checked first, so a
  // broken branch is not misdiagnosed as a baseline on the wrong site.
  it('wins over the different-sites check', () => {
    expect(verdictFor([brokenPost], sides)?.kind).toBe('post-broken');
  });

  it('blames the baseline only when no route has a "before"', () => {
    expect(verdictFor([brokenPre('/a'), brokenPre('/b')], sides)?.kind).toBe('baseline-broken');
    expect(verdictFor([brokenPre('/a'), brokenPre('/b')], sides)?.hint).toContain('not caused by this branch');
    // One broken baseline page among compared ones is reported per route.
    expect(verdictFor([brokenPre('/a'), outcome({ route: '/b', textOverlap: 0.9, titleOverlap: 1 })], sides)).toBe(null);
  });
});

describe('reporting a broken branch', () => {
  const result: PrRunResult = {
    repo: 'acme/web', prNumber: 15, beforeBase: 'http://localhost:61497', afterBase: 'http://localhost:61460',
    skippedDynamic: [], durationMs: 40_000, markdown: '', outputDir: '/tmp/x',
    outcomes: [outcome({
      route: '/work', status: 'broken', broken: { side: 'after', status: 500, error: buildError },
      files: { before: '/tmp/x/work-desktop-before.png', after: '/tmp/x/work-desktop-after.png' },
    })],
    verdict: { kind: 'post-broken', hint: "This branch doesn't render: `/work` shows Build Error." },
  };

  it('says so in one sentence and shows no images', () => {
    const md = buildComment(result, { filesDir: '/tmp/x' });
    expect(md).toContain("**This branch doesn't render: `/work` shows Build Error.**");
    expect(md).toContain('- `/work` Desktop: Build Error: Parsing ecmascript source code failed in app/work/page.tsx (8:5)');
    expect(md).not.toContain('![');
    expect(md).not.toContain('| Pre | Post |');
  });

  it('labels the route broken in the terminal, naming the side', () => {
    expect(buildSummary(result)).toMatch(/\/work\s+desktop\s+broken\s+Post: Build Error/);
  });

  it('lists baseline-only failures as not compared, beside the real results', () => {
    const md = buildComment({
      ...result,
      verdict: undefined,
      outcomes: [
        outcome({ route: '/old', status: 'broken', broken: { side: 'before', status: 500, error: { kind: 'HTTP 500' } } }),
        outcome({ route: '/', status: 'unchanged' }),
      ],
    });
    expect(md).toContain('**Not compared**');
    expect(md).toContain('- `/old` desktop: HTTP 500');
    expect(md).toContain('**No visual change:** `/`');
  });
});

describe('warmUp', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('retries a local 5xx and stops at the first healthy answer', async () => {
    const statuses = [500, 500, 200];
    const fetch = vi.fn(async () => new Response('', { status: statuses.shift() }));
    vi.stubGlobal('fetch', fetch);
    await warmUp(['http://localhost:3000/work'], {}, { pauseMs: 1 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('gives up after the last attempt without throwing', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 500 }));
    vi.stubGlobal('fetch', fetch);
    await warmUp(['http://localhost:3000/work'], {}, { attempts: 2, pauseMs: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('leaves deployments and duplicates alone', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await warmUp(['https://acme.com/', 'http://localhost:3000/', 'http://localhost:3000/'], {}, { pauseMs: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
