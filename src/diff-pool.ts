/**
 * A small worker pool for pixel diffs. Runs inline when worker threads are
 * unavailable (e.g. executing from TypeScript sources under a test runner).
 */

import os from 'os';
import { Worker } from 'worker_threads';
import { DiffJob, DiffJobResult, executeDiffJob } from './diff-worker.js';

type Pending = { job: DiffJob; resolve: (r: DiffJobResult) => void; reject: (e: Error) => void };
type Slot = { worker: Worker; busy: Pending | null };

function runInline(p: Pending): void {
  try {
    p.resolve(executeDiffJob(p.job));
  } catch (e) {
    p.reject(e as Error);
  }
}

export class DiffPool {
  private workers: Slot[] = [];
  private queue: Pending[] = [];
  private inline = false;

  constructor(private readonly size = Math.max(1, Math.min(4, os.cpus().length - 1))) {}

  run(job: DiffJob): Promise<DiffJobResult> {
    return new Promise<DiffJobResult>((resolve, reject) => {
      this.queue.push({ job, resolve, reject });
      this.pump();
    });
  }

  private spawn(): Slot | null {
    try {
      const worker = new Worker(new URL('./diff-worker.js', import.meta.url));
      const slot: Slot = { worker, busy: null };
      worker.on('message', (msg: DiffJobResult) => {
        const pending = slot.busy;
        slot.busy = null;
        if (pending) {
          if (msg.error) pending.reject(new Error(msg.error));
          else pending.resolve(msg);
        }
        this.pump();
      });
      worker.on('error', () => {
        // The worker died: finish its job inline and stop using workers if none are left.
        const pending = slot.busy;
        slot.busy = null;
        this.workers = this.workers.filter(w => w !== slot);
        if (pending) runInline(pending);
        if (this.workers.length === 0) this.inline = true;
        this.pump();
      });
      this.workers.push(slot);
      return slot;
    } catch {
      this.inline = true;
      return null;
    }
  }

  private pump(): void {
    while (this.queue.length) {
      if (this.inline) {
        runInline(this.queue.shift()!);
        continue;
      }
      let slot = this.workers.find(w => !w.busy);
      if (!slot && this.workers.length < this.size) slot = this.spawn() ?? undefined;
      if (!slot) {
        if (this.inline) continue; // spawn failed: drain inline
        return; // all workers busy: wait for a message
      }
      const pending = this.queue.shift()!;
      slot.busy = pending;
      const { before, after } = pending.job;
      slot.worker.postMessage(pending.job, [before.buffer, after.buffer]);
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map(w => w.worker.terminate()));
    this.workers = [];
  }
}
