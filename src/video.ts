/**
 * Animated GIF capture via sequential Playwright screenshots + gifenc encoding.
 *
 * Pipeline: JPEG screenshots → canvas decode → gifenc quantize → animated GIF.
 * Single codepath. No FFmpeg. No external dependencies beyond Playwright + gifenc.
 */

import { Browser, Page } from 'playwright';
import { VideoOptions, VideoResult, ViewportSize } from './types.js';
import { getBrowser } from './browser.js';
import { createRequire } from 'module';

// gifenc ships as CJS — use createRequire for ESM compat
const require = createRequire(import.meta.url);
const {
  GIFEncoder,
  quantize,
  applyPalette,
} = require('gifenc') as {
  GIFEncoder: (opts?: { initialCapacity?: number }) => GifEncoder;
  quantize: (data: Uint8Array, maxColors: number, opts?: { format?: string }) => number[][];
  applyPalette: (data: Uint8Array, palette: number[][], format?: string) => Uint8Array;
};

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

// ============================================================
// Canvas decoder page (reused across frames)
// ============================================================

let decoderPage: Page | null = null;

async function getDecoderPage(browser: Browser): Promise<Page> {
  if (decoderPage && !decoderPage.isClosed()) return decoderPage;
  decoderPage = await browser.newPage();
  await decoderPage.setContent('<canvas id="c"></canvas>');
  return decoderPage;
}

async function closeDecoderPage(): Promise<void> {
  if (decoderPage && !decoderPage.isClosed()) {
    await decoderPage.close();
    decoderPage = null;
  }
}

/**
 * Decode a JPEG buffer to raw RGBA pixels at target dimensions.
 * Uses a hidden Playwright page with canvas for decoding.
 */
async function decodeJpegToRgba(
  browser: Browser,
  jpegBuffer: Buffer,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const pg = await getDecoderPage(browser);
  const base64 = jpegBuffer.toString('base64');

  const rawPixels = await pg.evaluate(
    async ({ b64, w, h }: { b64: string; w: number; h: number }) => {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = reject;
        img.src = `data:image/jpeg;base64,${b64}`;
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
  const duration = options.duration ?? 3;
  const fps = options.fps ?? 5;
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

  // Capture JPEG frames
  const frames: Buffer[] = [];
  let identicalCount = 0;

  for (let i = 0; i < totalFrames; i++) {
    const screenshot = await page.screenshot({ type: 'jpeg', quality: 80 });
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
  const browser = await getBrowser();
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
    await closeDecoderPage();
  }
}

// ============================================================
// GIF encoding
// ============================================================

/**
 * Encode an array of JPEG screenshot Buffers into an animated GIF.
 */
async function encodeGif(
  browser: Browser,
  frames: Buffer[],
  viewport: ViewportSize,
  fps: number,
): Promise<Buffer> {
  const width = viewport.width;
  const height = viewport.height;
  const delayCs = Math.round(1000 / fps / 10); // GIF delay is in centiseconds

  const encoder = GIFEncoder();

  for (let i = 0; i < frames.length; i++) {
    console.log(`Encoding frame ${i + 1}/${frames.length}...`);

    const rgba = await decodeJpegToRgba(browser, frames[i], width, height);
    const palette = quantize(rgba, 256, { format: 'rgba4444' });
    const indexed = applyPalette(rgba, palette, 'rgba4444');

    encoder.writeFrame(indexed, width, height, {
      palette,
      delay: delayCs,
      repeat: 0, // loop forever
    });
  }

  encoder.finish();
  return Buffer.from(encoder.bytes());
}
