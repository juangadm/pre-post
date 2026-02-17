/**
 * Animated GIF capture via sequential Playwright screenshots + gifenc encoding.
 *
 * Pipeline: PNG screenshots → canvas decode → gifenc quantize → animated GIF.
 * Single codepath. No FFmpeg. No external dependencies beyond Playwright + gifenc.
 */

import { Browser, Page } from 'playwright';
import { VideoOptions, VideoResult, ViewportSize } from './types.js';
import { getBrowser } from './browser.js';
import { createRequire } from 'module';

// gifenc ships as CJS — use createRequire for ESM compat
const require = createRequire(import.meta.url);
type GifencModule = {
  GIFEncoder: (opts?: { initialCapacity?: number }) => GifEncoder;
  quantize: (data: Uint8Array, maxColors: number, opts?: { format?: string }) => number[][];
  applyPalette: (data: Uint8Array, palette: number[][], format?: string) => Uint8Array;
};

let gifencModule: GifencModule | null = null;

function getGifenc(): GifencModule {
  if (gifencModule) return gifencModule;

  try {
    gifencModule = require('gifenc') as GifencModule;
    return gifencModule;
  } catch {
    throw new Error(
      'GIF capture requires the "gifenc" dependency for --video captures. Install dependencies with `npx pnpm install`.'
    );
  }
}

interface GifEncoder {
  writeFrame: (
    index: Uint8Array,
    width: number,
    height: number,
    opts?: { palette?: number[][]; delay?: number; repeat?: number; dispose?: number },
  ) => void;
  finish: () => void;
  bytes: () => Uint8Array;
}

// Mobile viewport height cap for GIF mode (above-the-fold, not comically tall)
const MOBILE_GIF_HEIGHT = 667;
const DEFAULT_DURATION_SECONDS = 3;
const DEFAULT_FPS = 5;
const MAX_DURATION_SECONDS = 10;
const MAX_FPS = 10;
const MIN_FPS = 1;

// ============================================================
// Canvas decoder page (reused across frames)
// ============================================================

/**
 * Decode an image buffer to raw RGBA pixels at target dimensions.
 * Uses a hidden Playwright page with canvas for decoding.
 */
async function decodeImageToRgba(
  decoderPage: Page,
  imageBuffer: Buffer,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const pg = decoderPage;
  const base64 = imageBuffer.toString('base64');

  const rawPixels = await pg.evaluate(
    async ({ b64, w, h }: { b64: string; w: number; h: number }) => {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = reject;
        img.src = `data:image/png;base64,${b64}`;
      });

      const canvas = document.getElementById('c') as HTMLCanvasElement;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);
      return Array.from(imageData.data);
    },
    { b64: base64, w: width, h: height },
  );

  return new Uint8Array(rawPixels);
}

// ============================================================
// Core capture function
// ============================================================

/**
 * Capture animated GIF frames from an existing Playwright Page.
 * Caller manages page lifecycle.
 */
export async function captureGif(
  page: Page,
  url: string,
  options: VideoOptions,
): Promise<VideoResult> {
  const duration = normalizeDuration(options.duration);
  const fps = normalizeFps(options.fps);
  const delay = options.delay ?? 0;
  const totalFrames = Math.ceil(duration * fps);
  const frameInterval = Math.round(1000 / fps);

  // Navigate — do NOT kill animations
  const response = await page.goto(url, { waitUntil: 'networkidle' });

  // Warn on HTTP errors (but continue — page may still have content)
  if (response && response.status() >= 400) {
    console.warn(`Warning: ${url} returned HTTP ${response.status()}`);
  }

  // Wait for fonts
  await page.evaluate(() => document.fonts.ready);

  // Optional delay before recording
  if (delay > 0) {
    await page.waitForTimeout(delay);
  }

  // Scroll selector into view if specified
  if (options.selector) {
    const locator = page.locator(options.selector);
    const count = await locator.count();
    if (count === 0) {
      throw new Error(`Element not found: ${options.selector}`);
    }
    await locator.first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(100);
  }

  // Capture PNG frames
  const frames: Buffer[] = [];
  let identicalCount = 0;

  for (let i = 0; i < totalFrames; i++) {
    const screenshot = await page.screenshot({ type: 'png' });
    const frame = Buffer.from(screenshot);

    // Early-stop: 3 consecutive identical frames means animation has settled
    if (frames.length > 0 && frame.equals(frames[frames.length - 1])) {
      identicalCount++;
      if (identicalCount >= 3) {
        console.log(`Animation settled after ${i} frames`);
        break;
      }
    } else {
      identicalCount = 0;
    }

    frames.push(frame);

    if (i < totalFrames - 1) {
      await page.waitForTimeout(frameInterval);
    }
  }

  // Encode GIF
  const browser = page.context().browser();
  if (!browser) {
    throw new Error('Cannot encode GIF: browser instance is not available on this page context.');
  }
  const gifBuffer = await encodeGif(browser, frames, options.viewport, fps);

  return {
    gif: gifBuffer,
    format: 'gif',
    viewport: options.viewport,
    url,
    duration,
    frameCount: frames.length,
    selector: options.selector,
  };
}

