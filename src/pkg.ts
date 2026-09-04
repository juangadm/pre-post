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

/**
 * The script that starts a dev server for this package, preferring `dev`.
 *
 * This is the test for "is this directory an app we could actually serve?",
 * used both when picking the app root to detect routes for and when serving a
 * base commit. The two must agree: a directory that cannot be served is not
 * the app a PR changed, however many of its files the diff touched.
 */
export function devScript(dir: string): string | null {
  const scripts = readPackage(dir)?.scripts as Record<string, string> | undefined;
  if (!scripts) return null;
  return ['dev', 'start:dev', 'serve', 'start'].find(name => typeof scripts[name] === 'string') ?? null;
}
