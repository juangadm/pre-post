/**
 * Line two recordings up so every step lands at the same instant on both.
 *
 * Pre and Post never run at the same speed: one host is slower, one button
 * animates longer, a click waits for an element to settle. Played from the
 * same start, the two panes drift apart and a reviewer compares load speed
 * instead of the change. So each recording is cut at its step marks and every
 * segment plays for as long as the slower side needs, with the faster side
 * held on its last frame of that segment.
 *
 * Pure: times in, times out. The frames themselves are looked up afterwards.
 */

export interface SideTiming {
  /** When the recording started (ms, same clock as the frames). */
  start: number;
  /**
   * When it stopped. For a side whose step failed, the moment that step began:
   * the time it spent failing is not something to show.
   */
  end: number;
  /** When each step began, in order — only the steps this side got to. */
  marks: number[];
}

export interface Tick {
  /** Source time to show on each side. */
  a: number;
  b: number;
  /** Whether this side has run out of steps (its step failed): show the "missing" card. */
  aMissing: boolean;
  bMissing: boolean;
  /** Index of the step in progress, -1 before the first. */
  step: number;
  /** Milliseconds since that step began, in output time; -1 before the first. */
  sinceStep: number;
}

function boundaries(side: SideTiming): number[] {
  // Clamp so a mark recorded a hair after `end` (clock jitter) can never
  // produce a negative segment.
  const marks = side.marks.map(m => Math.min(Math.max(m, side.start), side.end));
  return [side.start, ...marks, side.end];
}

/** Output ticks at `fps`, step-aligned across the two sides. */
export function alignTimeline(a: SideTiming, b: SideTiming, fps: number): Tick[] {
  const frameMs = 1000 / fps;
  const ba = boundaries(a);
  const bb = boundaries(b);
  const segments = Math.max(ba.length, bb.length) - 1;
  const ticks: Tick[] = [];
  // Carried across segments so ticks stay evenly spaced in output time.
  let carry = 0;
  for (let k = 0; k < segments; k++) {
    const hasA = k < ba.length - 1;
    const hasB = k < bb.length - 1;
    const lenA = hasA ? ba[k + 1] - ba[k] : 0;
    const lenB = hasB ? bb[k + 1] - bb[k] : 0;
    const len = Math.max(lenA, lenB);
    let u = carry;
    for (; u < len; u += frameMs) {
      ticks.push({
        a: hasA ? ba[k] + Math.min(u, lenA) : a.end,
        b: hasB ? bb[k] + Math.min(u, lenB) : b.end,
        aMissing: !hasA,
        bMissing: !hasB,
        step: k - 1,
        sinceStep: k === 0 ? -1 : u,
      });
    }
    carry = u - len;
  }
  // The final frame: both sides at their end, so the clip closes on the result.
  ticks.push({
    a: a.end, b: b.end,
    aMissing: ba.length - 1 < segments, bMissing: bb.length - 1 < segments,
    step: segments - 2, sinceStep: Number.MAX_SAFE_INTEGER,
  });
  return ticks;
}

/** Output duration of an aligned timeline, in ms. */
export function timelineDuration(ticks: Tick[], fps: number): number {
  return Math.round((ticks.length - 1) * 1000 / fps);
}

/**
 * Index of the frame on screen at `t`: the last one captured at or before it.
 * The screencast sends a frame only when pixels change, so the one before is
 * what was still showing. Before the first frame, the first frame.
 */
export function frameAt(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  if (hi < 0) return -1;
  if (t < times[0]) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
