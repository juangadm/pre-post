/**
 * Where a run's wall clock went, one named step at a time.
 *
 * A run is only "slow" in the aggregate until something says which step ate
 * the time; this is that something. Steps overlap (the browser launches while
 * the servers boot), so the entries are durations, not slices of a total.
 */
export class Stopwatch {
  private readonly steps = new Map<string, number>();

  /** Record `ms` against `name`, adding to anything already recorded there. */
  add(name: string, ms: number): void {
    this.steps.set(name, (this.steps.get(name) ?? 0) + Math.max(0, Math.round(ms)));
  }

  /** Time a promise under `name`, whether it resolves or throws. */
  async time<T>(name: string, work: Promise<T> | (() => Promise<T>)): Promise<T> {
    const start = Date.now();
    try {
      return await (typeof work === 'function' ? work() : work);
    } finally {
      this.add(name, Date.now() - start);
    }
  }

  /** A synchronous step. */
  timeSync<T>(name: string, work: () => T): T {
    const start = Date.now();
    try {
      return work();
    } finally {
      this.add(name, Date.now() - start);
    }
  }

  toJSON(): Record<string, number> {
    return Object.fromEntries(this.steps);
  }

  /** One line for the log, e.g. `github 0.4s · pre.install 31.2s · capture 3.3s`. */
  summary(): string {
    return [...this.steps].map(([name, ms]) => `${name} ${(ms / 1000).toFixed(1)}s`).join(' · ');
  }
}
