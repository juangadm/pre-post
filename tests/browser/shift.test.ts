import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { captureScreenshot } from '../../src/capture';
import { diffImages } from '../../src/diff';
import { CONFIG_DEFAULTS } from '../../src/config';

const TEST_PAGES = path.resolve(__dirname, '../fixtures/pages');
const playwrightAvailable = process.env.TEST_BROWSER === 'true';
const SCALE = CONFIG_DEFAULTS.scale;

function fileUrl(relativePath: string): string {
  return `file://${path.join(TEST_PAGES, relativePath)}`;
}

interface Measurement {
  name: string;
  rawArea: number;
  shiftCssPx: number | null;
  fromCssPx: number | null;
  alignedArea: number | null;
  cropped: boolean;
}

async function measure(name: string): Promise<Measurement> {
  const [before, after] = await Promise.all([
    captureScreenshot({ url: fileUrl(`${name}/before.html`), fullPage: true, scale: SCALE }),
    captureScreenshot({ url: fileUrl(`${name}/after.html`), fullPage: true, scale: SCALE }),
  ]);
  const diff = diffImages(before.image, after.image);
  const css = (devicePixels: number) => devicePixels / (SCALE * SCALE);
  return {
    name,
    rawArea: css(diff.changedPixels),
    shiftCssPx: diff.shift ? diff.shift.dy / SCALE : null,
    fromCssPx: diff.shift ? diff.shift.from / SCALE : null,
    alignedArea: diff.shift ? css(diff.shift.alignedChangedPixels) : null,
    cropped: Boolean(diff.crop),
  };
}

function table(rows: Measurement[]): string {
  const header = ['fixture', 'shift (CSS px)', 'from (CSS px)', 'raw area (CSS px2)', 'aligned area (CSS px2)', 'crop'];
  const body = rows.map(r => [
    r.name,
    r.shiftCssPx === null ? 'none' : String(r.shiftCssPx),
    r.fromCssPx === null ? '-' : String(r.fromCssPx),
    r.rawArea.toFixed(0),
    r.alignedArea === null ? '-' : r.alignedArea.toFixed(0),
    r.cropped ? 'yes' : 'no',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map(row => row[i].length)));
  const line = (cells: string[]) => '| ' + cells.map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |';
  return [line(header), '|' + widths.map(w => '-'.repeat(w + 2)).join('|') + '|', ...body.map(line)].join('\n');
}

/**
 * The layout-shift ladder.
 *
 * A shift repaints everything below where it starts, so the raw area says
 * nothing useful about what the branch changed. These fixtures place the rule
 * that decides when an offset is worth reporting: a pure shift must leave no
 * aligned change, a shift with a real change must isolate that change and
 * crop it, and a horizontal reflow must not be described as a vertical move.
 */
describe('layout shift calibration', () => {
  const names = fs.existsSync(TEST_PAGES)
    ? fs.readdirSync(TEST_PAGES).filter(d => d.startsWith('shift-')).sort()
    : [];

  it.skipIf(!playwrightAvailable)('measures every shift fixture', async () => {
    expect(names.length).toBeGreaterThan(0);
    const rows: Measurement[] = [];
    for (const name of names) rows.push(await measure(name));
    console.log('\n' + table(rows) + '\n');

    const by = (name: string) => rows.find(r => r.name === name)!;

    // A pure shift is a move and nothing else: it must be named, and aligning
    // must leave nothing over.
    expect(by('shift-pure').shiftCssPx, 'pure shift should be detected').toBe(80);
    expect(by('shift-pure').alignedArea, 'pure shift should leave no other change').toBe(0);

    // A shift larger than the viewport is still one offset. The banner that
    // caused it is content Post gained, and alignment has to show it rather
    // than step over it -- reporting an inserted banner as "nothing else
    // changed" is exactly the confident wrong answer this feature removes.
    expect(by('shift-viewport').shiftCssPx, 'shift larger than the viewport').toBeGreaterThan(800);
    expect(by('shift-viewport').alignedArea!, 'the inserted banner must survive alignment')
      .toBeGreaterThan(CONFIG_DEFAULTS.minChangedArea);
    expect(by('shift-viewport').cropped, 'and must be croppable').toBe(true);

    // A change inside the region that moved must survive alignment and crop.
    expect(by('shift-change-below').shiftCssPx).toBe(80);
    expect(by('shift-change-below').alignedArea!).toBeGreaterThan(CONFIG_DEFAULTS.minChangedArea);
    expect(by('shift-change-below').cropped, 'the real change should be croppable').toBe(true);

    // A partial shift: the tags above it changed, the content below it moved.
    // 94px, not the spacer's 80px: at height 0 the entry's 14px bottom margin
    // and the heading's 24px top margin collapse through the spacer to 24px,
    // and giving it height stops them collapsing (14 + 80 + 24 = 118). The
    // measured number is the one a reviewer sees, so the fixture asserts it.
    expect(by('shift-change-above').shiftCssPx).toBe(94);
    expect(by('shift-change-above').alignedArea!).toBeGreaterThan(CONFIG_DEFAULTS.minChangedArea);
    expect(by('shift-change-above').cropped).toBe(true);

    // No geometry change: nothing to align, and the crop path is untouched.
    expect(by('shift-none').shiftCssPx, 'a recolour is not a shift').toBe(null);
    expect(by('shift-none').cropped).toBe(true);

    // Reflow moves content both ways at once, so no single offset explains it.
    expect(by('shift-reflow').shiftCssPx, 'reflow is not a vertical shift').toBe(null);
  }, 120_000);
});
