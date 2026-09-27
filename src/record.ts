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
import { hideDevIndicator, settle, withMotionPage } from './browser.js';
import { HttpStatusError, isVercelResponse, NavigationError } from './errors.js';
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
    for (const tier of tiers) {
      if (await tier.count().catch(() => 0)) return tier.first();
    }
    if (Date.now() >= deadline) throw new StepError(`Couldn't find “${target}”`);
    await page.waitForTimeout(100);
  }
}

async function pointAt(locator: Locator, step: number, pointers: PointerMark[]): Promise<void> {
  const box = await locator.boundingBox().catch(() => null);
  if (box) pointers.push({ step, x: box.x + box.width / 2, y: box.y + box.height / 2 });
}

async function runStep(page: Page, step: Step, index: number, pointers: PointerMark[]): Promise<void> {
  const act = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      if (err instanceof StepError) throw err;
      throw new StepError(`Couldn't ${what}`);
    }
  };
  switch (step.verb) {
    case 'click': {
      const el = await resolveTarget(page, step.target);
      await pointAt(el, index, pointers);
      await act(`click “${step.target}”`, () => el.click({ timeout: STEP_TIMEOUT_MS }));
      return;
    }
    case 'hover': {
      const el = await resolveTarget(page, step.target);
      await pointAt(el, index, pointers);
      await act(`hover “${step.target}”`, () => el.hover({ timeout: STEP_TIMEOUT_MS }));
      return;
    }
    case 'type': {
      const el = await resolveTarget(page, step.target);
      await pointAt(el, index, pointers);
      await act(`type into “${step.target}”`, async () => {
        await el.click({ timeout: STEP_TIMEOUT_MS });
        await el.pressSequentially(step.text, { delay: TYPE_DELAY_MS, timeout: STEP_TIMEOUT_MS + step.text.length * TYPE_DELAY_MS });
      });
      return;
    }
    case 'press':
      await act(`press ${step.key}`, () => page.keyboard.press(step.key));
      return;
    case 'scroll': {
      // Smooth on purpose: a jump cut reads as a different page. Explicit
      // `behavior: 'smooth'` wins over the init script's scroll-behavior rule.
      if (step.target) {
        const el = await resolveTarget(page, step.target);
        await act(`scroll to “${step.target}”`, () => el.evaluate(node => node.scrollIntoView({ behavior: 'smooth', block: 'center' })));
      } else {
        await page.evaluate(px => window.scrollBy({ top: px, behavior: 'smooth' }), step.px!);
      }
      await page.waitForTimeout(SCROLL_MS);
      return;
    }
    case 'wait':
      await page.waitForTimeout(step.ms);
      return;
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

async function startScreencast(cdp: CDPSession, viewport: ViewportSize, frames: Frame[]): Promise<void> {
  cdp.on('Page.screencastFrame', f => {
    frames.push({ t: frameTime(f.metadata.timestamp), data: Buffer.from(f.data, 'base64') });
    // The browser sends the next frame only once this one is acknowledged.
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg', quality: 85, maxWidth: viewport.width, maxHeight: viewport.height, everyNthFrame: 1,
  });
}

/**
 * Record `moment` on `url`. Throws NavigationError / HttpStatusError when the
 * page cannot be loaded; returns a recording with `failure` set when a step
 * cannot be done. A page that answers 4xx/5xx comes back with its status and
 * no frames, for the caller to phrase.
 */
export async function recordSide(url: string, moment: Moment, viewport: ViewportSize, auth?: AuthOptions): Promise<SideRecording> {
  return withMotionPage(viewport, auth, async (page, ctx) => {
    const frames: Frame[] = [];
    const pointers: PointerMark[] = [];
    const marks: number[] = [];
    const cdp = await ctx.newCDPSession(page);
    const loadOnly = moment.steps.length === 0;

    const response = await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(err => {
      throw new NavigationError(/Timeout .* exceeded/.test(err?.message ?? '') ? 'timeout' : /ERR_CONNECTION_REFUSED/.test(err?.message ?? '') ? 'refused' : 'other', url, err);
    });
    const status = response?.status();
    if (status === 401 || status === 403) {
      throw new HttpStatusError(status, url, response ? isVercelResponse({ get: n => response.headers()[n] ?? null }) : false);
    }
    if (status !== undefined && status >= 400) {
      const now = Date.now();
      return { viewport, frames, pointers, marks, start: now, end: now, status };
    }

    // A load-only Moment is about the load, so recording starts at once. Any
    // other starts on a settled page: how fast each side loaded is not the change.
    if (!loadOnly) {
      await settle(page, SETTLE_MS);
      await hideDevIndicator(page);
    }
    // The screencast sends nothing until something paints, and a settled page
    // paints nothing. Seed the stream with what is on screen now.
    const start = Date.now();
    const first = await page.screenshot({ type: 'jpeg', quality: 85, timeout: 10_000 }).catch(() => null);
    if (first) frames.push({ t: start, data: first });
    await startScreencast(cdp, viewport, frames);

    let failure: SideRecording['failure'];
    let end: number;
    if (loadOnly) {
      await page.waitForTimeout(LOAD_ONLY_MS);
      end = Date.now();
    } else {
      await page.waitForTimeout(LEAD_IN_MS);
      end = 0;
      for (let i = 0; i < moment.steps.length; i++) {
        const began = Date.now();
        marks.push(began);
        try {
          await runStep(page, moment.steps[i], i, pointers);
        } catch (err) {
          failure = { step: i, message: err instanceof StepError ? err.message : `Step ${i + 1} failed` };
          marks.pop();
          end = began;
          break;
        }
        if (moment.steps[i].verb !== 'wait') await page.waitForTimeout(BREATH_MS);
      }
      if (!failure) {
        await page.waitForTimeout(TAIL_MS);
        end = Date.now();
      }
    }
    await cdp.send('Page.stopScreencast').catch(() => undefined);
    frames.sort((a, b) => a.t - b.t);
    return { viewport, frames, pointers, marks, start, end, status, failure };
  });
}
