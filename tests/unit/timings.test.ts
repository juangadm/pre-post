import { describe, expect, it } from 'vitest';
import { Stopwatch, sumPreservingTenths } from '../../src/timings';

describe('Stopwatch', () => {
  it('adds repeated steps together and prints them in order', () => {
    const t = new Stopwatch();
    t.add('pre.install', 1500);
    t.add('capture', 250);
    t.add('pre.install', 500);
    expect(t.toJSON()).toEqual({ 'pre.install': 2000, capture: 250 });
    expect(t.summary()).toEqual(['capture 0.3s', '  nested: pre install 2.0s (2.0s)']);
  });

  // The flat line used to mix nested and overlapping steps, so its parts summed
  // to more than the run took. Main steps now add up to the total exactly.
  it('makes the main steps add up to the total, with lanes and background apart', () => {
    const t = new Stopwatch();
    t.add('browser', 600, { background: true });
    t.add('github', 300);
    t.add('pre.checkout', 0);
    t.add('post.boot', 2100);
    t.add('pre.reuse', 4400);
    t.add('pre.boot', 4500);
    t.add('resolve', 9200, { contains: ['pre', 'post'] });
    t.add('capture', 1900);
    expect(t.summary(12_000)).toEqual([
      'Total 12.0s = github 0.3s + resolve 9.2s + capture 1.9s + other 0.6s',
      '  inside resolve 9.2s, side by side: pre checkout 0.0s → reuse 4.4s → boot 4.5s (8.9s) ‖ post boot 2.1s (2.1s)',
      '  alongside: browser 0.6s',
    ]);
    // The JSON stays flat, so existing --json readers see the same keys.
    expect(Object.keys(t.toJSON())).toContain('pre.reuse');
  });

  it('records a step that throws', async () => {
    const t = new Stopwatch();
    await expect(t.time('boot', async () => { throw new Error('no'); })).rejects.toThrow('no');
    expect(t.toJSON()).toHaveProperty('boot');
  });

  it('rounds the parts so they still add up to the total', () => {
    const t = new Stopwatch();
    t.add('a', 349);
    t.add('b', 349);
    t.add('c', 302);
    expect(t.summary(1000)[0]).toBe('Total 1.0s = a 0.4s + b 0.3s + c 0.3s + other 0.0s');
    // 1050ms rounds to 1.1s, so the three parts must sum to 11 tenths.
    expect(sumPreservingTenths([350, 350, 350])).toEqual([4, 4, 3]);
  });
});
