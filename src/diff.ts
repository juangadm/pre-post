/**
 * Pixel diff between two PNG screenshots.
 *
 * Pure JS (pixelmatch + pngjs): no native build step, works everywhere the
 * CLI runs. Produces a change ratio, the bounding box of the change, a
 * highlight image, and tight crops of before/after around the change.
 */

import { createHash } from 'crypto';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { DiffRegion, DiffResult, ShiftSummary } from './types.js';
import { alignBefore, detectShift, insertedBand } from './shift.js';

export interface DiffOptions {
  /** Padding around the change region for crops, in device pixels. Default 80 */
  padding?: number;
  /** Minimum crop size in device pixels. Default 800x400 */
  minCrop?: { width: number; height: number };
  /** Integer factor to shrink the highlight image by (e.g. 2 for 2x captures). Default 1 */
  highlightDownscale?: number;
  /**
   * Produce the red-highlight overlay. Default true.
   *
   * The pr pipeline uses the bounding box to crop Pre and Post, and ships that
   * pair; it never publishes the overlay, and a wall of red pixels is not
   * something a reviewer reads anyway. Encoding one per capture is a downscale
   * and a deflate of a full-page image for nothing, so that path turns it off.
   * Image mode still writes diff.png.
   */
  highlight?: boolean;
  /**
   * What counts as a change, in device pixels and share of the canvas — the
   * same rule the verdict uses (`isChanged`). Default: any pixel.
   *
   * The crop used to be drawn around every differing pixel while the verdict
   * applied this rule, so the two disagreed: a pure move left a few pixels of
   * animation noise, the report said "nothing else changed", and the crop
   * showed the noise. Now a crop is only drawn around change the rule counts.
   */
  rule?: ChangeRule;
  /** Changed pixels closer than this (device px) belong to one patch. Default 48. */
  clusterGap?: number;
}

export interface ChangeRule {
  /** Smallest changed area that counts, in device pixels. */
  minPixels: number;
  /** Smallest changed share of the canvas that counts, 0..1. */
  minRatio: number;
}

/** Do this many changed pixels, this share of the canvas, count under the rule? */
export function meetsRule(pixels: number, ratio: number, rule: ChangeRule): boolean {
  if (pixels === 0) return false;
  return pixels >= rule.minPixels || ratio >= rule.minRatio;
}

const ANY_PIXEL: ChangeRule = { minPixels: 1, minRatio: 0 };

const DIFF_COLOR: [number, number, number] = [255, 0, 0];
const AA_COLOR: [number, number, number] = [255, 200, 0];
/** Background used to pad images of different sizes. */
const PAD_COLOR: [number, number, number] = [255, 255, 255];
/**
 * pixelmatch per-pixel colour distance (0..1).
 *
 * Calibrated, not chosen. At the old 0.1 a 600x320 card recoloured from #ffffff
 * to #e6e6e6 — plainly visible, a sixth of the viewport — reported *zero*
 * changed pixels, and `rung-6-section` measured 1649 CSS px² instead of 67539.
 * The ladder never caught it because every rung varies painted *area* while the
 * threshold governs *contrast*, so nothing in the suite moved along that axis.
 * `contrast-*` is that missing axis.
 *
 * Measured across the fixtures, changed CSS px² by threshold:
 *
 *              0.1    0.05    0.03    0.02    0.01
 *   contrast-25  0  191754  191754  191754  191754
 *   contrast-15  0  191758  191758  191758  191758
 *   contrast-10  0       0  191758  191758  191758
 *   contrast-05  0       0       0       0  191762
 *   rung-6    1649    1649   67539   67539   67539
 *   noise-*      0       0       0       0       0
 *
 * Every no-op stays at zero the whole way down, and so does the strongest
 * real-world check available: the same page captured from two different
 * deployments, which reports 0 at every value above, desktop and mobile.
 *
 * 0.02 catches every delta a reader would call visible and keeps a margin above
 * the floor for sites noisier than the ones measured. 0.01 was also clean here;
 * the margin is deliberate, since the alternative to a marginal false positive
 * is silently publishing "No visual changes" about a page that changed.
 */
