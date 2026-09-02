import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { viteRouteEntries, isViteApp } from '../../src/routes/vite';

let root: string;
function write(rel: string, content: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-vite-'));
  write('package.json', JSON.stringify({ devDependencies: { vite: '^5' } }));
  write('vite.config.ts', 'export default {}');
  write('src/App.tsx', `
    import { Routes, Route } from 'react-router-dom';
    import Home from './pages/Home';
    import { Settings } from './pages/Settings';
    const Lazy = lazy(() => import('./pages/Lazy'));
    export default function App() {
      return (
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/lazy" element={<Lazy />} />
          <Route path="/users/:id" element={<Settings />} />
        </Routes>
      );
    }
  `);
  write('src/pages/Home.tsx', 'export default () => null;');
  write('src/pages/Settings.tsx', 'export const Settings = () => null;');
  write('src/pages/Lazy.tsx', 'export default () => null;');
  write('src/pages/about.tsx', 'export default () => null;');
  write('src/routes/posts.$postId.tsx', 'export default () => null;');
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('vite route discovery', () => {
  it('detects a Vite app', () => {
    expect(isViteApp(root)).toBe(true);
  });

  it('maps React Router declarations and file-based pages to entry files', () => {
    const entries = viteRouteEntries(root);
    const byRoute = new Map(Array.from(entries.entries()).map(([f, r]) => [r, path.relative(root, f)]));
    expect(byRoute.get('/')).toBe('src/pages/Home.tsx');
    expect(byRoute.get('/settings')).toBe('src/pages/Settings.tsx');
    expect(byRoute.get('/lazy')).toBe('src/pages/Lazy.tsx');
    expect(byRoute.get('/about')).toBe('src/pages/about.tsx');
    expect(byRoute.get('/posts/[postId]')).toBe('src/routes/posts.$postId.tsx');
  });
});
