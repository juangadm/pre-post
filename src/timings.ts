/**
 * Where a run's wall clock went, one named step at a time.
 *
 * A run is only "slow" in the aggregate until something says which step ate
 * the time; this is that something. Steps come in three kinds, and the summary
 * keeps them apart so its numbers add up:
 *
 * - main steps, one after another, which sum to the total;
 * - dotted steps (`pre.boot`, `post.boot`), which ran inside a main step as
 *   side-by-side lanes, and so are part of that step's time, not extra to it;
 * - background steps (the browser download), which overlapped the main line.
 */

export interface StepOptions {
  /** Ran alongside the main line rather than on it. */
  background?: boolean;
  /** Lane prefixes (`pre`, `post`) whose dotted steps ran inside this one. */
  contains?: string[];
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

export class Stopwatch {
  private readonly steps = new Map<string, number>();
  private readonly background = new Set<string>();
  /** Lane prefix → the main step it ran inside. */
  private readonly parents = new Map<string, string>();

  /** Record `ms` against `name`, adding to anything already recorded there. */
  add(name: string, ms: number, opts: StepOptions = {}): void {
    this.steps.set(name, (this.steps.get(name) ?? 0) + Math.max(0, Math.round(ms)));
    if (opts.background) this.background.add(name);
    for (const prefix of opts.contains ?? []) this.parents.set(prefix, name);
  }

  /** Time a promise under `name`, whether it resolves or throws. */
  async time<T>(name: string, work: Promise<T> | (() => Promise<T>), opts: StepOptions = {}): Promise<T> {
    const start = Date.now();
    try {
      return await (typeof work === 'function' ? work() : work);
    } finally {
      this.add(name, Date.now() - start, opts);
    }
  }

  toJSON(): Record<string, number> {
    return Object.fromEntries(this.steps);
  }

  /**
   * Lines for the log, e.g.
   *
   *     Total 14.9s = github 0.3s + resolve 9.2s + capture 1.9s + other 3.5s
   *       inside resolve 9.2s, side by side: pre checkout 0.0s → boot 4.5s (4.5s) ‖ post boot 2.1s (2.1s)
   *       alongside: browser 0.6s
   *
   * With `totalMs`, the first line always sums to it: whatever no step
   * recorded is shown as `other` rather than left for the reader to find.
   */
  summary(totalMs?: number): string[] {
    const entries = [...this.steps];
    const main = entries.filter(([name]) => !name.includes('.') && !this.background.has(name));
    const parts = main.map(([name, ms]) => `${name} ${secs(ms)}`);
    let first = parts.join(' + ');
    if (totalMs !== undefined) {
      const other = Math.max(0, totalMs - main.reduce((sum, [, ms]) => sum + ms, 0));
      first = `Total ${secs(totalMs)} = ${[...parts, `other ${secs(other)}`].join(' + ')}`;
    }
    const lines = [first];

    // Group dotted steps into lanes, and lanes under the step that held them.
    const lanes = new Map<string, Array<[string, number]>>();
    for (const [name, ms] of entries) {
      if (!name.includes('.')) continue;
      const prefix = name.slice(0, name.indexOf('.'));
      lanes.set(prefix, [...(lanes.get(prefix) ?? []), [name.slice(prefix.length + 1), ms]]);
    }
    const byParent = new Map<string, string[]>();
    for (const [prefix, steps] of lanes) {
      const parent = this.parents.get(prefix) ?? '';
      const total = steps.reduce((sum, [, ms]) => sum + ms, 0);
      const lane = `${prefix} ${steps.map(([name, ms]) => `${name} ${secs(ms)}`).join(' → ')} (${secs(total)})`;
      byParent.set(parent, [...(byParent.get(parent) ?? []), lane]);
    }
    for (const [parent, laneTexts] of byParent) {
      const held = parent && this.steps.has(parent) ? `inside ${parent} ${secs(this.steps.get(parent)!)}, side by side` : 'nested';
      lines.push(`  ${held}: ${laneTexts.join(' ‖ ')}`);
    }

    const background = entries.filter(([name]) => this.background.has(name));
    if (background.length) lines.push(`  alongside: ${background.map(([name, ms]) => `${name} ${secs(ms)}`).join(', ')}`);
    return lines;
  }
}
