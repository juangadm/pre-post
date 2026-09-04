/**
 * Vertical displacement between two captures.
 *
 * A padding change near the top of a page moves everything below it. Pixel
 * diffing counts every moved pixel as changed, so a change a designer would
 * call "slightly roomier" reads as 60-90% of the page repainted — and above
 * CROP_MAX_RATIO no crop is produced at all, so the most dramatic-looking
 * result gives a reviewer the least to look at.
 *
 * A layout shift always has a start: content above the changed element stays
 * put and content below it moves by a constant amount. Recovering that pair
 * (how far, from where) turns the repaint back into a sentence — "content
 * shifted down 48px" — and lets the diff run on aligned images, which is the
 * change the branch actually made.
 *
 * Rows are matched by hash rather than correlated numerically: a shifted page
 * re-renders its rows identically, so exact matches carry the signal and cost
 * one pass over the pixels.
 */

import { PNG } from 'pngjs';

/** A row hash seen more often than this in either image carries no position information. */
const MAX_ROW_REPEATS = 4;
/** Below this many distinctive rows there is not enough signal to trust an offset. */
const MIN_DISTINCTIVE_ROWS = 16;
/** An offset supported by fewer rows than this is noise. */
const MIN_MOVED_ROWS = 8;

export interface ShiftCandidate {
  /** Device pixels the Post content moved down by; negative means up. */
  dy: number;
  /** First row (in Pre coordinates) that moved. Rows above it stayed put. */
  from: number;
  /** Rows the offset explains, as a fraction of all distinctive rows. */
  coverage: number;
}

/**
 * FNV-1a over each row's bytes. Distinct content gives distinct hashes; the
 * collision rate over a few thousand rows is negligible, and a collision can
 * only add a stray vote to an offset that other rows have to agree on anyway.
 */
export function rowHashes(png: PNG): Uint32Array {
  const { width, height, data } = png;
  const stride = width * 4;
  const out = new Uint32Array(height);
  for (let y = 0; y < height; y++) {
    let h = 0x811c9dc5;
    const start = y * stride;
    for (let i = start; i < start + stride; i++) {
      h ^= data[i];
      h = Math.imul(h, 0x01000193);
    }
    out[y] = h >>> 0;
  }
  return out;
}

function countHashes(hashes: Uint32Array): Map<number, number> {
  const counts = new Map<number, number>();
  for (const h of hashes) counts.set(h, (counts.get(h) ?? 0) + 1);
  return counts;
}

/**
 * Find a single vertical displacement that explains the difference between two
 * equally sized images, or null when none does.
 *
 * Rows that repeat (blank space, flat backgrounds, rules) are dropped first:
 * they match every offset equally and would otherwise outvote the content.
 * What remains votes for the offset that maps it from Pre to Post, and the
 * winner has to be supported by enough rows to mean something.
 */
export function detectShift(before: PNG, after: PNG): ShiftCandidate | null {
  if (before.width !== after.width || before.height !== after.height) return null;
  const height = before.height;

  const beforeHashes = rowHashes(before);
  const afterHashes = rowHashes(after);
  const beforeCounts = countHashes(beforeHashes);
  const afterCounts = countHashes(afterHashes);

  const distinctive = (h: number): boolean =>
    (beforeCounts.get(h) ?? 0) > 0 &&
    (beforeCounts.get(h) ?? 0) <= MAX_ROW_REPEATS &&
    (afterCounts.get(h) ?? 0) <= MAX_ROW_REPEATS;

  // Where each distinctive row sits in Pre, so Post rows can look it up.
  const beforeRows = new Map<number, number[]>();
  for (let y = 0; y < height; y++) {
    const h = beforeHashes[y];
    if (!distinctive(h)) continue;
    const list = beforeRows.get(h);
    if (list) list.push(y); else beforeRows.set(h, [y]);
  }

  const votes = new Map<number, number>();
  let distinctiveRows = 0;
  for (let y = 0; y < height; y++) {
    const h = afterHashes[y];
    if (!distinctive(h)) continue;
    distinctiveRows++;
    const origins = beforeRows.get(h);
    if (!origins) continue;
    for (const origin of origins) {
      const d = y - origin;
      votes.set(d, (votes.get(d) ?? 0) + 1);
    }
  }
  if (distinctiveRows < MIN_DISTINCTIVE_ROWS) return null;

  let dy = 0;
  let moved = 0;
  for (const [d, count] of votes) {
    if (d === 0) continue;
    if (count > moved) { dy = d; moved = count; }
  }
  if (dy === 0 || moved < MIN_MOVED_ROWS) return null;

  // Where the movement starts: the first Pre row that maps to Post at the
  // winning offset and never goes back to sitting still. Everything above it
  // is content the change did not move.
  const stayed = new Set<number>();
  const shifted = new Set<number>();
  for (let y = 0; y < height; y++) {
    const h = beforeHashes[y];
    if (!distinctive(h)) continue;
    if (afterHashes[y] === h) stayed.add(y);
    if (y + dy >= 0 && y + dy < height && afterHashes[y + dy] === h) shifted.add(y);
  }
  let from = height;
  for (let y = height - 1; y >= 0; y--) {
    if (shifted.has(y)) from = y;
    else if (stayed.has(y)) break;
  }
  if (from >= height) return null;

  return { dy, from, coverage: moved / distinctiveRows };
}

/**
 * Rebuild Post with its shifted content put back where Pre has it, so the two
 * can be compared for what changed other than the move.
 *
 * Rows the shift leaves without a source are filled with the padding colour,
 * which is what Pre holds there too: a page that grew by `dy` is padded over
 * exactly the rows Post no longer reaches.
 */
export function alignImage(after: PNG, shift: ShiftCandidate, pad: [number, number, number]): PNG {
  const { width, height } = after;
  const out = new PNG({ width, height });
  const stride = width * 4;
  for (let y = 0; y < height; y++) {
    const source = y < shift.from ? y : y + shift.dy;
    const target = y * stride;
    if (source >= 0 && source < height) {
      after.data.copy(out.data, target, source * stride, source * stride + stride);
    } else {
      for (let i = target; i < target + stride; i += 4) {
        out.data[i] = pad[0]; out.data[i + 1] = pad[1]; out.data[i + 2] = pad[2]; out.data[i + 3] = 255;
      }
    }
  }
  return out;
}
