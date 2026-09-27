/**
 * Moments: short, named interactions recorded on Pre and Post and played side
 * by side in one clip.
 *
 * A screenshot cannot show a menu opening or a hover state; a recording of a
 * page sitting still shows nothing either (that is why the first GIF attempt
 * was parked). So the unit of video is an interaction a person would do —
 * "Open the account menu" — written as a few plain steps that target what the
 * person sees, not CSS.
 *
 * Everything here is pure: parsing, validation, choosing which Moments run,
 * and the sentences a reviewer reads. The browser side is `record.ts`.
 */

import fs from 'fs';
import path from 'path';

export type StepVerb = 'click' | 'hover' | 'type' | 'press' | 'scroll' | 'wait';

export type Step =
  | { verb: 'click' | 'hover'; target: string }
  | { verb: 'type'; target: string; text: string }
  | { verb: 'press'; key: string }
  | { verb: 'scroll'; target?: string; px?: number }
  | { verb: 'wait'; ms: number };

export interface Moment {
  /** What a reviewer reads above the clip, e.g. "Open the account menu". */
  name: string;
  route: string;
  /** Viewport preset or WxH. Default desktop. */
  viewport: string;
  steps: Step[];
}

/** As written in `.pre-post.json` or a `--moments` file. */
export interface MomentInput {
  name?: unknown;
  route?: unknown;
  viewport?: unknown;
  steps?: unknown;
}

/**
 * Moments per run. A big PR gets video for the few changes a reviewer most
 * needs to see move; every changed page still gets screenshots. Order is
 * priority: the first three run, the rest are named in one line.
 */
export const MAX_MOMENTS = 3;

/**
 * Past this a clip still ships, with a nudge to split it. Not a cap: length
 * comes only from the steps someone wrote, so nothing records for minutes on
 * its own, and a clip a reviewer can take in on one play is the goal.
 */
export const LONG_CLIP_MS = 30_000;

/** What a clip should aim for; used in the nudge. */
export const TARGET_CLIP_S = 15;

/** A `wait` longer than this is almost certainly a mistake (ms, not s). */
const MAX_WAIT_MS = 10_000;

const VERBS: StepVerb[] = ['click', 'hover', 'type', 'press', 'scroll', 'wait'];

export class MomentError extends Error {}

function fail(where: string, message: string): never {
  throw new MomentError(`${where}: ${message}`);
}

function parseStep(raw: unknown, where: string): Step {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(where, `expected a step like { "click": "Save" }, got ${JSON.stringify(raw)}`);
  }
  const keys = Object.keys(raw);
  if (keys.length !== 1 || !VERBS.includes(keys[0] as StepVerb)) {
    fail(where, `a step has exactly one of ${VERBS.join(', ')} (got ${keys.join(', ') || 'nothing'})`);
  }
  const verb = keys[0] as StepVerb;
  const value = (raw as Record<string, unknown>)[verb];
  const text = (v: unknown) => typeof v === 'string' && v.trim() ? v : null;
  switch (verb) {
    case 'click':
    case 'hover': {
      const target = text(value);
      if (!target) fail(where, `"${verb}" needs the text of what to ${verb}, e.g. { "${verb}": "Save" }`);
      return { verb, target };
    }
    case 'type': {
      if (!Array.isArray(value) || value.length !== 2 || !text(value[0]) || typeof value[1] !== 'string') {
        fail(where, '"type" needs [field, text], e.g. { "type": ["Email", "ada@example.com"] }');
      }
      return { verb, target: value[0], text: value[1] };
    }
    case 'press': {
      const key = text(value);
      if (!key) fail(where, '"press" needs a key, e.g. { "press": "Escape" }');
      return { verb, key };
    }
    case 'scroll': {
      if (typeof value === 'number' && Number.isFinite(value)) return { verb, px: value };
      const target = text(value);
      if (!target) fail(where, '"scroll" needs the text to scroll to, or a number of pixels');
      return { verb, target };
    }
    case 'wait': {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        fail(where, '"wait" needs milliseconds, e.g. { "wait": 600 }');
      }
      if (value > MAX_WAIT_MS) fail(where, `"wait" is in milliseconds; ${value} is over ${MAX_WAIT_MS / 1000}s`);
      return { verb, ms: value };
    }
  }
}