const PIXEL_THRESHOLD = 0.02;
/** No crop when the change covers more than this fraction of the canvas. */
const CROP_MAX_RATIO = 0.5;
/** A crop at least this share of the page's width is widened to all of it. */
const WIDE_SHARE = 0.6;
/**
 * A shift is only worth reporting when putting the two sides back in register
 * accounts for most of the difference. This is the whole test: an offset that
 * does not remove the pixels it claims to explain is not the story.
 *
 * Judged over the rows Pre and Post share. Content Post gained is excluded
 * from both sides of the comparison, because an insertion is the reason for
 * the move rather than evidence against it: a page pushed down by a banner
 * would otherwise be refused for the size of the banner.
 *
 * Measured on the shift ladder, as a share of the changed pixels over those
 * shared rows: every true shift leaves 0.23 or less, and the horizontal
 * reflow — the one case no vertical offset explains — leaves 0.45. This sits
 * in the empty band between, nearer the real changes so a genuine shift
 * carrying a larger change still reads as one. Erring low is deliberate:
 * rejecting a shift falls back to the old behaviour, while claiming one that
 * isn't there tells a reviewer something untrue.
 */
const MAX_ALIGNED_SHARE = 0.3;

function padTo(src: PNG, width: number, height: number, bg: [number, number, number]): PNG {
  if (src.width === width && src.height === height) return src;
  const out = new PNG({ width, height });
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = bg[0]; out.data[i + 1] = bg[1]; out.data[i + 2] = bg[2]; out.data[i + 3] = 255;
  }
  PNG.bitblt(src, out, 0, 0, src.width, src.height, 0, 0);
  return out;
}

function crop(src: PNG, region: DiffRegion): Buffer {
  const out = new PNG({ width: region.width, height: region.height });
  PNG.bitblt(src, out, region.x, region.y, region.width, region.height, 0, 0);
  return encode(out);
}

function encode(png: PNG): Buffer {
  return PNG.sync.write(png, { deflateLevel: 4, filterType: 4 });
}

/** Box-filter downscale by an integer factor. */
export function downscale(src: PNG, factor: number): PNG {
  if (factor <= 1) return src;
  const w = Math.max(1, Math.floor(src.width / factor));
  const h = Math.max(1, Math.floor(src.height / factor));
  const out = new PNG({ width: w, height: h });
  const n = factor * factor;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < factor; dy++) {
        let i = ((y * factor + dy) * src.width + x * factor) * 4;
        for (let dx = 0; dx < factor; dx++, i += 4) {
          r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2]; a += src.data[i + 3];
        }
      }
      const o = (y * w + x) * 4;
      out.data[o] = r / n; out.data[o + 1] = g / n; out.data[o + 2] = b / n; out.data[o + 3] = a / n;
    }
  }
  return out;
}

export function decodePng(buffer: Buffer): PNG {
  return PNG.sync.read(buffer);
}

/** Is the pixel at byte offset `i` of a diff image painted as changed? */
function isDiffPixel(data: Buffer, i: number): boolean {
  return data[i] === DIFF_COLOR[0] && data[i + 1] === DIFF_COLOR[1] && data[i + 2] === DIFF_COLOR[2];
}

/** Diff-coloured pixels within a row range, for weighing one band against another. */
function countChangedRows(diff: PNG, y0: number, y1: number): number {
  const { width, data } = diff;
  let count = 0;
  for (let y = Math.max(0, y0); y < Math.min(diff.height, y1); y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) if (isDiffPixel(data, row + x * 4)) count++;
  }
  return count;
}

/** A patch of change: nearby changed pixels, merged. */
export interface Cluster extends DiffRegion {
  pixels: number;
}

/**
 * Group changed pixels into patches, merging any closer than `gap`.
 *
 * One box around every changed pixel is what produced an 808x1356 crop for a
 * header-link change: the link, plus a few pixels of an animated image far
 * below it, made one box spanning both. As patches, the link is one and the
 * specks are another, and each can be judged on its own.
 *
 * Works on a grid of `gap`-sized cells, joining neighbouring cells, so the
 * cost is one pass over the pixels plus one over the occupied cells.
 */
