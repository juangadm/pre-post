import { describe, it, expect } from 'vitest';
import { MAX_SHEET_ROWS, sheetHtml, sheetRows } from '../../src/sheet';
import { RouteCaptureOutcome } from '../../src/types';

const outcome = (route: string, status: RouteCaptureOutcome['status'], files?: RouteCaptureOutcome['files']): RouteCaptureOutcome =>
  ({ route, resolvedRoute: route, viewport: 'desktop', status, files });

describe('sheetRows', () => {
  it('keeps changes and one-sided pages, and drops the rest', () => {
    const rows = sheetRows([
      outcome('/a', 'changed', { before: 'a', after: 'b' }),
      outcome('/b', 'unchanged', { before: 'a', after: 'b' }),
      outcome('/c', 'added', { after: 'b' }),
      outcome('/d', 'removed', { before: 'a' }),
      outcome('/e', 'error'),
    ]);
    expect(rows.map(r => r.route)).toEqual(['/a', '/c', '/d']);
  });
});

describe('sheetHtml', () => {
  it('says which side is missing for a page only one side has', () => {
    const html = sheetHtml([outcome('/new', 'added', { after: '/nonexistent.png' })]);
    expect(html).toContain('new page');
    expect(html).toContain('No page on Pre');
  });

  it('counts the rows it leaves out rather than dropping them silently', () => {
    const many = Array.from({ length: MAX_SHEET_ROWS + 3 }, (_, i) => outcome(`/p${i}`, 'changed', {}));
    const html = sheetHtml(many);
    expect(html).toContain('+3 more not shown');
    expect(html).not.toContain(`/p${MAX_SHEET_ROWS}<`);
  });

  it('escapes route names', () => {
    expect(sheetHtml([outcome('/<script>', 'changed', {})])).toContain('/&lt;script&gt;');
  });
});
