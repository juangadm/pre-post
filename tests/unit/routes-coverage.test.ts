import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectRoutesForRepo, selectRoutes } from '../../src/routes';
import { DetectedRoute } from '../../src/types';

/**
 * The lab site's shape: seven static pages and one dynamic one, a root layout
 * that imports globals.css and a nav, and pages that do not import the layout.
 */
let root: string;
const put = (rel: string, content: string) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: root, stdio: 'pipe' });
const STATIC = ['/', '/about', '/colophon', '/faq', '/projects', '/work', '/writing'];
const detect = (changedFiles: string[], maxRoutes = 6) =>
  detectRoutesForRepo({ cwd: root, changedFiles, maxRoutes });

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-coverage-')));
  git('init -q -b main');
  put('package.json', JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { next: '16' } }));
  put('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] } } }));
  put('tailwind.config.ts', 'export default {};');
  put('app/globals.css', 'body { font-size: 14px; }');
  put('app/layout.tsx', "import './globals.css';\nimport { Nav } from '@/components/Nav';\nexport default ({ children }) => <><Nav/>{children}</>;");
  put('components/Nav.tsx', 'export const Nav = () => <nav/>;');
  put('components/Card.module.css', '.card { padding: 4px; }');
  put('components/Card.tsx', "import styles from './Card.module.css';\nexport const Card = () => <div className={styles.card}/>;");
  put('app/page.tsx', "import { Card } from '@/components/Card';\nexport default () => <Card/>;");
  for (const r of STATIC.slice(1)) put(`app${r}/page.tsx`, 'export default () => null;');
  put('app/writing/layout.tsx', 'export default ({ children }) => children;');
  put('app/writing/[slug]/page.tsx', 'export default () => null;');
  git('add -A');
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('route coverage', () => {
  // Scenario 11: globals.css used to select `/` alone, at low confidence.
  it('carries a global stylesheet through the root layout to every page', () => {
    const result = detect(['app/globals.css'], 20);
    expect(result.routes.map(r => r.path).sort()).toEqual([...STATIC].sort());
    expect(result.routes.every(r => r.confidence === 'medium')).toBe(true);
    expect(result.skippedDynamic).toEqual(['/writing/[slug]']);
  });

  // A nav imported only by the layout reached no page at all: pages do not
  // import their layout.
  it('reaches every page from a component only the layout imports', () => {
    const result = detect(['components/Nav.tsx'], 20);
    expect(result.routes.map(r => r.path).sort()).toEqual([...STATIC].sort());
  });

  it('limits a nested layout to its own folder', () => {
    const result = detect(['app/writing/layout.tsx'], 20);
    expect(result.routes.map(r => r.path)).toEqual(['/writing']);
    expect(result.skippedDynamic).toEqual(['/writing/[slug]']);
  });

  it('treats a CSS module as part of the component that imports it', () => {
    expect(detect(['components/Card.module.css']).routes.map(r => r.path)).toEqual(['/']);
  });

  it('treats style tooling config as affecting every page', () => {
    expect(detect(['tailwind.config.ts'], 20).routes).toHaveLength(STATIC.length);
  });

  it('captures / as a check only when nothing mapped and nothing waits for a sample', () => {
    expect(detect(['README.md']).routes.map(r => [r.path, r.reason])).toEqual([['/', 'No page mapped from the diff; capturing / as a check']]);
    const dynamicOnly = detect(['app/writing/[slug]/page.tsx']);
    expect(dynamicOnly.routes).toEqual([]);
    expect(dynamicOnly.skippedDynamic).toEqual(['/writing/[slug]']);
  });

  // Scenarios 3 and 12: the seventh page was dropped with nothing recorded.
  it('reports the routes the cap leaves out', () => {
    const result = detect(['app/globals.css']);
    expect(result.routes).toHaveLength(6);
    // Shortest paths first, so the last of the 9-character tie is the one left out.
    expect(result.omitted.map(r => r.path)).toEqual(['/projects']);
    expect([...result.routes, ...result.omitted].map(r => r.path).sort()).toEqual([...STATIC].sort());
  });
});

describe('selectRoutes', () => {
  const route = (p: string, sourceFile: string, confidence: DetectedRoute['confidence'] = 'medium'): DetectedRoute =>
    ({ path: p, sourceFile, confidence, reason: '' });

  it('gives every cause a route before any cause gets a second', () => {
    const shared = ['/a', '/b', '/c', '/d'].map(p => route(p, 'components/Nav.tsx'));
    const { selected, omitted } = selectRoutes([...shared, route('/zzz', 'components/Footer.tsx')], 2);
    expect(selected.map(r => r.path)).toEqual(['/a', '/zzz']);
    expect(omitted.map(r => r.path)).toEqual(['/b', '/c', '/d']);
  });

  it('still puts higher confidence first', () => {
    const { selected } = selectRoutes([route('/x', 'a.tsx', 'low'), route('/y', 'b.tsx', 'high')], 1);
    expect(selected.map(r => r.path)).toEqual(['/y']);
  });

  it('omits nothing under the cap', () => {
    expect(selectRoutes([route('/a', 'x'), route('/b', 'x')], 6).omitted).toEqual([]);
  });
});
