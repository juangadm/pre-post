/**
 * package.json access, shared by route detection and the pr command.
 * Parsed once per file version (keyed by path + mtime), since detection asks
 * the same question about the same root several times per run.
 */

import fs from 'fs';
import path from 'path';

const cache = new Map<string, { mtimeMs: number; pkg: Record<string, any> | null }>();

export function readPackage(root: string): Record<string, any> | null {
  const file = path.join(root, 'package.json');
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.pkg;
  let pkg: Record<string, any> | null = null;
  try {
    pkg = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    pkg = null;
  }
  cache.set(file, { mtimeMs, pkg });
  return pkg;
}

export function hasDependency(root: string, name: string): boolean {
  const pkg = readPackage(root);
  return Boolean(pkg?.dependencies?.[name] || pkg?.devDependencies?.[name]);
}
