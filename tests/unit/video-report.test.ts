import { describe, it, expect } from 'vitest';
import { atLeast, attachmentUrls, MIN_GH_FOR_ATTACH, parseGhVersion } from '../../src/attach';
import { captionFor, layoutFor, pointersFor } from '../../src/compose';
import { buildComment, buildSummary, momentLines } from '../../src/report';
import { MomentOutcome, PrRunResult } from '../../src/types';
import { Step } from '../../src/moments';

describe('gh version gate', () => {
  it('reads gh --version and requires 2.99 for --attach', () => {
    expect(parseGhVersion('gh version 2.83.1 (2025-11-13)\nhttps://github.com/cli/cli/releases/tag/v2.83.1')).toEqual([2, 83, 1]);
    expect(atLeast([2, 83, 1], MIN_GH_FOR_ATTACH)).toBe(false);
    expect(atLeast([2, 99, 0], MIN_GH_FOR_ATTACH)).toBe(true);
    expect(atLeast([2, 101, 0], MIN_GH_FOR_ATTACH)).toBe(true);
    expect(atLeast([3, 0, 0], MIN_GH_FOR_ATTACH)).toBe(true);
    expect(parseGhVersion('not gh')).toBeNull();
  });

  it('reads attachment URLs back in the order they were posted', () => {
    const body = 'x\n\nhttps://github.com/user-attachments/assets/aaa-111\n\nhttps://github.com/user-attachments/assets/bbb-222\n';
    expect(attachmentUrls(body)).toEqual([
      'https://github.com/user-attachments/assets/aaa-111',
      'https://github.com/user-attachments/assets/bbb-222',
    ]);
  });
});

describe('layoutFor', () => {
  it('scales a desktop page to an 800px pane and keeps a phone at its own width', () => {
    expect(layoutFor({ width: 1280, height: 800 })).toMatchObject({ paneWidth: 800, paneHeight: 500, scale: 0.625 });
    expect(layoutFor({ width: 375, height: 812 })).toMatchObject({ paneWidth: 375, scale: 1 });
  });

  it('is even on both axes, which VP8 needs', () => {
    for (const vp of [{ width: 1280, height: 800 }, { width: 375, height: 812 }, { width: 1441, height: 901 }]) {
      const l = layoutFor(vp);
      expect(l.width % 2).toBe(0);
      expect(l.height % 2).toBe(0);
    }
  });
});

describe('captions and pointers', () => {
  const steps: Step[] = [{ verb: 'click', target: 'Account' }, { verb: 'wait', ms: 500 }, { verb: 'hover', target: 'Theme' }];
  const tick = (step: number, sinceStep = 0) => ({ a: 0, b: 0, aMissing: false, bMissing: false, step, sinceStep });

  it('names the step in progress, and keeps naming it through a wait', () => {
    expect(captionFor(tick(-1), steps)).toBe('');
    expect(captionFor(tick(0), steps)).toBe('1/3 · Click “Account”');
    expect(captionFor(tick(1), steps)).toBe('1/3 · Click “Account”');
    expect(captionFor(tick(2), steps)).toBe('3/3 · Hover “Theme”');
  });

  it('draws a click marker that fades, a hover marker that stays, and none on a missing side', () => {
    const pre = [{ step: 0, x: 10, y: 20 }, { step: 2, x: 5, y: 5 }];
    const post = [{ step: 0, x: 30, y: 40 }];
    expect(pointersFor(tick(0, 0), steps, pre, post)).toEqual([
      { side: 'a', x: 10, y: 20, kind: 'click', p: 0 },
      { side: 'b', x: 30, y: 40, kind: 'click', p: 0 },
    ]);
    expect(pointersFor(tick(0, 10_000), steps, pre, post)).toEqual([]);
    expect(pointersFor(tick(2, 10_000), steps, pre, post)).toEqual([{ side: 'a', x: 5, y: 5, kind: 'hover', p: 0 }]);
    expect(pointersFor({ ...tick(0, 0), aMissing: true }, steps, pre, post).map(p => p.side)).toEqual(['b']);
  });
});

