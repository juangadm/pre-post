import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import { diffImages, expandRegion, downscale, findClusters } from '../../src/diff';

function solid(width: number, height: number, rgb: [number, number, number]): PNG {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgb[0]; png.data[i + 1] = rgb[1]; png.data[i + 2] = rgb[2]; png.data[i + 3] = 255;
  }
  return png;
}

function paint(png: PNG, x0: number, y0: number, w: number, h: number, rgb: [number, number, number]): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * png.width + x) * 4;
      png.data[i] = rgb[0]; png.data[i + 1] = rgb[1]; png.data[i + 2] = rgb[2]; png.data[i + 3] = 255;
    }
  }
}

const encode = (png: PNG) => PNG.sync.write(png);

describe('diffImages', () => {
  it('reports zero change for identical images', () => {
    const a = solid(200, 100, [255, 255, 255]);
    const result = diffImages(encode(a), encode(a));
    expect(result.changedPixels).toBe(0);
    expect(result.changedRatio).toBe(0);
    expect(result.region).toBeNull();
    expect(result.crop).toBeUndefined();
    expect(result.highlight).toBeUndefined();
    expect(result.sizeChanged).toBe(false);
  });

  it('finds the bounding box of a localized change and crops around it', () => {
    const a = solid(1000, 600, [255, 255, 255]);
    const b = solid(1000, 600, [255, 255, 255]);
    paint(b, 400, 200, 50, 30, [0, 0, 255]);
    const result = diffImages(encode(a), encode(b), { padding: 10, minCrop: { width: 100, height: 80 } });
    expect(result.changedPixels).toBe(50 * 30);
    expect(result.region).toEqual({ x: 400, y: 200, width: 50, height: 30 });
    expect(result.crop).toBeDefined();
    const crop = PNG.sync.read(result.crop!.after);
    expect(crop.width).toBe(100);
    expect(crop.height).toBe(80);
    expect(result.crop!.region.x).toBeLessThanOrEqual(400);
    expect(result.crop!.region.x + result.crop!.region.width).toBeGreaterThanOrEqual(450);
  });

  it('skips the crop when most of the page changed', () => {
    const a = solid(400, 400, [255, 255, 255]);
    const b = solid(400, 400, [0, 0, 0]);
    const result = diffImages(encode(a), encode(b));
    expect(result.changedRatio).toBe(1);
    expect(result.crop).toBeUndefined();
  });

  it('pads images of different heights and flags sizeChanged', () => {
    const a = solid(100, 100, [255, 255, 255]);
    const b = solid(100, 150, [255, 255, 255]);
    const result = diffImages(encode(a), encode(b));
    expect(result.sizeChanged).toBe(true);
    expect(result.width).toBe(100);
    expect(result.height).toBe(150);
    // Padding is white, and the extra rows are white → nothing differs.
    expect(result.changedPixels).toBe(0);
  });

  it('downscales the highlight when asked', () => {
    const a = solid(200, 100, [255, 255, 255]);
    const b = solid(200, 100, [255, 255, 255]);
    paint(b, 10, 10, 20, 20, [255, 0, 0]);
    const result = diffImages(encode(a), encode(b), { highlightDownscale: 2 });
    const highlight = PNG.sync.read(result.highlight!);
    expect(highlight.width).toBe(100);
    expect(highlight.height).toBe(50);
  });
});

describe('expandRegion', () => {
  it('grows to the minimum size and clamps to the canvas', () => {
    const r = expandRegion({ x: 0, y: 0, width: 10, height: 10 }, { width: 500, height: 300 }, 20, { width: 200, height: 100 });
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
    expect(r.width).toBe(200);
    expect(r.height).toBe(100);
  });

  it('never exceeds the canvas', () => {
    const r = expandRegion({ x: 490, y: 290, width: 5, height: 5 }, { width: 500, height: 300 }, 50, { width: 800, height: 400 });
    expect(r.x + r.width).toBeLessThanOrEqual(500);
    expect(r.y + r.height).toBeLessThanOrEqual(300);
  });
});

