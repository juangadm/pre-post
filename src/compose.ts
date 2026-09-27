/**
 * Pre beside Post, in one clip.
 *
 * Two separate players cannot be kept in step — a reviewer presses play twice
 * and compares by eye — so the two recordings are drawn side by side into one
 * video, on the step-aligned timeline from `timeline.ts`. Drawn by the capture
 * browser on a canvas, like the summary sheet: the bundled ffmpeg has no
 * `hstack` and no text rendering, and the browser has both for free.
 *
 * On top of the frames: the PRE / Post lockup from the brand, the Moment's
 * name and the step in progress (so someone who never saw the code can follow
 * what is being done), a marker where each click lands, and a card over a
 * side that could not do a step — the usual reason being that the feature is
 * new in this PR.
 */

import fs from 'fs';
import { fileURLToPath } from 'url';
import { getBrowser } from './browser.js';
import { describeStep, Step } from './moments.js';
import type { PointerMark, SideRecording } from './record.js';
import { alignTimeline, frameAt, SideTiming, Tick, timelineDuration } from './timeline.js';
import { ensureFfmpeg, fitSize, startEncoder } from './ffmpeg.js';

export const FPS = 30;
/** Widest a pane is drawn; a desktop page is scaled down to it, a phone is not. */
export const MAX_PANE_WIDTH = 800;
const PAD = 20;
const HEADER = 56;
const FOOTER = 44;
/** How long a click marker takes to fade, in output ms. */
const CLICK_MARK_MS = 450;
const JPEG_QUALITY = 0.9;

export interface Layout {
  width: number;
  height: number;
  paneWidth: number;
  paneHeight: number;
  /** CSS px of the page → px of the pane. */
  scale: number;
}

const even = (n: number) => Math.ceil(n / 2) * 2;

/** Canvas size for a viewport. Even on both axes, which VP8's 4:2:0 needs. */
export function layoutFor(viewport: { width: number; height: number }): Layout {
  const scale = Math.min(1, MAX_PANE_WIDTH / viewport.width);
  const paneWidth = Math.round(viewport.width * scale);
  const paneHeight = Math.round(viewport.height * scale);
  return { width: even(PAD * 3 + paneWidth * 2), height: even(HEADER + paneHeight + FOOTER), paneWidth, paneHeight, scale };
}

function labelUri(name: 'pre' | 'post'): string | null {
  try {
    const file = fileURLToPath(new URL(`../assets/labels/${name}.png`, import.meta.url));
    return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
  } catch {
    return null;
  }
}

let labels: { pre: string | null; post: string | null } | undefined;

/** A card drawn over one pane: why that side shows nothing, or stopped. */
export interface Card {
  title: string;
  detail?: string;
}

interface PointerDraw {
  side: 'a' | 'b';
  x: number;
  y: number;
  kind: 'click' | 'hover';
  /** 0..1 through the click marker's fade. */
  p: number;
}

/** What to draw for a tick's pointer marks, if anything. */
export function pointersFor(tick: Tick, steps: Step[], pre: PointerMark[], post: PointerMark[]): PointerDraw[] {
  if (tick.step < 0) return [];
  const step = steps[tick.step];
  if (!step || (step.verb !== 'click' && step.verb !== 'hover' && step.verb !== 'type')) return [];
  const out: PointerDraw[] = [];
  const add = (side: 'a' | 'b', marks: PointerMark[], missing: boolean) => {
    const mark = !missing && marks.find(m => m.step === tick.step);
    if (!mark) return;
    if (step.verb === 'hover') out.push({ side, x: mark.x, y: mark.y, kind: 'hover', p: 0 });
    else if (tick.sinceStep < CLICK_MARK_MS) out.push({ side, x: mark.x, y: mark.y, kind: 'click', p: tick.sinceStep / CLICK_MARK_MS });
  };
  add('a', pre, tick.aMissing);
  add('b', post, tick.bMissing);
  return out;
}

/** The line under the clip: which step of how many, in words. */
export function captionFor(tick: Tick, steps: Step[]): string {
  if (tick.step < 0 || !steps.length) return '';
  let i = Math.min(tick.step, steps.length - 1);
  // "Wait" says nothing to a viewer; keep showing what they are watching the result of.
  while (i > 0 && steps[i].verb === 'wait') i--;
  if (steps[i].verb === 'wait') return '';
  return `${i + 1}/${steps.length} · ${describeStep(steps[i])}`;
}

