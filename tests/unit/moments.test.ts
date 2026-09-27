import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  describeStep, loadMomentsFile, longClipNote, LONG_CLIP_MS, MAX_MOMENTS, MomentError,
  parseMoment, parseMoments, selectMoments, skippedNote,
} from '../../src/moments';

const ok = { name: 'Open the account menu', route: '/settings', steps: [{ hover: 'Account' }, { click: 'Account' }] };

describe('parseMoment', () => {
  it('normalises a valid Moment, defaulting the viewport to desktop', () => {
    expect(parseMoment(ok, 'Moment 1')).toEqual({
      name: 'Open the account menu', route: '/settings', viewport: 'desktop',
      steps: [{ verb: 'hover', target: 'Account' }, { verb: 'click', target: 'Account' }],
    });
  });

  it('parses every verb', () => {
    const m = parseMoment({ ...ok, steps: [
      { type: ['Email', 'ada@example.com'] }, { press: 'Enter' }, { scroll: 'Pricing' }, { scroll: -400 }, { wait: 600 },
    ] }, 'M');
    expect(m.steps).toEqual([
      { verb: 'type', target: 'Email', text: 'ada@example.com' },
      { verb: 'press', key: 'Enter' },
      { verb: 'scroll', target: 'Pricing' },
      { verb: 'scroll', px: -400 },
      { verb: 'wait', ms: 600 },
    ]);
  });

  it('allows no steps: a load-only clip for entrance animations', () => {
    expect(parseMoment({ name: 'Hero', route: '/' }, 'M').steps).toEqual([]);
  });

  it.each([
    [{ route: '/', steps: [] }, /needs a "name"/],
    [{ name: 'x', route: 'settings' }, /route.*starting with \//],
    [{ name: 'x', route: '/', steps: [{ tap: 'Save' }] }, /step 1: a step has exactly one of/],
    [{ name: 'x', route: '/', steps: [{ click: 'A', hover: 'B' }] }, /exactly one of/],
    [{ name: 'x', route: '/', steps: [{ click: '' }] }, /"click" needs the text/],
    [{ name: 'x', route: '/', steps: [{ type: 'Email' }] }, /"type" needs \[field, text\]/],
    [{ name: 'x', route: '/', steps: [{ wait: 30 }, { wait: 30_000 }] }, /step 2: "wait" is in milliseconds/],
    [{ name: 'x', route: '/', steps: 'click Save' }, /"steps" is a list/],
  ])('rejects %j with a sentence that names the fix', (raw, message) => {
    expect(() => parseMoment(raw as never, 'Moment 1')).toThrow(MomentError);
    expect(() => parseMoment(raw as never, 'Moment 1')).toThrow(message);
  });

  it('names the Moment and step in the error, so the fix is findable', () => {
    expect(() => parseMoment({ name: 'Checkout', route: '/', steps: [{ click: 'Pay' }, { tap: 'x' }] }, 'Moment 2'))
      .toThrow('Moment 2 ("Checkout") step 2');
  });
});

describe('parseMoments', () => {
  it('accepts a bare list or { moments: [...] }', () => {
    expect(parseMoments([ok], 'f')).toHaveLength(1);
    expect(parseMoments({ moments: [ok, ok] }, 'f')).toHaveLength(2);
  });

  it('rejects anything else', () => {
    expect(() => parseMoments({ steps: [] }, 'moments.json')).toThrow(/moments.json: expected a list/);
  });
});

describe('loadMomentsFile', () => {
  it('reads and validates a file, and says when it is not JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moments-'));
    fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify({ moments: [ok] }));
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ nope');
    expect(loadMomentsFile('good.json', dir)[0].name).toBe('Open the account menu');
    expect(() => loadMomentsFile('bad.json', dir)).toThrow(/bad.json is not valid JSON/);
    expect(() => loadMomentsFile('missing.json', dir)).toThrow(/Cannot read the Moments file missing.json/);
  });
});

describe('selectMoments', () => {
  const many = Array.from({ length: 5 }, (_, i) => parseMoment({ ...ok, name: `M${i + 1}` }, 'M'));

  it(`records the first ${MAX_MOMENTS}, in the order given, and names the rest`, () => {
    const { run, skipped } = selectMoments(many);
    expect(run.map(m => m.name)).toEqual(['M1', 'M2', 'M3']);
    expect(skipped).toEqual(['M4', 'M5']);
    expect(skippedNote(skipped)).toBe('Recorded the first 3 Moments; also listed, not recorded: “M4”, “M5”.');
  });

  it('says nothing when everything fits', () => {
    expect(skippedNote(selectMoments(many.slice(0, 2)).skipped)).toBeNull();
  });
});

describe('longClipNote', () => {
  it('stays silent at and under the threshold, and nudges above it', () => {
    expect(longClipNote('Menu', 8_000)).toBeNull();
    expect(longClipNote('Menu', LONG_CLIP_MS)).toBeNull();
    expect(longClipNote('Checkout flow', 48_000)).toBe('“Checkout flow” is 48s — clips under 15s get watched; consider splitting it into smaller Moments.');
  });
});

describe('describeStep', () => {
  it('says each step the way a reviewer would', () => {
    expect(describeStep({ verb: 'click', target: 'Save' })).toBe('Click “Save”');
    expect(describeStep({ verb: 'type', target: 'Email', text: 'a@b.c' })).toBe('Type “a@b.c” into “Email”');
    expect(describeStep({ verb: 'scroll', px: -300 })).toBe('Scroll up 300px');
    expect(describeStep({ verb: 'press', key: 'Escape' })).toBe('Press Escape');
  });
});
