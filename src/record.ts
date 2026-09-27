/**
 * Record one side of a Moment: load the page, then play its steps while the
 * browser streams frames.
 *
 * Frames come from CDP `Page.startScreencast`, which sends a frame only when
 * pixels change — about every 17 ms during a transition, nothing while the
 * page sits still (measured; docs/internal/video-spike.md). Playwright's own
 * `recordVideo` was the alternative: fixed at 25 fps and recording from the
 * moment the context opens, load and all.
 *
 * Every step's start time is marked, so `timeline.ts` can line the two sides
 * up step by step. A step that fails ends the recording at the moment it
 * began: the seconds spent looking for a button that is not there are not
 * something a reviewer should watch.
 */

import type { CDPSession, Locator, Page } from 'playwright-core';
import { AuthOptions, ViewportSize } from './types.js';
import { gotoChecked, hideDevIndicator, settlePage, withMotionPage } from './browser.js';
import { Moment, Step } from './moments.js';
import { SideTiming } from './timeline.js';

/** Still frames before the first step, so the viewer sees the page first. */
export const LEAD_IN_MS = 500;
/** After each step, so its result is on screen before the next one starts. */
export const BREATH_MS = 400;
/** After the last step, so the clip ends on the result. */
export const TAIL_MS = 1000;
/** A Moment with no steps records this much of the page loading, for entrance animations. */
export const LOAD_ONLY_MS = 3000;
/**
 * How long a step looks for its target. Short, because a missing target is
 * the normal case on Pre for a new feature, and every second spent looking is
 * a second the whole run waits.
 */
export const FIND_TIMEOUT_MS = 3000;
/** How long a found target's action (click, hover, typing) may take. */
export const STEP_TIMEOUT_MS = 5000;
/** A smooth scroll's travel time. */
const SCROLL_MS = 700;
/** Typed one key at a time, slow enough to read. */
const TYPE_DELAY_MS = 45;
const SETTLE_MS = 8000;

export interface Frame {
  t: number;
  data: Buffer;
}

/** Where a pointer step acted, in viewport CSS pixels, for the click marker. */
export interface PointerMark {
  step: number;
  x: number;
  y: number;
}

export interface SideRecording extends SideTiming {
  viewport: ViewportSize;
  frames: Frame[];
  pointers: PointerMark[];
  /** HTTP status of the page. */
  status?: number;
  /** The step that could not be done, and why, in plain words. */
  failure?: { step: number; message: string };
}

export class StepError extends Error {}

const ROLES = ['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'checkbox', 'radio', 'switch', 'textbox', 'searchbox', 'combobox'] as const;

/**
 * Candidate locators for a target, most specific first.
 *
 * Steps name what a person sees ("Save", "Email"), so the accessible name of
 * something interactive is tried first, then a field's label or placeholder,
 * then exact visible text, then the same things loosely. `css=` skips all of
 * it for the rare case plain words cannot say.
 */
function candidates(page: Page, target: string): Locator[] {
  if (target.startsWith('css=')) return [page.locator(target.slice(4))];
  const byRole = (exact: boolean) => ROLES.map(role => page.getByRole(role, { name: target, exact })).reduce((a, b) => a.or(b));
  return [
    byRole(true),
    page.getByLabel(target, { exact: true }).or(page.getByPlaceholder(target, { exact: true })),
    page.getByText(target, { exact: true }),
    byRole(false).or(page.getByLabel(target)).or(page.getByPlaceholder(target)).or(page.getByText(target)),
  ];
}

/**
 * The visible element a step means, waiting for it to appear — a menu item
 * exists only once the menu is open, and the step before just opened it.
 */
async function resolveTarget(page: Page, target: string): Promise<Locator> {
  const deadline = Date.now() + FIND_TIMEOUT_MS;
  const tiers = candidates(page, target).map(l => l.filter({ visible: true }));
  for (;;) {
    // All tiers at once, most specific match wins: one round trip per poll,
    // not four, while the page is being recorded.
    const counts = await Promise.all(tiers.map(t => t.count().catch(() => 0)));
    const hit = counts.findIndex(n => n > 0);
    if (hit !== -1) return tiers[hit].first();
    if (Date.now() >= deadline) throw new StepError(`Couldn't find “${target}”`);
    await page.waitForTimeout(100);
  }
}

async function pointAt(locator: Locator, step: number, pointers: PointerMark[]): Promise<void> {
  const box = await locator.boundingBox().catch(() => null);
  if (box) pointers.push({ step, x: box.x + box.width / 2, y: box.y + box.height / 2 });
}

async function act(what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    throw new StepError(`Couldn't ${what}`);
  }
}