/** In-page drawing code. Plain JS, run by the compositor page. */
const PAGE_SCRIPT = `
const cfg = window.__cfg;
const c = document.getElementById('c');
const g = c.getContext('2d');
// One decoded frame per side: ticks only move forward, so the frame being
// replaced is never needed again.
const shown = { a: null, b: null };
const labels = {};
const load = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
window.init = async () => {
  if (cfg.labels.pre) labels.pre = await load(cfg.labels.pre);
  if (cfg.labels.post) labels.post = await load(cfg.labels.post);
};
function rounded(x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); }
function paneX(side) { return side === 'a' ? cfg.pad : cfg.pad * 2 + cfg.paneWidth; }
function drawLabel(side) {
  const img = side === 'a' ? labels.pre : labels.post;
  const x = paneX(side);
  const baseline = cfg.header - 10;
  if (img) {
    const h = img.height / 2, w = img.width / 2;
    // Each image carries its own padding; these offsets put both glyphs'
    // baselines on one line (measured on the rendered labels).
    g.drawImage(img, x - 4, baseline - h + (side === 'a' ? 13 : 5), w, h);
  } else {
    g.fillStyle = '#262626'; g.font = '600 20px system-ui, sans-serif';
    g.fillText(side === 'a' ? 'PRE' : 'Post', x, baseline);
  }
}
function drawPane(side, img, card) {
  const x = paneX(side), y = cfg.header;
  g.save();
  rounded(x, y, cfg.paneWidth, cfg.paneHeight, 8);
  g.fillStyle = '#fff'; g.fill();
  g.clip();
  if (img) g.drawImage(img, x, y, cfg.paneWidth, cfg.paneHeight);
  if (card) {
    g.fillStyle = img ? 'rgba(245,245,245,0.86)' : '#fafafa';
    g.fillRect(x, y, cfg.paneWidth, cfg.paneHeight);
    g.textAlign = 'center';
    g.fillStyle = '#262626'; g.font = '600 17px system-ui, sans-serif';
    g.fillText(card.title, x + cfg.paneWidth / 2, y + cfg.paneHeight / 2 - (card.detail ? 6 : -6));
    if (card.detail) {
      g.fillStyle = '#737373'; g.font = '14px system-ui, sans-serif';
      g.fillText(card.detail, x + cfg.paneWidth / 2, y + cfg.paneHeight / 2 + 18);
    }
    g.textAlign = 'left';
  }
  g.restore();
  g.save();
  rounded(x + 0.5, y + 0.5, cfg.paneWidth - 1, cfg.paneHeight - 1, 8);
  g.strokeStyle = '#e5e5e5'; g.lineWidth = 1; g.stroke();
  g.restore();
}
function drawPointer(pt) {
  const x = paneX(pt.side) + pt.x * cfg.scale, y = cfg.header + pt.y * cfg.scale;
  g.save();
  if (pt.kind === 'hover') {
    g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2);
    g.fillStyle = 'rgba(246, 105, 108, 0.45)'; g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke();
  } else {
    const a = 1 - pt.p;
    g.beginPath(); g.arc(x, y, 8 + 16 * pt.p, 0, Math.PI * 2);
    g.strokeStyle = 'rgba(246, 105, 108,' + a + ')'; g.lineWidth = 3; g.stroke();
    g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2);
    g.fillStyle = 'rgba(246, 105, 108,' + a + ')'; g.fill();
  }
  g.restore();
}
async function frame(side, data) {
  if (data) shown[side] = await load('data:image/jpeg;base64,' + data);
  return shown[side];
}
window.draw = async t => {
  const [a, b] = await Promise.all([frame('a', t.a), frame('b', t.b)]);
  g.fillStyle = '#f5f5f5'; g.fillRect(0, 0, c.width, c.height);
  drawLabel('a'); drawLabel('b');
  drawPane('a', a, t.aCard); drawPane('b', b, null);
  for (const pt of t.pointers) drawPointer(pt);
  const fy = cfg.header + cfg.paneHeight + cfg.footer / 2 + 5;
  g.fillStyle = '#262626'; g.font = '600 15px system-ui, sans-serif';
  g.fillText(cfg.name, cfg.pad, fy);
  if (t.caption) {
    g.textAlign = 'right'; g.fillStyle = '#737373'; g.font = '14px ui-monospace, Menlo, Consolas, monospace';
    g.fillText(t.caption, c.width - cfg.pad, fy);
    g.textAlign = 'left';
  }
  return c.toDataURL('image/jpeg', ${JPEG_QUALITY}).slice('data:image/jpeg;base64,'.length);
};
`;

