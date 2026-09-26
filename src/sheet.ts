/**
 * One image of everything a run found changed: a row per route and viewport,
 * Pre beside Post, labelled.
 *
 * The PR description is where a reviewer on GitHub looks. An agent's user is
 * often somewhere else — watching the session from a phone — and a folder of
 * crops named `home-desktop-before-crop.png` is not something they can read
 * there. A single labelled picture is. It is drawn by the capture browser, so
 * the labels are real text and no image library is needed.
 */

import fs from 'fs';
import path from 'path';
import { getBrowser } from './browser.js';
import { RouteCaptureOutcome } from './types.js';

/** Wide enough to read both sides, narrow enough for a phone to show whole. */
export const SHEET_WIDTH = 1200;
/** Rows beyond this are counted, not drawn: the sheet is a summary, the files are the record. */
export const MAX_SHEET_ROWS = 12;
/** A full-page side is cut off below this many CSS px, so one long page cannot swamp the rest. */
const MAX_SIDE_HEIGHT = 1400;

/** The outcomes worth a row: a change, or a page only one side has. */
export function sheetRows(outcomes: RouteCaptureOutcome[]): RouteCaptureOutcome[] {
  return outcomes.filter(o => (o.status === 'changed' || o.status === 'added' || o.status === 'removed') && o.files);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function dataUri(file: string | undefined): string | null {
  if (!file || !fs.existsSync(file)) return null;
  return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
}

function side(label: string, file: string | undefined, missing: string): string {
  const src = dataUri(file);
  const body = src ? `<div class="clip"><img src="${src}"></div>` : `<div class="missing">${missing}</div>`;
  return `<div class="side"><div class="label">${label}</div>${body}</div>`;
}

function row(o: RouteCaptureOutcome): string {
  const files = o.files!;
  // The crops are what the PR shows first: the changed region, both sides cut
  // to the same box. Without them (a page one side lacks) the full page is it.
  const crops = Boolean(files.cropBefore && files.cropAfter);
  const pre = crops ? files.cropBefore : files.before;
  const post = crops ? files.cropAfter : files.after;
  const tag = o.status === 'added' ? ' · new page' : o.status === 'removed' ? ' · removed' : '';
  return `<section>
    <h2>${escapeHtml(o.route)} <span>${escapeHtml(o.viewport)}${tag}</span></h2>
    <div class="pair">${side('Pre', pre, 'No page on Pre')}${side('Post', post, 'No page on Post')}</div>
  </section>`;
}

export function sheetHtml(rows: RouteCaptureOutcome[]): string {
  const shown = rows.slice(0, MAX_SHEET_ROWS);
  const more = rows.length - shown.length;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; }
    body { width: ${SHEET_WIDTH}px; padding: 16px; background: #fff; color: #111; font: 15px/1.4 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
    section { padding: 12px 0 20px; border-bottom: 1px solid #e5e5e5; }
    section:last-of-type { border-bottom: 0; }
    h2 { font-size: 18px; font-weight: 600; margin-bottom: 8px; }
    h2 span { font-weight: 400; color: #666; }
    .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
    .label { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: #555; margin-bottom: 4px; }
    .clip { max-height: ${MAX_SIDE_HEIGHT}px; overflow: hidden; border: 1px solid #ddd; }
    img { display: block; width: 100%; }
    .missing { padding: 48px 0; text-align: center; color: #888; border: 1px dashed #ccc; }
    footer { padding-top: 12px; color: #666; }
  </style></head><body>
    ${shown.map(row).join('\n')}
    ${more > 0 ? `<footer>+${more} more not shown here; every image is in the run's folder.</footer>` : ''}
  </body></html>`;
}

/**
 * Draw the sheet into `outputDir/sheet.png`, or return null when nothing
 * changed. Needs the shared browser, so call it before the run closes it.
 */
export async function buildSheet(outcomes: RouteCaptureOutcome[], outputDir: string): Promise<string | null> {
  const rows = sheetRows(outcomes);
  if (!rows.length) return null;
  const browser = await getBrowser();
  const ctx = await browser.newContext({ viewport: { width: SHEET_WIDTH, height: 800 }, deviceScaleFactor: 1 });
  try {
    const page = await ctx.newPage();
    await page.setContent(sheetHtml(rows), { waitUntil: 'load' });
    const file = path.join(outputDir, 'sheet.png');
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } finally {
    await ctx.close();
  }
}