export function findClusters(diff: PNG, gap: number): Cluster[] {
  const { width, height, data } = diff;
  const cell = Math.max(1, Math.round(gap));
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const count = new Int32Array(cols * rows);
  const minX = new Int32Array(cols * rows).fill(width);
  const minY = new Int32Array(cols * rows).fill(height);
  const maxX = new Int32Array(cols * rows).fill(-1);
  const maxY = new Int32Array(cols * rows).fill(-1);
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    const cy = Math.floor(y / cell) * cols;
    for (let x = 0; x < width; x++) {
      if (!isDiffPixel(data, row + x * 4)) continue;
      const c = cy + Math.floor(x / cell);
      count[c]++;
      if (x < minX[c]) minX[c] = x;
      if (x > maxX[c]) maxX[c] = x;
      if (y < minY[c]) minY[c] = y;
      if (y > maxY[c]) maxY[c] = y;
    }
  }
  const seen = new Uint8Array(cols * rows);
  const clusters: Cluster[] = [];
  for (let start = 0; start < count.length; start++) {
    if (!count[start] || seen[start]) continue;
    let x0 = width, y0 = height, x1 = -1, y1 = -1, pixels = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      pixels += count[c];
      x0 = Math.min(x0, minX[c]); y0 = Math.min(y0, minY[c]);
      x1 = Math.max(x1, maxX[c]); y1 = Math.max(y1, maxY[c]);
      const cx = c % cols;
      const cy = (c - cx) / cols;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const n = ny * cols + nx;
          if (count[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
        }
      }
    }
    clusters.push({ x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1, pixels });
  }
  return clusters;
}

/**
 * The part of the page a crop should show: every patch that counts on its own,
 * or, when none does but together they do, all of them. The second case is
 * several small real edits — five recoloured icons — which must still be shown.
 */
export function regionOfInterest(clusters: Cluster[], rule: ChangeRule): DiffRegion | null {
  const own = clusters.filter(c => c.pixels >= rule.minPixels);
  return union(own.length ? own : clusters);
}

