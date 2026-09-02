/**
 * Worker-thread entry: diff two PNGs held in memory and write every output.
 * Keeps pixel work and file I/O off the main thread so captures keep flowing.
 */

import fs from 'fs';
import { parentPort } from 'worker_threads';
import { diffImages, DiffOptions } from './diff.js';

export interface DiffJob {
  /** PNG bytes; transferred to the worker, so the caller must not reuse them. */
  before: Uint8Array;
  after: Uint8Array;
  /** Where to write pre, post, diff, and (when produced) crops. */
  outputs: { before: string; after: string; diff: string; cropBefore: string; cropAfter: string };
  options?: DiffOptions;
}

export interface DiffJobResult {
  changedRatio: number;
  changedPixels: number;
  sizeChanged: boolean;
  hasCrop: boolean;
  hasHighlight: boolean;
  error?: string;
}

export function executeDiffJob(job: DiffJob): DiffJobResult {
  const before = Buffer.from(job.before.buffer, job.before.byteOffset, job.before.byteLength);
  const after = Buffer.from(job.after.buffer, job.after.byteOffset, job.after.byteLength);
  fs.writeFileSync(job.outputs.before, before);
  fs.writeFileSync(job.outputs.after, after);
  const result = diffImages(before, after, job.options);
  if (result.highlight) fs.writeFileSync(job.outputs.diff, result.highlight);
  if (result.crop) {
    fs.writeFileSync(job.outputs.cropBefore, result.crop.before);
    fs.writeFileSync(job.outputs.cropAfter, result.crop.after);
  }
  return {
    changedRatio: result.changedRatio,
    changedPixels: result.changedPixels,
    sizeChanged: result.sizeChanged,
    hasCrop: Boolean(result.crop),
    hasHighlight: Boolean(result.highlight),
  };
}

if (parentPort) {
  parentPort.on('message', (job: DiffJob) => {
    try {
      parentPort!.postMessage(executeDiffJob(job));
    } catch (err) {
      parentPort!.postMessage({ error: (err as Error).message } as DiffJobResult);
    }
  });
}
