import { describe, expect, it } from 'vitest';
import { Stopwatch } from '../../src/timings';

describe('Stopwatch', () => {
  it('adds repeated steps together and prints them in order', () => {
    const t = new Stopwatch();
    t.add('pre.install', 1500);
    t.add('capture', 250);
    t.add('pre.install', 500);
    expect(t.toJSON()).toEqual({ 'pre.install': 2000, capture: 250 });
    expect(t.summary()).toBe('pre.install 2.0s · capture 0.3s');
  });

  it('records a step that throws', async () => {
    const t = new Stopwatch();
    await expect(t.time('boot', async () => { throw new Error('no'); })).rejects.toThrow('no');
    expect(t.toJSON()).toHaveProperty('boot');
  });
});