const clip = (over: Partial<MomentOutcome> = {}): MomentOutcome => ({
  name: 'Open the account menu', route: '/settings', viewport: 'desktop', status: 'recorded',
  durationMs: 3400, bytes: 120_000, file: '/tmp/run/moment-open-desktop.webm', poster: '/tmp/run/moment-open-desktop.jpg', ...over,
});

describe('momentLines', () => {
  it('puts an inline attachment URL on its own line, which GitHub turns into a player', () => {
    const lines = momentLines({ moments: [clip({ videoUrl: 'https://github.com/user-attachments/assets/abc', inline: true })] });
    expect(lines).toContain('### ▶ Open the account menu — Desktop');
    expect(lines).toContain('`/settings` · 3.4s');
    expect(lines).toContain('https://github.com/user-attachments/assets/abc');
  });

  it('links the poster to the clip when it cannot play inline, and says what would fix it', () => {
    const lines = momentLines({
      moments: [clip({ videoUrl: 'https://github.com/a/b/blob/s/v.webm?raw=true', posterUrl: 'https://github.com/a/b/blob/s/v.jpg?raw=true' })],
      momentsHint: 'Update GitHub CLI to 2.99 or newer.',
    });
    expect(lines).toContain('[![Open the account menu — open the video](https://github.com/a/b/blob/s/v.jpg?raw=true)](https://github.com/a/b/blob/s/v.webm?raw=true)');
    expect(lines).toContain('<sub>Update GitHub CLI to 2.99 or newer.</sub>');
  });

  it('lists what could not be recorded, the Pre note, the long-clip nudge and the Moments over the limit', () => {
    const lines = momentLines({
      moments: [
        clip({ preNote: 'Couldn’t find “Theme” on Pre, so it is shown as new.', note: '“x” is 48s — consider splitting it.', inline: true, videoUrl: 'https://github.com/user-attachments/assets/a' }),
        { name: 'Checkout', route: '/cart', viewport: 'desktop', status: 'error', error: 'Couldn\'t find “Pay” on Post (step 2).' },
      ],
      momentsSkipped: ['Footer links'],
    }).join('\n');
    expect(lines).toContain('Couldn’t find “Theme” on Pre, so it is shown as new.');
    expect(lines).toContain('<sub>“x” is 48s — consider splitting it.</sub>');
    expect(lines).toContain('**Could not record:**\n- “Checkout”: Couldn\'t find “Pay” on Post (step 2).');
    expect(lines).toContain('**Also listed, not recorded (over the 3-Moment limit):** “Footer links”');
  });
});

describe('buildComment with Moments', () => {
  const result: PrRunResult = {
    repo: 'acme/web', prNumber: 1, beforeBase: 'https://acme.com', afterBase: 'http://localhost:3000',
    skippedDynamic: [], durationMs: 60_000, markdown: '', outputDir: '/tmp/run',
    outcomes: [{ route: '/settings', resolvedRoute: '/settings', viewport: 'desktop', status: 'unchanged', changedRatio: 0 }],
    moments: [clip()],
  };

  it('limits "no visual changes" to the screenshots when a clip may show a change', () => {
    const md = buildComment(result, { filesDir: '/tmp/run' });
    expect(md).toContain('No visual changes in the screenshots.');
    expect(md).not.toContain('\nNo visual changes.\n');
  });

  it('links local files relative to the run folder in a dry run', () => {
    const md = buildComment(result, { filesDir: '/tmp/run' });
    expect(md).toContain('[![Open the account menu — open the video](moment-open-desktop.jpg)](moment-open-desktop.webm)');
  });

  it('shows the clip before the screenshots', () => {
    const md = buildComment({ ...result, moments: [clip({ inline: true, videoUrl: 'https://github.com/user-attachments/assets/v' })] });
    expect(md.indexOf('▶ Open the account menu')).toBeLessThan(md.indexOf('**No visual change:**'));
  });

  it('adds one summary line per Moment', () => {
    expect(buildSummary({ ...result, moments: [clip({ inline: true })] })).toContain('▶ “Open the account menu”  desktop  3.4s  inline in PR');
  });
});
