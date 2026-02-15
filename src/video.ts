/**
 * Video/GIF capture via sequential Playwright screenshots + gifenc encoding.
 *
 * Captures frames at ~100ms intervals (≈10 FPS) and stitches them into
 * an animated GIF. Designed for short clips (1–5 seconds) of page load
 * animations, CSS transitions, and layout changes.
 *
 * When FFmpeg is available, an alternative path uses Playwright's native
 * recordVideo (WebM) + FFmpeg palette-optimized conversion for higher quality.
 */

import { Browser, Page, BrowserContext } from 'playwright';
import { ViewportSize } from './types.js';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// gifenc ships as CJS bundle — use createRequire for ESM compat
import { createRequire } from 'module';
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
  bytesView: () => Uint8Array;
}

// ============================================================
// Public types
// ============================================================

export interface VideoOptions {
  /** Viewport size for the capture. */
  viewport: ViewportSize;
  /** Recording duration in seconds. Default: 2 */
  duration?: number;
  /** Target FPS for GIF output. Default: 8 */
  fps?: number;
  /** CSS selector — scroll element into view before recording. */
  selector?: string;
  /** Capture full scrollable page. Default: false */
  fullPage?: boolean;
  /** Scale factor for GIF output relative to viewport. Default: 0.5 (half-res) */
  gifScale?: number;
}

export interface VideoResult {
  /** Raw GIF data */
  gif: Buffer;
  /** Output format identifier */
  format: 'gif';
  /** Viewport used for capture */
  viewport: ViewportSize;
  /** URL that was captured */
  url: string;
  /** Actual recording duration in seconds */
  duration: number;
  /** Number of frames in the GIF */
  frameCount: number;
  /** CSS selector used, if any */
  selector?: string;
}

// ============================================================
// FFmpeg detection (cached)
// ============================================================

let ffmpegAvailable: boolean | null = null;

function hasFfmpeg(): boolean {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  try {
    execSync('which ffmpeg', { stdio: 'pipe' });
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
  }
  return ffmpegAvailable;
}

// ============================================================
// Path B: Sequential screenshots → gifenc (default)
// ============================================================

/**
 * Capture a short animated GIF by taking rapid sequential screenshots.
 *
 * This is the default path — zero external dependencies beyond Playwright.
 * Produces ~8 FPS GIFs which is sufficient for most CSS transitions.
 */
export async function captureGif(
  page: Page,
  url: string,
  options: VideoOptions,
): Promise<VideoResult> {
  const duration = options.duration ?? 2;
  const fps = options.fps ?? 8;
  const gifScale = options.gifScale ?? 0.5;
  const totalFrames = Math.ceil(duration * fps);
  const frameDelay = Math.round(1000 / fps);

  // Navigate WITHOUT killing animations (unlike screenshot path)
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);

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

  // Capture frames
  const frames: Buffer[] = [];
  for (let i = 0; i < totalFrames; i++) {
    const screenshot = await page.screenshot({ fullPage: options.fullPage ?? false });
    frames.push(Buffer.from(screenshot));
    if (i < totalFrames - 1) {
      await page.waitForTimeout(frameDelay);
    }
  }

  // Encode GIF
  const gifBuffer = await encodeGif(frames, options.viewport, {
    fps,
    scale: gifScale,
  });

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
// Path A: Playwright recordVideo + FFmpeg (higher quality)
// ============================================================

/**
 * Capture a short animated GIF using Playwright's native video recording
 * and FFmpeg conversion. Produces smoother output (30+ FPS source).
 *
 * Requires FFmpeg installed on the system.
 */