function normalizeDuration(duration?: number): number {
  if (duration === undefined) return DEFAULT_DURATION_SECONDS;
  if (!Number.isFinite(duration)) {
    throw new Error('Duration must be a finite number.');
  }
  return Math.min(MAX_DURATION_SECONDS, Math.max(0.1, duration));
}

function normalizeFps(fps?: number): number {
  if (fps === undefined) return DEFAULT_FPS;
  if (!Number.isFinite(fps)) {
    throw new Error('FPS must be a finite number.');
  }
  return Math.min(MAX_FPS, Math.max(MIN_FPS, Math.round(fps)));
}

// ============================================================
// High-level entry point
// ============================================================

/**
 * Capture an animated GIF of a URL.
 * Creates its own page at DPR 1 (no retina), captures, cleans up.
 */
export async function captureVideo(
  url: string,
  options: VideoOptions,
): Promise<VideoResult> {
  const browser = await getBrowser();

  // For mobile, cap height at 667px for GIF mode
  const viewport = { ...options.viewport };
  if (viewport.width <= 430 && viewport.height > MOBILE_GIF_HEIGHT) {
    viewport.height = MOBILE_GIF_HEIGHT;
  }

  const page = await browser.newPage({
    viewport,
    deviceScaleFactor: 1, // DPR 1 — retina wastes pixels in 256-color GIF
  });

  try {
    return await captureGif(page, url, { ...options, viewport });
  } finally {
    await page.close();
  }
}

// ============================================================
// GIF encoding
// ============================================================

/**
 * Encode an array of screenshot Buffers into an animated GIF.
 */
async function encodeGif(
  browser: Browser,
  frames: Buffer[],
  viewport: ViewportSize,
  fps: number,
): Promise<Buffer> {
  const { GIFEncoder, quantize, applyPalette } = getGifenc();
  const width = viewport.width;
  const height = viewport.height;
  const delayCs = Math.round(1000 / fps / 10); // GIF delay is in centiseconds

  const encoder = GIFEncoder();
  const rgbaFrames: Uint8Array[] = [];
  const decoderPage = await browser.newPage();
  await decoderPage.setContent('<canvas id="c"></canvas>');

  try {
    for (let i = 0; i < frames.length; i++) {
      console.log(`Decoding frame ${i + 1}/${frames.length}...`);
      rgbaFrames.push(await decodeImageToRgba(decoderPage, frames[i], width, height));
    }

    const palette = quantize(buildPaletteSample(rgbaFrames), 256, { format: 'rgba4444' });

    let previousIndexed: Uint8Array | null = null;
    let duplicateRunLength = 0;

    for (let i = 0; i < rgbaFrames.length; i++) {
      const indexed = applyPalette(rgbaFrames[i], palette, 'rgba4444');

      if (!previousIndexed) {
        previousIndexed = indexed;
        duplicateRunLength = 1;
        continue;
      }

      if (indexedEquals(previousIndexed, indexed)) {
        duplicateRunLength++;
        continue;
      }

      encoder.writeFrame(previousIndexed, width, height, {
        palette,
        delay: delayCs * duplicateRunLength,
        repeat: 0,
      });

      previousIndexed = indexed;
      duplicateRunLength = 1;
    }

    if (previousIndexed) {
      encoder.writeFrame(previousIndexed, width, height, {
        palette,
        delay: delayCs * duplicateRunLength,
        repeat: 0,
      });
    }

    encoder.finish();
    return Buffer.from(encoder.bytes());
  } finally {
    if (!decoderPage.isClosed()) {
      await decoderPage.close();
    }
  }
}

function buildPaletteSample(frames: Uint8Array[]): Uint8Array {
  const stride = 4 * 4;
  const sample: number[] = [];

  for (const frame of frames) {
    for (let i = 0; i < frame.length; i += stride) {
      sample.push(frame[i], frame[i + 1], frame[i + 2], frame[i + 3]);
    }
  }

  return new Uint8Array(sample);
}

function indexedEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
