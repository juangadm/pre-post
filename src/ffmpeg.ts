/**
 * Encoding with the ffmpeg Playwright already knows how to install.
 *
 * Playwright ships a 2.5 MB ffmpeg for its own video recording, installed the
 * same way as the headless browser, so nobody has to install anything. It is a
 * minimal build (measured, revision 1011): libvpx VP8 encode and decode, mjpeg
 * decode, image2pipe in, WebM out, pad/crop/scale — and no `hstack`, no
 * drawtext, no `-` alias for stdin (it has to be `pipe:0`, as Playwright's own
 * recorder writes it). That is why frames are composited in a canvas and piped
 * in as JPEGs, and why the output is WebM.
 */

import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { installBrowser, playwrightCacheDir } from './browser.js';

const BINARY = process.platform === 'darwin' ? 'ffmpeg-mac'
  : process.platform === 'win32' ? 'ffmpeg-win64.exe'
    : 'ffmpeg-linux';

/**
 * The largest clip that is sure to upload. GitHub takes 10 MB of video on a
 * Free plan (100 MB on paid ones, but nothing here can tell which), so a clip
 * over this is re-encoded smaller rather than refused at upload.
 */
export const MAX_CLIP_BYTES = 8 * 1024 * 1024;

/** Playwright's ffmpeg, newest revision first, when one is installed. */
function findCached(): string | null {
  const dir = playwrightCacheDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter(e => /^ffmpeg-\d+$/.test(e));
  } catch {
    return null;
  }
  entries.sort((a, b) => Number(b.slice(7)) - Number(a.slice(7)));
  for (const entry of entries) {
    const full = path.join(dir, entry, BINARY);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/** An ffmpeg on PATH that can encode VP8, the last resort. */
function findSystem(): string | null {
  const probe = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf-8' });
  return probe.status === 0 && /libvpx/.test(probe.stdout) ? 'ffmpeg' : null;
}

/** Where ffmpeg is, without installing anything. For `doctor`. */
export function findFfmpeg(): string | null {
  const override = process.env.PRE_POST_FFMPEG;
  if (override) return fs.existsSync(override) ? override : null;
  return findCached() ?? findSystem();
}

let ready: Promise<string> | null = null;

/** ffmpeg, installing Playwright's (one time, ~2 MB) when there is none. */
export function ensureFfmpeg(): Promise<string> {
  ready ??= (async () => {
    const found = findFfmpeg();
    if (found) return found;
    if (await installBrowser('ffmpeg')) {
      const installed = findCached();
      if (installed) return installed;
    }
    throw new Error('Video needs ffmpeg and it could not be installed. Run: npx playwright-core install ffmpeg');
  })().catch(err => { ready = null; throw err; });
  return ready;
}

export interface Encoder {
  /** Queue one JPEG frame; resolves when ffmpeg can take more. */
  write(jpeg: Buffer): Promise<void>;
  /** Close the input and wait for the file. */
  finish(): Promise<void>;
}

const VP8 = ['-c:v', 'libvpx', '-qmin', '0', '-qmax', '50', '-deadline', 'realtime', '-cpu-used', '8', '-auto-alt-ref', '0'];

/**
 * Stream JPEG frames at `fps` into a WebM at `out`.
 *
 * `-crf 10` is what sets the quality; the bitrate only caps it. Measured on a
 * dropdown clip, 1M and 3M came out within 15% of each other and both kept
 * 16px text readable in an 800px pane.
 */
export function startEncoder(ffmpeg: string, out: string, fps: number): Encoder {
  const child = spawn(ffmpeg, [
    '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-avioflags', 'direct', '-fpsprobesize', '0', '-probesize', '32', '-analyzeduration', '0',
    '-framerate', String(fps), '-c:v', 'mjpeg', '-i', 'pipe:0',
    '-an', ...VP8, '-crf', '10', '-b:v', '2M', out,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  // stdin errors (EPIPE when ffmpeg dies early) surface through `closed`.
  child.stdin.on('error', () => undefined);
  const closed = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg failed (exit ${code}): ${stderr.trim().split('\n').pop() ?? ''}`)));
  });
  let exited = false;
  closed.catch(() => undefined).finally(() => { exited = true; });
  return {
    async write(jpeg) {
      // A dead encoder never drains, so waiting on 'drain' alone would hang
      // the run forever; the spike did exactly that.
      if (exited) return closed;
      if (!child.stdin.write(jpeg)) {
        await Promise.race([new Promise<void>(r => child.stdin.once('drain', r)), closed]);
      }
    },
    async finish() {
      child.stdin.end();
      await closed;
    },
  };
}

/**
 * Bring a clip under `maxBytes` by re-encoding it smaller, once. Returns the
 * final size. Re-encodes from the WebM itself, so nothing has to keep every
 * frame in memory in case the clip turns out large.
 */
export async function fitSize(ffmpeg: string, file: string, durationMs: number, maxBytes = MAX_CLIP_BYTES): Promise<number> {
  const size = fs.statSync(file).size;
  if (size <= maxBytes) return size;
  const seconds = Math.max(1, durationMs / 1000);
  // 90% of the budget, leaving room for the container.
  const kbps = Math.max(200, Math.floor((maxBytes * 8 * 0.9) / seconds / 1000));
  const tmp = file.replace(/\.webm$/, '.fit.webm');
  const res = spawnSync(ffmpeg, [
    '-loglevel', 'error', '-y', '-i', file,
    '-vf', 'scale=trunc(iw*0.75/2)*2:trunc(ih*0.75/2)*2',
    '-an', ...VP8, '-crf', '30', '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`, tmp,
  ], { encoding: 'utf-8' });
  if (res.status !== 0) throw new Error(`Could not shrink the clip: ${(res.stderr || '').trim().split('\n').pop()}`);
  fs.renameSync(tmp, file);
  return fs.statSync(file).size;
}