describe('downscale', () => {
  it('averages 2x2 blocks', () => {
    const png = new PNG({ width: 2, height: 2 });
    png.data.set([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
    const out = downscale(png, 2);
    expect(out.width).toBe(1);
    expect(out.data[0]).toBe(127);
    expect(out.data[3]).toBe(255);
  });
});

describe('crops follow the change rule', () => {
  const RULE = { minPixels: 400, minRatio: 0.001 };

  it('merges nearby changed pixels into one patch and keeps distant ones apart', () => {
    const a = solid(1000, 1000, [255, 255, 255]);
    const b = solid(1000, 1000, [255, 255, 255]);
    paint(b, 100, 100, 10, 10, [0, 0, 0]);
    paint(b, 130, 100, 10, 10, [0, 0, 0]); // 20px away: same patch
    paint(b, 800, 800, 4, 4, [0, 0, 0]);   // far away: its own patch
    const diff = new PNG({ width: 1000, height: 1000 });
    // Paint the diff colour directly: findClusters reads the diff image.
    for (const [x, y, w, h] of [[100, 100, 10, 10], [130, 100, 10, 10], [800, 800, 4, 4]]) paint(diff, x, y, w, h, [255, 0, 0]);
    const clusters = findClusters(diff, 48);
    expect(clusters).toHaveLength(2);
    expect(clusters.map(c => c.pixels).sort((p, q) => p - q)).toEqual([16, 200]);
  });

  // Scenario 3: a header change plus specks of animation noise far below it
  // made one crop spanning both.
  it('leaves specks that do not count out of a crop around a real change', () => {
    const a = solid(2000, 3000, [255, 255, 255]);
    const b = solid(2000, 3000, [255, 255, 255]);
    paint(b, 100, 40, 600, 40, [0, 0, 0]);    // the real change: 24000px
    paint(b, 1500, 2600, 6, 6, [30, 30, 30]); // noise: 36px
    const result = diffImages(encode(a), encode(b), { rule: RULE, padding: 10, minCrop: { width: 100, height: 80 } });
    expect(result.crop).toBeDefined();
    expect(result.crop!.region.y + result.crop!.region.height).toBeLessThan(200);
  });

  it('still crops several small edits that only count together', () => {
    const a = solid(2000, 2000, [255, 255, 255]);
    const b = solid(2000, 2000, [255, 255, 255]);
    for (const x of [100, 400, 700, 1000, 1300]) paint(b, x, 100, 9, 9, [0, 0, 0]); // 81px each, 405 together
    const result = diffImages(encode(a), encode(b), { rule: RULE, padding: 10, minCrop: { width: 100, height: 80 } });
    expect(result.crop).toBeDefined();
    expect(result.crop!.region.x).toBeLessThanOrEqual(100);
    expect(result.crop!.region.x + result.crop!.region.width).toBeGreaterThanOrEqual(1309);
  });

  it('draws no crop when what changed does not count', () => {
    const a = solid(2000, 2000, [255, 255, 255]);
    const b = solid(2000, 2000, [255, 255, 255]);
    paint(b, 500, 500, 5, 5, [0, 0, 0]);
    expect(diffImages(encode(a), encode(b), { rule: RULE }).crop).toBeUndefined();
    // Without a rule, any pixel still counts, as image mode expects.
    expect(diffImages(encode(a), encode(b), { padding: 10, minCrop: { width: 100, height: 80 } }).crop).toBeDefined();
  });

  // Scenario 4: "Content shifted down 48px. Nothing else changed." shipped
  // with a crop of animation noise the report had just called no change.
  it('draws no crop for a pure move that leaves only noise behind', () => {
    const stripes = (offset: number) => {
      const png = solid(400, 600, [255, 255, 255]);
      // Distinct rows, so the move has something to lock on to.
      for (let y = 0; y < 400; y++) paint(png, 20, y + 100 + offset, 360, 1, [y % 256, (y * 7) % 256, (y * 13) % 256]);
      return png;
    };
    const a = stripes(0);
    const b = stripes(40);
    paint(b, 300, 580, 3, 3, [0, 0, 0]); // 9px of noise, below the move
    const result = diffImages(encode(a), encode(b), { rule: RULE, padding: 10, minCrop: { width: 100, height: 80 } });
    expect(result.shift?.dy).toBe(40);
    expect(result.shift!.alignedChangedPixels).toBeGreaterThan(0);
    expect(result.crop).toBeUndefined();
  });

  it('widens a crop that spans most of the page to the full width', () => {
    const a = solid(1000, 3000, [255, 255, 255]);
    const b = solid(1000, 3000, [255, 255, 255]);
    paint(b, 150, 100, 600, 50, [0, 0, 0]);
    const result = diffImages(encode(a), encode(b), { rule: RULE, padding: 10, minCrop: { width: 100, height: 80 } });
    expect(result.crop!.region.x).toBe(0);
    expect(result.crop!.region.width).toBe(1000);
  });
});

describe('change fingerprints', () => {
  const pair = (y: number, rgb: [number, number, number]) => {
    const a = solid(600, 900, [255, 255, 255]);
    const b = solid(600, 900, [255, 255, 255]);
    paint(a, 50, y, 200, 30, [0, 0, 0]);
    paint(b, 50, y, 200, 30, rgb);
    return diffImages(encode(a), encode(b), { padding: 10, minCrop: { width: 100, height: 80 } }).fingerprint;
  };

  it('is the same for the same change wherever it sits on the page', () => {
    expect(pair(100, [0, 0, 200])).toBeDefined();
    expect(pair(100, [0, 0, 200])).toBe(pair(600, [0, 0, 200]));
  });

  it('differs for a different change', () => {
    expect(pair(100, [0, 0, 200])).not.toBe(pair(100, [200, 0, 0]));
  });
});
