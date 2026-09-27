import { describe, it, expect } from 'vitest';
import { alignTimeline, frameAt, timelineDuration } from '../../src/timeline';

const FPS = 10; // 100ms ticks keep the arithmetic readable

describe('alignTimeline', () => {
  it('plays two identical recordings tick for tick', () => {
    const side = { start: 0, end: 1000, marks: [500] };
    const ticks = alignTimeline(side, side, FPS);
    expect(ticks.every(t => t.a === t.b)).toBe(true);
    expect(timelineDuration(ticks, FPS)).toBe(1000);
  });

  it('lands each step at the same output instant however long each side took to reach it', () => {
    // Pre reaches its click at 200ms, Post at 600ms (a slower page).
    const pre = { start: 0, end: 700, marks: [200] };
    const post = { start: 5000, end: 5900, marks: [5600] };
    const ticks = alignTimeline(pre, post, FPS);
    const clickTick = ticks.findIndex(t => t.step === 0);
    // Both sides begin the step on the same tick...
    expect(ticks[clickTick].a).toBe(200);
    expect(ticks[clickTick].b).toBe(5600);
    // ...and before it, the faster side holds on its last frame of that segment.
    expect(ticks[clickTick - 1].a).toBe(200);
    expect(ticks[clickTick - 1].b).toBeLessThan(5600);
    // Output length is the slower side's segments added up: 600 + 500.
    expect(timelineDuration(ticks, FPS)).toBe(1100);
  });

  it('counts time since the step began, for the click marker', () => {
    const side = { start: 0, end: 1000, marks: [300] };
    const ticks = alignTimeline(side, side, FPS);
    const inStep = ticks.filter(t => t.step === 0 && t.sinceStep !== Number.MAX_SAFE_INTEGER);
    expect(inStep[0].sinceStep).toBe(0);
    expect(inStep[1].sinceStep).toBe(100);
    expect(ticks.filter(t => t.step === -1).every(t => t.sinceStep === -1)).toBe(true);
  });

  it('marks a side that ran out of steps as missing, held on its last frame', () => {
    // Pre could not do the second step: it ends when that step began.
    const pre = { start: 0, end: 800, marks: [400] };
    const post = { start: 0, end: 1500, marks: [400, 800] };
    const ticks = alignTimeline(pre, post, FPS);
    const missing = ticks.filter(t => t.aMissing);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.every(t => t.a === 800 && t.step === 1)).toBe(true);
    expect(ticks.some(t => t.bMissing)).toBe(false);
    expect(ticks.at(-1)).toMatchObject({ a: 800, b: 1500, aMissing: true });
  });

  it('keeps ticks evenly spaced across segments that are not a whole number of frames', () => {
    const side = { start: 0, end: 1000, marks: [150, 420] };
    const ticks = alignTimeline(side, side, FPS);
    const times = ticks.slice(0, -1).map(t => t.a);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeCloseTo(100, 6);
  });

  it('never goes negative when a mark lands a hair after the end', () => {
    const ticks = alignTimeline({ start: 0, end: 500, marks: [510] }, { start: 0, end: 500, marks: [510] }, FPS);
    expect(ticks.every(t => t.a >= 0 && t.a <= 500)).toBe(true);
  });
});

describe('frameAt', () => {
  const times = [0, 100, 250, 900];

  it('is the frame still on screen: the last one at or before t', () => {
    expect(frameAt(times, 0)).toBe(0);
    expect(frameAt(times, 99)).toBe(0);
    expect(frameAt(times, 100)).toBe(1);
    expect(frameAt(times, 899)).toBe(2);
    expect(frameAt(times, 5000)).toBe(3);
  });

  it('uses the first frame before any arrived, and -1 when there are none', () => {
    expect(frameAt(times, -50)).toBe(0);
    expect(frameAt([], 10)).toBe(-1);
  });
});
