import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PNG } from 'pngjs';
import { buildSheet, SHEET_WIDTH } from '../../src/sheet';
import { closeBrowser } from '../../src/browser';

const playwrightAvailable = process.env.TEST_BROWSER === 'true';

function solid(file: string, width: number, height: number, rgb: [number, number, number]): string {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgb[0]; png.data[i + 1] = rgb[1]; png.data[i + 2] = rgb[2]; png.data[i + 3] = 255;
  }
  fs.writeFileSync(file, PNG.sync.write(png));
  return file;
}

describe('buildSheet', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-sheet-'));
  afterAll(async () => {
    await closeBrowser();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!playwrightAvailable)('draws one image, at a phone-readable width, with Pre beside Post', async () => {
    const pre = solid(path.join(dir, 'pre.png'), 800, 400, [255, 0, 0]);
    const post = solid(path.join(dir, 'post.png'), 800, 400, [0, 0, 255]);
    const file = await buildSheet([
      { route: '/', resolvedRoute: '/', viewport: 'desktop', status: 'changed', files: { cropBefore: pre, cropAfter: post } },
      { route: '/new', resolvedRoute: '/new', viewport: 'desktop', status: 'added', files: { after: post } },
    ], dir);
    expect(file).toBe(path.join(dir, 'sheet.png'));
    const sheet = PNG.sync.read(fs.readFileSync(file!));
    expect(sheet.width).toBe(SHEET_WIDTH);
    // Two rows of ~290px images plus labels: taller than one row, far short of a full page.
    expect(sheet.height).toBeGreaterThan(600);
    expect(sheet.height).toBeLessThan(1400);
    // Pre on the left is red, Post on the right is blue, in the first row.
    const at = (x: number, y: number) => { const i = (sheet.width * y + x) * 4; return [sheet.data[i], sheet.data[i + 1], sheet.data[i + 2]]; };
    expect(at(300, 150)).toEqual([255, 0, 0]);
    expect(at(900, 150)).toEqual([0, 0, 255]);
  });

  it.skipIf(!playwrightAvailable)('ends where its content ends, with no empty band below', async () => {
    const pre = solid(path.join(dir, 'short-pre.png'), 800, 100, [255, 0, 0]);
    const post = solid(path.join(dir, 'short-post.png'), 800, 100, [0, 0, 255]);
    const file = await buildSheet([{ route: '/', resolvedRoute: '/', viewport: 'desktop', status: 'changed', files: { cropBefore: pre, cropAfter: post } }], dir);
    expect(PNG.sync.read(fs.readFileSync(file!)).height).toBeLessThan(200);
  });

  it('returns null when nothing changed', async () => {
    expect(await buildSheet([{ route: '/', resolvedRoute: '/', viewport: 'desktop', status: 'unchanged', files: {} }], dir)).toBeNull();
  });
});
