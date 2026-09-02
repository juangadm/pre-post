import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import { diffImages, expandRegion, downscale } from '../../src/diff';

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