export async function captureGifWithVideo(
  browser: Browser,
  url: string,
  options: VideoOptions,
): Promise<VideoResult> {
  const duration = options.duration ?? 2;
  const fps = options.fps ?? 10;
  const gifScale = options.gifScale ?? 0.5;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-video-'));

  const context = await browser.newContext({
    viewport: options.viewport,
    deviceScaleFactor: 1, // Record at 1x for video (keeps file size sane)
    recordVideo: { dir: tmpDir, size: options.viewport },
  });

  const page = await context.newPage();

  await page.goto(url, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);

  if (options.selector) {
    const locator = page.locator(options.selector);
    const count = await locator.count();
    if (count === 0) {
      await context.close();
      throw new Error(`Element not found: ${options.selector}`);
    }
    await locator.first().scrollIntoViewIfNeeded();
  }

  // Let animations play
  await page.waitForTimeout(duration * 1000);

  // Close context to finalize video file
  const video = page.video();
  const videoPath = video ? await video.path() : null;
  await context.close();

  if (!videoPath || !fs.existsSync(videoPath)) {
    throw new Error('Playwright video recording failed — no output file produced');
  }

  // Convert WebM → GIF via FFmpeg (two-pass palette optimization)
  const gifPath = path.join(tmpDir, 'output.gif');
  const palettePath = path.join(tmpDir, 'palette.png');
  const gifW = Math.round(options.viewport.width * gifScale);

  try {
    execSync(
      `ffmpeg -i "${videoPath}" -vf "fps=${fps},scale=${gifW}:-1:flags=lanczos,palettegen=stats_mode=diff" -y "${palettePath}"`,
      { stdio: 'pipe', timeout: 15000 },
    );
    execSync(
      `ffmpeg -i "${videoPath}" -i "${palettePath}" -lavfi "fps=${fps},scale=${gifW}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5" -y "${gifPath}"`,
      { stdio: 'pipe', timeout: 15000 },
    );

    const gifBuffer = fs.readFileSync(gifPath);

    return {
      gif: Buffer.from(gifBuffer),
      format: 'gif',
      viewport: options.viewport,
      url,
      duration,
      frameCount: Math.ceil(duration * fps),
      selector: options.selector,
    };
  } finally {
    // Clean up temp files
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ============================================================
// GIF encoding (pure JS via gifenc)
// ============================================================

interface EncodeOptions {
  fps: number;
  scale: number;
}

/**
 * Encode an array of PNG screenshot Buffers into an animated GIF.
 * Uses gifenc for quantization and LZW encoding.
 */
async function encodeGif(
  frames: Buffer[],
  viewport: ViewportSize,
  options: EncodeOptions,
): Promise<Buffer> {
  // We need to decode PNG frames to raw RGBA pixels.
  // Use a canvas-free approach: Playwright screenshots are PNG,
  // we can use the sharp-free method of creating an offscreen page.
  // But simpler: just use the raw pixel data from Playwright's screenshot API.
  //
  // Actually, Playwright returns PNG-encoded buffers. We need raw RGBA data.
  // The simplest approach without adding sharp: decode PNG manually.
  // We'll use a minimal PNG decoder.

  const gifWidth = Math.round(viewport.width * options.scale);
  const gifHeight = Math.round(viewport.height * options.scale);
  const delay = Math.round(1000 / options.fps / 10); // GIF delay is in centiseconds

  const encoder = GIFEncoder();

  for (let i = 0; i < frames.length; i++) {
    // Decode PNG to raw RGBA using built-in approach
    const rgba = await decodePngToRgba(frames[i], gifWidth, gifHeight);

    // Quantize to 256-color palette
    const palette = quantize(rgba, 256, { format: 'rgba4444' });
    const indexed = applyPalette(rgba, palette, 'rgba4444');

    encoder.writeFrame(indexed, gifWidth, gifHeight, {
      palette,
      delay,
      repeat: 0, // loop forever
      dispose: i === 0 ? -1 : 0,
    });
  }

  encoder.finish();
  return Buffer.from(encoder.bytes());
}

/**
 * Decode a PNG buffer to raw RGBA pixel data at a target resolution.
 *
 * Uses Playwright's page.evaluate to leverage the browser's built-in
 * PNG decoder + canvas scaling. This avoids adding sharp/canvas as a dep.
 *
 * Falls back to a simple approach using the existing Playwright page.
 */
let decoderPage: Page | null = null;
let decoderBrowser: Browser | null = null;

async function getDecoderPage(browser: Browser): Promise<Page> {
  if (decoderPage && !decoderPage.isClosed()) return decoderPage;
  decoderBrowser = browser;
  decoderPage = await browser.newPage();
  await decoderPage.setContent('<canvas id="c"></canvas>');
  return decoderPage;
}

/**
 * Minimal PNG decoder — decodes PNG to raw RGBA at target dimensions.
 * Leverages the browser's native image decoding via a hidden canvas.
 */
async function decodePngToRgba(
  pngBuffer: Buffer,
  targetWidth: number,
  targetHeight: number,
): Promise<Uint8Array> {
  // We'll use a simple inline approach: convert PNG to data URL,
  // then use OffscreenCanvas or Canvas to decode and resize.
  // This works because we already have a Playwright browser running.

  // For now, use the simpler approach of importing the PNG as raw pixels
  // via a data URL in the browser context.

  // Get a page from the module-level browser
  const { getBrowser } = await import('./browser.js');
  const browser = await getBrowser();
  const pg = await getDecoderPage(browser);

  const base64 = pngBuffer.toString('base64');

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
    { b64: base64, w: targetWidth, h: targetHeight },
  );

  return new Uint8Array(rawPixels);
}

/**
 * Close the decoder page used for PNG→RGBA conversion.
 * Should be called during cleanup.
 */
export async function closeDecoderPage(): Promise<void> {
  if (decoderPage && !decoderPage.isClosed()) {
    await decoderPage.close();
    decoderPage = null;
  }
}

// ============================================================
// Main entry point — auto-selects best available path
// ============================================================

/**
 * Capture a short animated GIF of a URL.
 * Automatically selects the best recording method:
 * - FFmpeg path (higher quality) when FFmpeg is available
 * - Sequential screenshot path (zero deps) as default
 */
export async function captureVideo(
  url: string,
  options: VideoOptions,
): Promise<VideoResult> {
  const { getBrowser } = await import('./browser.js');
  const browser = await getBrowser();

  if (hasFfmpeg()) {
    return captureGifWithVideo(browser, url, options);
  }

  // Default: sequential screenshots
  const page = await browser.newPage({
    viewport: options.viewport,
    deviceScaleFactor: 2,
  });

  try {
    return await captureGif(page, url, options);
  } finally {
    await page.close();
  }
}
