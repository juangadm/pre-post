import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildImportGraph, findAffectedEntries, extractSpecifiers, readAliases, resolveSpecifier } from '../../src/routes/imports';

let root: string;

function write(rel: string, content: string): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-imports-'));
  write('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }));
  write('src/app/page.tsx', "import Hero from '@/components/hero';\nexport default function Page() { return <Hero/>; }");
  write('src/app/pricing/page.tsx', "import { Card } from '../../components/card';\nexport default () => <Card/>;");
  write('src/components/hero.tsx', "import { Button } from './ui/button';\nexport default () => <Button/>;");
  write('src/components/card.tsx', "import { Button } from '@/components/ui/button';\nexport const Card = () => <Button/>;");
  write('src/components/ui/button.tsx', "export const Button = () => null;");
  write('src/lib/unused.ts', 'export const x = 1;');
  write('node_modules/pkg/index.js', 'module.exports = {}');
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('extractSpecifiers', () => {
  it('finds static, dynamic, side-effect, and require imports', () => {
    const specs = extractSpecifiers(`
      import a from './a';
      import { b } from "../b";
      import './side-effect.css';
      export * from './re';
      export { c } from './c';
      const d = await import('./d');
      const e = require('./e');
      import type { T } from './types';
    `);
    expect(specs).toEqual(expect.arrayContaining(['./a', '../b', './side-effect.css', './re', './c', './d', './e', './types']));
  });
});

describe('readAliases', () => {
  it('reads tsconfig paths and adds @/ and ~/ conventions', () => {
    const aliases = readAliases(root);
    const at = aliases.find(a => a.prefix === '@/');
    expect(at?.targets[0]).toBe(path.join(root, 'src'));
  });
});

describe('buildImportGraph + findAffectedEntries', () => {
  it('maps a changed leaf component to every page that transitively imports it', () => {
    const graph = buildImportGraph(root);
    expect(graph.files.has(path.join(root, 'node_modules/pkg/index.js'))).toBe(false);
    const isEntry = (f: string) => /app\/.*page\.tsx$/.test(f);
    const affected = findAffectedEntries(graph, [path.join(root, 'src/components/ui/button.tsx')], isEntry);
    const entries = Array.from(affected.keys()).map(f => path.relative(root, f)).sort();
    expect(entries).toEqual(['src/app/page.tsx', 'src/app/pricing/page.tsx']);
    expect(affected.get(path.join(root, 'src/app/page.tsx'))?.depth).toBe(2);
  });

  it('records depth 0 when the entry itself changed', () => {
    const graph = buildImportGraph(root);
    const entry = path.join(root, 'src/app/page.tsx');
    const affected = findAffectedEntries(graph, [entry], f => f === entry);
    expect(affected.get(entry)?.depth).toBe(0);
  });

  it('ignores files nothing imports', () => {
    const graph = buildImportGraph(root);
    const affected = findAffectedEntries(graph, [path.join(root, 'src/lib/unused.ts')], f => /page\.tsx$/.test(f));
    expect(affected.size).toBe(0);
  });

  it('resolves aliases, extensions, and index files', () => {
    const files = new Set([path.join(root, 'src/components/ui/button.tsx'), path.join(root, 'src/components/index.ts')]);
    const aliases = readAliases(root);
    const from = path.join(root, 'src/app/page.tsx');
    expect(resolveSpecifier('@/components/ui/button', from, files, aliases)).toBe(path.join(root, 'src/components/ui/button.tsx'));
    expect(resolveSpecifier('../components', from, files, aliases)).toBe(path.join(root, 'src/components/index.ts'));
    expect(resolveSpecifier('react', from, files, aliases)).toBeNull();
  });
});