export interface ComposeInput {
  name: string;
  steps: Step[];
  /** Null when Pre has no such page: the pane shows `preCard` throughout. */
  pre: SideRecording | null;
  post: SideRecording;
  /** Shown over Pre once it has run out of steps, or throughout when `pre` is null. */
  preCard?: Card;
  /** The clip, `.webm`. */
  out: string;
  /** Its last frame, `.jpg`: the result of the interaction, for places video cannot play. */
  poster: string;
}

export interface ComposeResult {
  durationMs: number;
  bytes: number;
}

/** Draw, encode and size-check one Moment's clip. */
export async function composeMoment(input: ComposeInput): Promise<ComposeResult> {
  const { pre, post, steps } = input;
  const layout = layoutFor(post.viewport);
  const preTiming: SideTiming = pre ?? { start: post.start, end: post.start, marks: [] };
  const ticks = alignTimeline(preTiming, post, FPS);
  const timesA = pre?.frames.map(f => f.t) ?? [];
  const timesB = post.frames.map(f => f.t);

  const [ffmpeg, browser] = await Promise.all([ensureFfmpeg(), getBrowser()]);
  const ctx = await browser.newContext({ viewport: { width: layout.width, height: layout.height }, deviceScaleFactor: 1 });
  const encoder = startEncoder(ffmpeg, input.out, FPS);
  let last: Buffer | null = null;
  try {
    const page = await ctx.newPage();
    const cfg = {
      pad: PAD, header: HEADER, footer: FOOTER, name: input.name,
      paneWidth: layout.paneWidth, paneHeight: layout.paneHeight, scale: layout.scale,
      labels: labels ??= { pre: labelUri('pre'), post: labelUri('post') },
    };
    await page.setContent(`<!doctype html><body style="margin:0"><canvas id="c" width="${layout.width}" height="${layout.height}"></canvas>`
      + `<script>window.__cfg = ${JSON.stringify(cfg)};${PAGE_SCRIPT}</script>`);
    await page.evaluate('window.init()');

    let sentA = -1;
    let sentB = -1;
    let lastKey = '';
    for (const tick of ticks) {
      const ia = pre ? frameAt(timesA, tick.a) : -1;
      const ib = frameAt(timesB, tick.b);
      const aCard = (!pre || tick.aMissing) && input.preCard ? input.preCard : null;
      const pointers = pointersFor(tick, steps, pre?.pointers ?? [], post.pointers);
      const caption = captionFor(tick, steps);
      // An unchanged picture is the same JPEG: most of a clip is a page
      // holding still between steps, and those ticks cost nothing to draw.
      const key = `${ia}|${ib}|${aCard ? 1 : 0}|${caption}|${pointers.map(p => `${p.side}${Math.round(p.p * 20)}`).join()}`;
      if (key !== lastKey || !last) {
        // Only a frame the page is not already showing crosses over.
        const a = ia >= 0 && ia !== sentA ? pre!.frames[ia].data.toString('base64') : null;
        const b = ib >= 0 && ib !== sentB ? post.frames[ib].data.toString('base64') : null;
        sentA = ia;
        sentB = ib;
        const jpeg = await page.evaluate(t => (window as unknown as { draw: (t: unknown) => Promise<string> }).draw(t), {
          a, b, aCard, pointers, caption,
        });
        last = Buffer.from(jpeg, 'base64');
        lastKey = key;
      }
      await encoder.write(last);
    }
    await encoder.finish();
  } catch (err) {
    await encoder.finish().catch(() => undefined);
    throw err;
  } finally {
    await ctx.close().catch(() => undefined);
  }
  if (last) fs.writeFileSync(input.poster, last);
  const durationMs = timelineDuration(ticks, FPS);
  const bytes = await fitSize(ffmpeg, input.out, durationMs);
  return { durationMs, bytes };
}
