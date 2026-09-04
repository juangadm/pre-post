import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import { detectShift, alignImage, rowHashes } from '../../src/shift';

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

describe('alignImage', () => {
  it('puts shifted content back where the other side has it', () => {
    const before = image([...blank(10), ...content, ...blank(10)]);
    const after = image([...blank(20), ...content]);
    const shift = detectShift(before, after)!;
    const aligned = alignImage(after, shift, WHITE);
    expect(rowHashes(aligned)).toEqual(rowHashes(before));
  });

  it('fills rows the shift leaves without a source with the pad colour', () => {
    const before = image([...blank(10), ...content, ...blank(10)]);
    const after = image([...blank(20), ...content]);
    const aligned = alignImage(after, detectShift(before, after)!, WHITE);
    const last = (aligned.height - 1) * aligned.width * 4;
    expect([aligned.data[last], aligned.data[last + 1], aligned.data[last + 2]]).toEqual(WHITE);
  });

  it('leaves rows above the shift untouched', () => {
    const top = content.slice(0, 12);
    const bottom = content.slice(12);
    const before = image([...top, ...bottom, ...blank(8)]);
    const after = image([...top, ...blank(8), ...bottom]);
    const aligned = alignImage(after, detectShift(before, after)!, WHITE);
    expect(rowHashes(aligned).slice(0, 12)).toEqual(rowHashes(before).slice(0, 12));
  });
});
