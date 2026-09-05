import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import { detectShift, alignBefore, insertedBand, rowHashes } from '../../src/shift';

const WHITE: [number, number, number] = [255, 255, 255];

/**
 * A page stand-in: `rows` gives each row a colour, so a row is either blank
 * (white, and repeated, so the detector must ignore it) or distinctive.
 */
function image(rows: number[], width = 8): PNG {
  const png = new PNG({ width, height: rows.length });
  rows.forEach((value, y) => {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      png.data[i] = value & 0xff;
      png.data[i + 1] = (value >> 8) & 0xff;
      png.data[i + 2] = (value >> 16) & 0xff;
      png.data[i + 3] = 255;
    }
  });
  return png;
}

/** 40 distinctive rows, enough to clear the detector's signal floor. */
const content = Array.from({ length: 40 }, (_, i) => i + 1);
const blank = (n: number) => Array.from({ length: n }, () => 0xffffff);

describe('rowHashes', () => {
  it('gives identical rows identical hashes and different rows different ones', () => {
    const png = image([1, 1, 2]);
    const hashes = rowHashes(png);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[0]).not.toBe(hashes[2]);
  });
});

describe('detectShift', () => {
  it('finds a downward shift and where it starts', () => {
    const before = image([...blank(10), ...content, ...blank(10)]);
    const after = image([...blank(20), ...content]);
    const shift = detectShift(before, after);
    expect(shift?.dy).toBe(10);
    expect(shift?.from).toBe(10);
  });

  it('finds an upward shift', () => {
    const before = image([...blank(20), ...content]);
    const after = image([...blank(10), ...content, ...blank(10)]);
    expect(detectShift(before, after)?.dy).toBe(-10);
  });

  it('leaves content above the shift where it is', () => {
    const top = content.slice(0, 12);
    const bottom = content.slice(12);
    const before = image([...top, ...bottom, ...blank(8)]);
    const after = image([...top, ...blank(8), ...bottom]);
    const shift = detectShift(before, after);
    expect(shift?.dy).toBe(8);
    expect(shift?.from).toBe(12);
  });

  it('reports nothing when the two sides are identical', () => {
    const png = image([...blank(5), ...content]);
    expect(detectShift(png, png)).toBeNull();
  });

  it('reports nothing when content changed in place without moving', () => {
    const before = image([...blank(5), ...content]);
    const after = image([...blank(5), ...content.map(v => v + 1000)]);
    expect(detectShift(before, after)).toBeNull();
  });

  it('reports nothing when there is too little distinctive content', () => {
    const before = image([...blank(30), 1, 2, 3]);
    const after = image([...blank(33), 1, 2, 3]);
    expect(detectShift(before, after)).toBeNull();
  });

  it('ignores rows that repeat too often to place anything', () => {
    // Every row is one of three values, so no row says where it came from.
    const repeated = Array.from({ length: 60 }, (_, i) => (i % 3) + 1);
    const before = image(repeated);
    const after = image([...blank(4), ...repeated.slice(0, 56)]);
    expect(detectShift(before, after)).toBeNull();
  });

  it('refuses images of different sizes', () => {
    expect(detectShift(image(content), image(content, 16))).toBeNull();
  });
});

describe('insertedBand', () => {
  it('reports the rows Post gained when content moved down', () => {
    expect(insertedBand({ dy: 10, from: 4, coverage: 1 })).toEqual({ y: 4, height: 10 });
  });

  it('reports nothing when content moved up, since Post gained no rows', () => {
    expect(insertedBand({ dy: -10, from: 4, coverage: 1 })).toBeNull();
  });
});

describe('alignBefore', () => {
  it('re-spaces Pre so it lands where Post has the same content', () => {
    const before = image([...blank(10), ...content, ...blank(10)]);
    const after = image([...blank(20), ...content]);
    const aligned = alignBefore(before, detectShift(before, after)!, WHITE);
    expect(rowHashes(aligned)).toEqual(rowHashes(after));
  });

  it('leaves the rows Post gained as background, so new content reads as new', () => {
    // Post puts something in the gap that Pre never had. Aligning must not
    // step over it: those rows have to stay background so the diff sees it.
    const before = image([...blank(10), ...content, ...blank(10)]);
    const after = image([...blank(10), ...blank(10).map(() => 0x0000ff), ...content]);
    const shift = detectShift(before, after)!;
    expect(shift.dy).toBe(10);
    const aligned = alignBefore(before, shift, WHITE);
    const band = insertedBand(shift)!;
    for (let y = band.y; y < band.y + band.height; y++) {
      const i = y * aligned.width * 4;
      expect([aligned.data[i], aligned.data[i + 1], aligned.data[i + 2]], `row ${y}`).toEqual(WHITE);
    }
    // And the inserted rows still differ from Post, which is the whole point.
    expect(rowHashes(aligned).slice(band.y, band.y + band.height))
      .not.toEqual(rowHashes(after).slice(band.y, band.y + band.height));
  });

  it('leaves rows above the shift untouched', () => {
    const top = content.slice(0, 12);
    const bottom = content.slice(12);
    const before = image([...top, ...bottom, ...blank(8)]);
    const after = image([...top, ...blank(8), ...bottom]);
    const aligned = alignBefore(before, detectShift(before, after)!, WHITE);
    expect(rowHashes(aligned).slice(0, 12)).toEqual(rowHashes(before).slice(0, 12));
  });

  it('surfaces removed content when the page moved up', () => {
    // Pre has a block Post does not. Aligning keeps it where Pre had it, so it
    // lands against whatever Post moved up into that space and reads as gone.
    const top = content.slice(0, 10);
    const bottom = content.slice(10);
    const removed = blank(8).map((_, i) => 0xaa0000 + i);
    const before = image([...top, ...removed, ...bottom]);
    const after = image([...top, ...bottom, ...blank(8)]);
    const shift = detectShift(before, after)!;
    expect(shift.dy).toBe(-8);
    const aligned = alignBefore(before, shift, WHITE);
    expect(rowHashes(aligned).slice(10, 18)).toEqual(rowHashes(before).slice(10, 18));
    expect(rowHashes(aligned).slice(10, 18)).not.toEqual(rowHashes(after).slice(10, 18));
  });
});