/** The box around every region given, or null for none. */
function union(regions: DiffRegion[]): DiffRegion | null {
  if (!regions.length) return null;
  const x0 = Math.min(...regions.map(r => r.x));
  const y0 = Math.min(...regions.map(r => r.y));
  const x1 = Math.max(...regions.map(r => r.x + r.width));
  const y1 = Math.max(...regions.map(r => r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * What changed, as a value: the exact pixels of both sides inside the changed
 * region, not where on the page it sits.
 *
 * Two routes with the same fingerprint show the same change — one nav edit
 * seen on six pages — so the report can show it once. Exact bytes, not a
 * tolerance: merging two changes that merely look alike would hide one.
 */
function fingerprint(before: PNG, after: PNG, region: DiffRegion): string {
  const hash = createHash('sha1').update(`${region.width}x${region.height}`);
  const stride = before.width * 4;
  for (const img of [before, after]) {
    for (let y = region.y; y < region.y + region.height; y++) {
      const start = y * stride + region.x * 4;
      hash.update(img.data.subarray(start, start + region.width * 4));
    }
  }
  return hash.digest('hex');
}

/** Expand a region by padding and to a minimum size, clamped to the canvas. */
export function expandRegion(
  region: DiffRegion,
  canvas: { width: number; height: number },
  padding: number,
  min: { width: number; height: number },
): DiffRegion {
  let x0 = region.x - padding;
  let y0 = region.y - padding;
  let x1 = region.x + region.width + padding;
  let y1 = region.y + region.height + padding;

  const grow = (lo: number, hi: number, target: number, limit: number): [number, number] => {
    const size = hi - lo;
    if (size < target) {
      const extra = target - size;
      lo -= Math.floor(extra / 2);
      hi += Math.ceil(extra / 2);
    }
    if (lo < 0) { hi -= lo; lo = 0; }
    if (hi > limit) { lo -= hi - limit; hi = limit; }
    return [Math.max(0, lo), Math.min(limit, hi)];
  };

  [x0, x1] = grow(x0, x1, Math.min(min.width, canvas.width), canvas.width);
  [y0, y1] = grow(y0, y1, Math.min(min.height, canvas.height), canvas.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Compare two PNG buffers. Images of different sizes are padded onto a shared
 * canvas so a height change shows up as a change rather than an error.
 */
export function diffImages(beforePng: Buffer, afterPng: Buffer, options: DiffOptions = {}): DiffResult {
  const bg = PAD_COLOR;
  const a = decodePng(beforePng);
  const b = decodePng(afterPng);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const sizeChanged = a.width !== b.width || a.height !== b.height;

  const before = padTo(a, width, height, bg);
  const after = padTo(b, width, height, bg);
  const diff = new PNG({ width, height });

  const changedPixels = pixelmatch(before.data, after.data, diff.data, width, height, {
    threshold: PIXEL_THRESHOLD,
    includeAA: false,
    alpha: 0.5,
    diffColor: DIFF_COLOR,
    aaColor: AA_COLOR,
    diffMask: false,
  });

  // A vertical shift repaints everything below where it starts, so the raw
  // bounding box covers most of the page and the crop guards below refuse to
  // zoom in. Comparing Post put back in register with Pre isolates the change
  // the branch actually made, which is small enough to crop and to describe.
  let shift: ShiftSummary | undefined;
  let alignedBefore: PNG | undefined;
  let alignedDiff: PNG | undefined;
  if (changedPixels > 0) {
    const candidate = detectShift(before, after);
    if (candidate) {
      const aligned = alignBefore(before, candidate, bg);
      const diffOfAligned = new PNG({ width, height });
      const alignedChangedPixels = pixelmatch(aligned.data, after.data, diffOfAligned.data, width, height, {
        threshold: PIXEL_THRESHOLD,
        includeAA: false,
        alpha: 0.5,
        diffColor: DIFF_COLOR,
        aaColor: AA_COLOR,
        diffMask: false,
      });
      // Weigh the offset only on rows both sides have. Whatever Post put in
      // the gap is new content, and it still counts as a change -- it just
      // does not get a vote on whether the move happened.
      const gap = insertedBand(candidate);
      const insertedChanged = gap ? countChangedRows(diffOfAligned, gap.y, gap.y + gap.height) : 0;
      const rawInGap = gap ? countChangedRows(diff, gap.y, gap.y + gap.height) : 0;
      const mappedChanged = alignedChangedPixels - insertedChanged;
      const rawMapped = changedPixels - rawInGap;
      if (mappedChanged <= rawMapped * MAX_ALIGNED_SHARE) {
        shift = {
          dy: candidate.dy,
          from: candidate.from,
          alignedChangedPixels,
          alignedChangedRatio: alignedChangedPixels / (width * height),
        };
        alignedBefore = aligned;
        alignedDiff = diffOfAligned;
      }
    }
  }

  // One pass groups the changed pixels; their union is the bounding box.
  const gap = options.clusterGap ?? 48;
  const clusters = changedPixels > 0 ? findClusters(diff, gap) : [];
  const region = union(clusters);
  const result: DiffResult = {
    changedRatio: changedPixels / (width * height),
    changedPixels,
    width,
    height,
    region,
    sizeChanged,
    // Identical pages need no highlight; skip the downscale + deflate.
    highlight: region && options.highlight !== false
      ? encode(downscale(diff, options.highlightDownscale ?? 1))
      : undefined,
    shift,
  };

  // With a shift, crop what is left once the move is undone; without one, crop
  // the change itself. A pure shift leaves nothing that counts and gets no
  // crop: the sentence is the report, and the full pages are already
  // published. "Counts" is the verdict's own rule, so the crop can never show
  // something the report just called unchanged.
  const rule = options.rule ?? ANY_PIXEL;
  const cropFrom = alignedBefore ?? before;
  const leftOver = shift ? shift.alignedChangedPixels : changedPixels;
  const cropRegion = meetsRule(leftOver, leftOver / (width * height), rule)
    ? regionOfInterest(alignedDiff ? findClusters(alignedDiff, gap) : clusters, rule)
    : null;
  if (cropRegion) {
    const area = cropRegion.width * cropRegion.height;
    if (area / (width * height) <= CROP_MAX_RATIO) {
      // Only what can be grouped is fingerprinted: a localized change on an
      // unmoved page. A move is grouped by its distance instead.
      if (!shift) result.fingerprint = fingerprint(before, after, cropRegion);
      let expanded = expandRegion(
        cropRegion,
        { width, height },
        options.padding ?? 80,
        options.minCrop ?? { width: 800, height: 400 },
      );
      // A change that spans most of the width is shown full width: cutting a
      // row of content part way through, as a padded box did, reads as the
      // page being clipped.
      if (expanded.width >= width * WIDE_SHARE) expanded = { ...expanded, x: 0, width };
      // Only crop when it meaningfully zooms in.
      if (expanded.width * expanded.height < width * height * 0.8) {
        result.crop = {
          before: crop(cropFrom, expanded),
          after: crop(after, expanded),
          region: expanded,
        };
      }
    }
  }

  return result;
}
