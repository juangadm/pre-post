/**
 * Is the pre-post an agent follows the pre-post it runs?
 *
 * Three things drift apart silently. A skill file copied into ~/.claude once
 * keeps describing the CLI of that day: a field test found one saying "posts a
 * PR comment" and allowing `@latest` two releases after both stopped being
 * true. A `commands/pre-post.md` shadows the skill outright. And a project can
 * pin an old range in its devDependencies while `npx …@x.y.z` runs another.
 * Deleting stale copies by hand did not hold — one came back — so the tool
 * reports what it finds on every run instead.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { readPackage } from './pkg.js';

const require = createRequire(import.meta.url);

export const PACKAGE_NAME = '@juangadm/pre-post';

/** The version of this CLI. */
export function ownVersion(): string {
  return (require('../package.json') as { version: string }).version;
}

export interface SkillCopy {
  path: string;
  /** The release it was written for, or null when it does not say. */
  version: string | null;
  /** A command file, which takes precedence over the skill of the same name. */
  command: boolean;
}

/** Where Claude Code looks for a pre-post skill or command, user-wide and per project. */
export function skillLocations(home: string, repoRoot?: string): Array<{ path: string; command: boolean }> {
  const bases = [path.join(home, '.claude'), ...(repoRoot ? [path.join(repoRoot, '.claude')] : [])];
  return bases.flatMap(base => [
    { path: path.join(base, 'skills', 'pre-post', 'SKILL.md'), command: false },
    { path: path.join(base, 'commands', 'pre-post.md'), command: true },
  ]);
}

/** The release a skill file was written for: its `version:` field, else the version its npx lines pin. */
export function skillVersion(text: string): string | null {
  const field = text.match(/^version:\s*["']?([\w.+-]+)["']?\s*$/m)?.[1];
  if (field) return field;
  const pins = [...text.matchAll(/@juangadm\/pre-post@([\w.+-]+)/g)].map(m => m[1]);
  return pins.length && pins.every(p => p === pins[0]) && pins[0] !== 'latest' ? pins[0] : null;
}

export function installedSkills(home = os.homedir(), repoRoot?: string): SkillCopy[] {
  const found: SkillCopy[] = [];
  for (const loc of skillLocations(home, repoRoot)) {
    let text: string;
    try {
      text = fs.readFileSync(loc.path, 'utf8');
    } catch {
      continue;
    }
    found.push({ path: loc.path, version: skillVersion(text), command: loc.command });
  }
  return found;
}

/**
 * Does `version` satisfy a package.json range? Covers what projects write for
 * a CLI devDependency — exact, `^`, `~`, `>=`, `*`, `latest` — and treats
 * anything else as satisfied, so an unusual range never produces a false alarm.
 */
export function satisfies(version: string, range: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split(/[.-]/).slice(0, 3).map(n => Number(n) || 0);
  const cmp = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const r = range.trim();
  if (r === '*' || r === '' || r === 'latest') return true;
  const m = r.match(/^(\^|~|>=|=)?\s*v?(\d+(?:\.\d+){0,2})$/);
  if (!m) return true;
  const [op, base] = [m[1] ?? '=', parse(m[2])];
  const v = parse(version);
  if (cmp(v, base) < 0) return false;
  if (op === '>=') return true;
  if (op === '=') return cmp(v, base) === 0;
  if (op === '~') return v[0] === base[0] && v[1] === base[1];
  // ^: same major, or same minor when the major is 0.
  return base[0] === 0 ? v[0] === 0 && v[1] === base[1] : v[0] === base[0];
}

/** One sentence per drift found; empty when everything agrees with this CLI. */
export function driftNotes(opts: { version?: string; home?: string; repoRoot?: string } = {}): string[] {
  const version = opts.version ?? ownVersion();
  const notes: string[] = [];
  const copies = installedSkills(opts.home, opts.repoRoot);
  for (const copy of copies) {
    if (copy.version === version) continue;
    notes.push(`${copy.path} was written for ${copy.version ? `pre-post ${copy.version}` : 'an unversioned pre-post'}, not ${version}; update or delete it.`);
  }
  const shadowing = copies.find(c => c.command);
  if (shadowing && copies.some(c => !c.command)) {
    notes.push(`${shadowing.path} overrides the pre-post skill; delete it unless you mean it to.`);
  }
  if (opts.repoRoot) {
    const pkg = readPackage(opts.repoRoot);
    const range = pkg?.devDependencies?.[PACKAGE_NAME] ?? pkg?.dependencies?.[PACKAGE_NAME];
    if (typeof range === 'string' && !satisfies(version, range)) {
      notes.push(`package.json pins ${PACKAGE_NAME} ${range}, but this run is ${version}; update the range or run the pinned version.`);
    }
  }
  return notes;
}