async function runStep(page: Page, step: Step, index: number, pointers: PointerMark[]): Promise<void> {
  if (step.verb === 'wait') return page.waitForTimeout(step.ms);
  if (step.verb === 'press') return act(`press ${step.key}`, () => page.keyboard.press(step.key));
  if (step.verb === 'scroll' && !step.target) {
    // Smooth on purpose: a jump cut reads as a different page. Explicit
    // `behavior: 'smooth'` wins over the init script's scroll-behavior rule.
    await page.evaluate(px => window.scrollBy({ top: px, behavior: 'smooth' }), step.px!);
    return page.waitForTimeout(SCROLL_MS);
  }
  const target = step.target!;
  const el = await resolveTarget(page, target);
  const quoted = `“${target}”`;
  switch (step.verb) {
    case 'scroll':
      await act(`scroll to ${quoted}`, () => el.evaluate(node => node.scrollIntoView({ behavior: 'smooth', block: 'center' })));
      return page.waitForTimeout(SCROLL_MS);
    case 'click':
      await pointAt(el, index, pointers);
      return act(`click ${quoted}`, () => el.click({ timeout: STEP_TIMEOUT_MS }));
    case 'hover':
      await pointAt(el, index, pointers);
      return act(`hover ${quoted}`, () => el.hover({ timeout: STEP_TIMEOUT_MS }));
    case 'type':
      await pointAt(el, index, pointers);
      return act(`type into ${quoted}`, async () => {
        await el.click({ timeout: STEP_TIMEOUT_MS });
        await el.pressSequentially(step.text, { delay: TYPE_DELAY_MS, timeout: STEP_TIMEOUT_MS + step.text.length * TYPE_DELAY_MS });
      });
  }
}

/**
 * The screencast's own frame clock, in ms, when it agrees with ours. Its
 * timestamp is seconds since the epoch; if a browser ever sends something
 * else, the arrival time is close enough.
 */
function frameTime(seconds: number | undefined): number {
  const now = Date.now();
  const t = typeof seconds === 'number' ? seconds * 1000 : NaN;
  return Number.isFinite(t) && Math.abs(t - now) < 5000 ? t : now;
}

/**
 * Stream frames into `frames` until the returned stop is called. Frames are
 * sent at `maxWidth`, the width they will be drawn at, not the page's: a
 * desktop page is shown in an 800px pane, and shipping and holding the full
 * size would be most of the memory a recording uses.
 */
async function startScreencast(cdp: CDPSession, viewport: ViewportSize, maxWidth: number, frames: Frame[]): Promise<() => Promise<void>> {
  let open = true;
  cdp.on('Page.screencastFrame', f => {
    if (open) frames.push({ t: frameTime(f.metadata.timestamp), data: Buffer.from(f.data, 'base64') });
    // The browser sends the next frame only once this one is acknowledged.
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
  });
  const scale = Math.min(1, maxWidth / viewport.width);
  await cdp.send('Page.startScreencast', {
    format: 'jpeg', quality: 85, everyNthFrame: 1,
    maxWidth: Math.round(viewport.width * scale), maxHeight: Math.round(viewport.height * scale),
  });
  return async () => {
    open = false;
    await cdp.send('Page.stopScreencast').catch(() => undefined);
  };
}

/**
 * Record `moment` on `url`. Throws NavigationError / HttpStatusError when the
 * page cannot be loaded; returns a recording with `failure` set when a step
 * cannot be done. A page that answers 4xx/5xx comes back with its status and
 * no frames, for the caller to phrase.
 */
export async function recordSide(url: string, moment: Moment, viewport: ViewportSize, opts: { auth?: AuthOptions; maxWidth: number }): Promise<SideRecording> {
  const { auth, maxWidth } = opts;
  return withMotionPage(viewport, auth, async (page, ctx) => {
    const frames: Frame[] = [];
    const pointers: PointerMark[] = [];
    const marks: number[] = [];
    const cdp = await ctx.newCDPSession(page);
    const loadOnly = moment.steps.length === 0;

    const { status } = await gotoChecked(page, url);
    if (status !== undefined && status >= 400) {
      const now = Date.now();
      return { viewport, frames, pointers, marks, start: now, end: now, status };
    }

    // A load-only Moment is about the load, so recording starts at once. Any
    // other starts on a settled page: how fast each side loaded is not the change.
    if (!loadOnly) {
      await settlePage(page, SETTLE_MS);
      await hideDevIndicator(page);
    }
    // The screencast sends nothing until something paints, and a settled page
    // paints nothing. Seed the stream with what is on screen now.
    const start = Date.now();
    const first = await page.screenshot({ type: 'jpeg', quality: 85, timeout: 10_000 }).catch(() => null);
    if (first) frames.push({ t: start, data: first });
    const stop = await startScreencast(cdp, viewport, maxWidth, frames);

    let failure: (SideRecording['failure'] & { at: number }) | undefined;
    await page.waitForTimeout(loadOnly ? LOAD_ONLY_MS : LEAD_IN_MS);
    for (let i = 0; i < moment.steps.length; i++) {
      const began = Date.now();
      try {
        await runStep(page, moment.steps[i], i, pointers);
      } catch (err) {
        failure = { step: i, message: err instanceof StepError ? err.message : `Step ${i + 1} failed`, at: began };
        break;
      }
      marks.push(began);
      if (moment.steps[i].verb !== 'wait') await page.waitForTimeout(BREATH_MS);
    }
    if (!failure && !loadOnly) await page.waitForTimeout(TAIL_MS);
    await stop();
    const end = failure?.at ?? Date.now();
    // Nothing after `end` is ever shown — for a failed step, that is every
    // frame of the search — so it is not carried into the compositor.
    const shown = frames.filter(f => f.t <= end).sort((a, b) => a.t - b.t);
    return {
      viewport, frames: shown, pointers, marks, start, end, status,
      failure: failure && { step: failure.step, message: failure.message },
    };
  });
}
