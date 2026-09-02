import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectRoutesForRepo, findAppRoots, frameworkForRoot, isDynamicRoute } from '../../src/routes';

let root: string;
function write(rel: string, content: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function git(cmd: string): void {
  execSync(`git ${cmd}`, { cwd: root, stdio: 'pipe' });
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-repo-')));
  git('init -q -b main');
  git('config user.email t@example.com');
  git('config user.name t');
  write('package.json', JSON.stringify({ name: 'mono', private: true }));
  write('apps/web/package.json', JSON.stringify({ dependencies: { next: '15' } }));
  write('apps/web/tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }));
  write('apps/web/src/app/layout.tsx', 'export default ({ children }) => children;');
  write('apps/web/src/app/page.tsx', "import { Hero } from '@/components/hero';\nexport default () => <Hero/>;");
  write('apps/web/src/app/pricing/page.tsx', "import { Plans } from '@/components/plans';\nexport default () => <Plans/>;");
  write('apps/web/src/app/blog/[slug]/page.tsx', "import { Prose } from '@/components/prose';\nexport default () => <Prose/>;");
  write('apps/web/src/app/dashboard/layout.tsx', 'export default ({ children }) => children;');
  write('apps/web/src/app/dashboard/overview/page.tsx', 'export default () => null;');
  write('apps/web/src/components/hero.tsx', "import { Button } from './ui/button';\nexport const Hero = () => <Button/>;");
  write('apps/web/src/components/plans.tsx', "import { Button } from './ui/button';\nexport const Plans = () => <Button/>;");
  write('apps/web/src/components/prose.tsx', 'export const Prose = () => null;');
  write('apps/web/src/components/ui/button.tsx', 'export const Button = () => null;');
  write('apps/api/package.json', JSON.stringify({ name: 'api' }));
  write('apps/api/src/index.ts', 'export {};');
  git('add -A');
  git('commit -q -m init');
  git('checkout -q -b feature');
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('findAppRoots / frameworkForRoot', () => {
  it('finds nested apps and classifies them', () => {
    const roots = findAppRoots(root).map(r => path.relative(root, r) || '.');
    expect(roots).toEqual(expect.arrayContaining(['.', 'apps/web', 'apps/api']));
    expect(frameworkForRoot(path.join(root, 'apps/web'))).toBe('nextjs-app');
    expect(frameworkForRoot(path.join(root, 'apps/api'))).toBe('generic');
  });
});

describe('detectRoutesForRepo', () => {
  it('follows imports from a shared component to every page using it', () => {
    write('apps/web/src/components/ui/button.tsx', 'export const Button = () => <button/>;');
    const result = detectRoutesForRepo({ cwd: root });
    expect(result.framework).toBe('nextjs-app');
    expect(path.relative(root, result.appRoot)).toBe('apps/web');
    const paths = result.routes.map(r => r.path).sort();
    expect(paths).toEqual(['/', '/pricing']);
    expect(result.routes.find(r => r.path === '/')?.reason).toMatch(/imports/);
  });

  it('skips dynamic routes without a sample and uses one when configured', () => {
    write('apps/web/src/components/prose.tsx', 'export const Prose = () => <p/>;');
    const without = detectRoutesForRepo({ cwd: root });
    expect(without.skippedDynamic).toEqual(['/blog/[slug]']);
    expect(without.routes.map(r => r.path)).not.toContain('/blog/[slug]');

    const withSample = detectRoutesForRepo({ cwd: root, config: { samples: { '/blog/[slug]': '/blog/hello' } } });
    expect(withSample.routes.map(r => r.path)).toContain('/blog/[slug]');
    expect(withSample.skippedDynamic).toEqual([]);
  });

  it('snaps a layout change to the nearest page beneath it', () => {
    write('apps/web/src/app/dashboard/layout.tsx', 'export default ({ children }) => <main>{children}</main>;');
    const result = detectRoutesForRepo({ cwd: root });
    expect(result.routes.map(r => r.path)).toContain('/dashboard/overview');
  });

  it('always includes configured routes and honors ignore', () => {
    const result = detectRoutesForRepo({ cwd: root, config: { routes: ['/status'], ignore: ['apps/web/src/components'] } });
    expect(result.routes.find(r => r.path === '/status')?.confidence).toBe('high');
    expect(result.routes.map(r => r.path)).not.toContain('/pricing');
  });

  it('respects maxRoutes', () => {
    const result = detectRoutesForRepo({ cwd: root, maxRoutes: 1 });
    expect(result.routes).toHaveLength(1);
  });
});

describe('isDynamicRoute', () => {
  it('recognizes bracket, colon, and splat segments', () => {
    expect(isDynamicRoute('/blog/[slug]')).toBe(true);
    expect(isDynamicRoute('/users/:id')).toBe(true);
    expect(isDynamicRoute('/docs/*')).toBe(true);
    expect(isDynamicRoute('/pricing')).toBe(false);
  });
});