/** Validate one Moment. `where` names it in errors, e.g. "Moment 2". */
export function parseMoment(raw: MomentInput, where: string): Moment {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(where, 'expected an object with name, route and steps');
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) fail(where, 'needs a "name" — the caption a reviewer reads, e.g. "Open the account menu"');
  const label = `${where} ("${name}")`;
  const route = typeof raw.route === 'string' ? raw.route.trim() : '';
  if (!route.startsWith('/')) fail(label, 'needs a "route" starting with /, e.g. "/settings"');
  if (raw.viewport !== undefined && (typeof raw.viewport !== 'string' || !raw.viewport.trim())) {
    fail(label, '"viewport" is desktop, tablet, mobile or WxH');
  }
  if (raw.steps !== undefined && !Array.isArray(raw.steps)) fail(label, '"steps" is a list');
  const steps = ((raw.steps as unknown[] | undefined) ?? []).map((s, i) => parseStep(s, `${label} step ${i + 1}`));
  return { name, route, viewport: (raw.viewport as string | undefined)?.trim() || 'desktop', steps };
}

/** Validate a list of Moments, as found in config or a file. */
export function parseMoments(raw: unknown, source: string): Moment[] {
  const list = Array.isArray(raw) ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { moments?: unknown }).moments) ? (raw as { moments: unknown[] }).moments
      : fail(source, 'expected a list of Moments, or { "moments": [...] }');
  return list.map((m, i) => parseMoment(m as MomentInput, `${source}, Moment ${i + 1}`));
}

/** Read a `--moments` file. */
export function loadMomentsFile(file: string, cwd = process.cwd()): Moment[] {
  const full = path.resolve(cwd, file);
  let text: string;
  try {
    text = fs.readFileSync(full, 'utf-8');
  } catch {
    throw new MomentError(`Cannot read the Moments file ${file}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new MomentError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  return parseMoments(parsed, path.basename(file));
}

/** The Moments that run, in priority order, and the names of the rest. */
export function selectMoments(moments: Moment[], max = MAX_MOMENTS): { run: Moment[]; skipped: string[] } {
  return { run: moments.slice(0, max), skipped: moments.slice(max).map(m => m.name) };
}

function quote(s: string): string {
  return `“${s}”`;
}

/** A step as a reviewer would say it: `Click “Save”`. Shown under the clip. */
export function describeStep(step: Step): string {
  switch (step.verb) {
    case 'click': return `Click ${quote(step.target)}`;
    case 'hover': return `Hover ${quote(step.target)}`;
    case 'type': return `Type ${quote(step.text)} into ${quote(step.target)}`;
    case 'press': return `Press ${step.key}`;
    case 'scroll': return step.target ? `Scroll to ${quote(step.target)}` : `Scroll ${step.px! >= 0 ? 'down' : 'up'} ${Math.abs(step.px!)}px`;
    case 'wait': return 'Wait';
  }
}

/** What a step looks for, when it looks for anything — for "couldn't find" sentences. */
export function stepTarget(step: Step): string | undefined {
  return 'target' in step ? step.target : undefined;
}

/** One line for a clip that ran long, or null. */
export function longClipNote(name: string, durationMs: number): string | null {
  if (durationMs <= LONG_CLIP_MS) return null;
  return `${quote(name)} is ${Math.round(durationMs / 1000)}s — clips under ${TARGET_CLIP_S}s get watched; consider splitting it into smaller Moments.`;
}

/** One line naming the Moments over the limit, or null. */
export function skippedNote(skipped: string[], max = MAX_MOMENTS): string | null {
  if (!skipped.length) return null;
  return `Recorded the first ${max} Moments; also listed, not recorded: ${skipped.map(quote).join(', ')}.`;
}
