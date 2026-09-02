/**
 * Pixel diff between two PNG screenshots.
 *
 * Pure JS (pixelmatch + pngjs): no native build step, works everywhere the
 * CLI runs. Produces a change ratio, the bounding box of the change, a
 * highlight image, and tight crops of before/after around the change.
 */

import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { DiffRegion, DiffResult } from './types.js';

export interface DiffOptions {
  /** Padding around the change region for crops, in device pixels. Default 80 */
  padding?: number;
  /** Minimum crop size in device pixels. Default 800x400 */
  minCrop?: { width: number; height: number };
  /** Integer factor to shrink the highlight image by (e.g. 2 for 2x captures). Default 1 */
  highlightDownscale?: number;
}

const DIFF_COLOR: [number, number, number] = [255, 0, 0];
const AA_COLOR: [number, number, number] = [255, 200, 0];
/** Background used to pad images of different sizes. */
const PAD_COLOR: [number, number, number] = [255, 255, 255];
/** pixelmatch per-pixel color distance (0..1). */
const PIXEL_THRESHOLD = 0.1;
/** No crop when the change covers more than this fraction of the canvas. */
const CROP_MAX_RATIO = 0.5;

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

/** Bounding box of pixels painted with the diff color. */
function boundingBox(diff: PNG): DiffRegion | null {
  const { width, height, data } = diff;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = row + x * 4;
      if (data[i] === DIFF_COLOR[0] && data[i + 1] === DIFF_COLOR[1] && data[i + 2] === DIFF_COLOR[2]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
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

  const region = changedPixels > 0 ? boundingBox(diff) : null;
  const result: DiffResult = {
    changedRatio: changedPixels / (width * height),
    changedPixels,
    width,
    height,
    region,
    sizeChanged,
    // Identical pages need no highlight; skip the downscale + deflate.
    highlight: region ? encode(downscale(diff, options.highlightDownscale ?? 1)) : undefined,
  };

  if (region) {
    const area = region.width * region.height;
    if (area / (width * height) <= CROP_MAX_RATIO) {
      const expanded = expandRegion(
        region,
        { width, height },
        options.padding ?? 80,
        options.minCrop ?? { width: 800, height: 400 },
      );
      // Only crop when it meaningfully zooms in.
      if (expanded.width * expanded.height < width * height * 0.8) {
        result.crop = {
          before: crop(before, expanded),
          after: crop(after, expanded),
          region: expanded,
        };
      }
    }
  }

  return result;
}
