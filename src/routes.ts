/**
 * Route detection: which pages does this branch visually affect?
 *
 * 1. Changed files = diff against the merge base with the default branch,
 *    plus staged, unstaged, and untracked files.
 * 2. Pick the app root that owns most of those files (monorepo aware).
 * 3. Framework adapter: direct file → route rules, plus the route entry files.
 * 4. Import graph: any changed file that a page imports, directly or
 *    transitively, marks that page.
 * 5. Dedupe, rank by confidence, cap, and substitute samples for dynamic routes.
 */

import fs from 'fs';
import path from 'path';
import { DetectedRoute, Framework, PrePostConfig, RouteDetectionOptions } from './types.js';
import { detectAppRouterRoutes, detectPagesRouterRoutes } from './routes/nextjs.js';
import { detectGenericRoutes } from './routes/generic.js';
import { Alias, buildImportGraph, findAffectedEntries, readAliases, walkSourceFiles, toPosix, SKIP_DIRS } from './routes/imports.js';
import { viteRouteEntries, isViteApp } from './routes/vite.js';
import { changedFiles as gitChangedFiles, repoRoot as gitRepoRoot } from './git.js';
import { devScript, hasDependency } from './pkg.js';
import { CONFIG_DEFAULTS, CONFIG_FILENAME } from './config.js';

export type { Framework };

// ============================================================
// Framework adapters
// ============================================================

interface FrameworkAdapter {
  name: Framework;
  /** Does this app root use the framework? Checked in table order. */
  matches(root: string): boolean;
  /** Normalize an app-relative path before the direct rules see it. */
  normalize(rel: string): string;
  /** Direct file → route rules on (normalized) changed files. */
  directRoutes(files: string[]): DetectedRoute[];
  /** Absolute entry file → route path, for the import graph. */
  routeEntries(appRoot: string, files: string[], aliases: Alias[]): Map<string, string>;
}

const NEXT_APP_PAGE = /^app\/(.+\/)?page\.(tsx|ts|jsx|js|mdx|md)$/;
const NEXT_PAGES_HIGH = /^pages\/(?!api\/|_)(.+)\.(tsx|ts|jsx|js|mdx|md)$/;
const NEXT_PAGE_FILE = /^(page|layout)\.(tsx|ts|jsx|js|mdx)$/;
const PAGES_INDEX_FILE = /^(index|_app|_document)\.(tsx|ts|jsx|js|mdx)$/;

function stripSrc(rel: string): string {
  return rel.replace(/^src\//, '');
}

function hasNextConfig(root: string): boolean {
  return ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next-env.d.ts'].some(f => fs.existsSync(path.join(root, f)));
}

/** Does `dir` contain a file matching `pattern` within `depth` levels? */
function containsFile(dir: string, pattern: RegExp, depth: number): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  if (entries.some(e => e.isFile() && pattern.test(e.name))) return true;
  if (depth === 0) return false;
  return entries.some(e => e.isDirectory() && !SKIP_DIRS.has(e.name) && containsFile(path.join(dir, e.name), pattern, depth - 1));
}

function appDir(root: string): string | null {
  for (const d of [path.join(root, 'app'), path.join(root, 'src', 'app')]) if (fs.existsSync(d)) return d;
  return null;
}

function pagesDir(root: string): string | null {
  for (const d of [path.join(root, 'pages'), path.join(root, 'src', 'pages')]) if (fs.existsSync(d)) return d;
  return null;
}

/** Entry files under a Next.js router directory, mapped by a regex-first filter. */
function nextEntries(appRoot: string, files: string[], dirName: 'app' | 'pages', pattern: RegExp, rule: (files: string[]) => DetectedRoute[]): Map<string, string> {
  const entries = new Map<string, string>();
  const base = fs.existsSync(path.join(appRoot, 'src', dirName)) ? path.join(appRoot, 'src') : appRoot;
  const prefix = path.join(base, dirName) + path.sep;
  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    const rel = toPosix(path.relative(base, file));
    if (!pattern.test(rel)) continue;
    const route = rule([rel])[0];
    if (route) entries.set(file, route.path);
  }
  return entries;
}

const FRAMEWORKS: FrameworkAdapter[] = [
  {
    name: 'nextjs-app',
    matches: root => {
      const dir = appDir(root);
      if (!dir) return false;
      return hasDependency(root, 'next') || hasNextConfig(root) || containsFile(dir, NEXT_PAGE_FILE, 4);
    },
    normalize: stripSrc,
    directRoutes: detectAppRouterRoutes,
    routeEntries: (appRoot, files) => nextEntries(appRoot, files, 'app', NEXT_APP_PAGE, detectAppRouterRoutes),
  },
  {
    name: 'nextjs-pages',
    matches: root => {
      const dir = pagesDir(root);
      if (!dir || hasDependency(root, 'vite')) return false;
      return hasDependency(root, 'next') || hasNextConfig(root) || containsFile(dir, PAGES_INDEX_FILE, 1);
    },
    normalize: stripSrc,
    directRoutes: detectPagesRouterRoutes,
    routeEntries: (appRoot, files) => nextEntries(appRoot, files, 'pages', NEXT_PAGES_HIGH, detectPagesRouterRoutes),
  },
  {
    name: 'vite',
    matches: isViteApp,
    normalize: rel => rel,
    directRoutes: detectGenericRoutes,
    routeEntries: viteRouteEntries,
  },
  {
    name: 'generic',
    matches: () => true,
    normalize: rel => rel,
    directRoutes: detectGenericRoutes,
    routeEntries: () => new Map(),
  },
];

function adapterFor(name: Framework): FrameworkAdapter {
  return FRAMEWORKS.find(f => f.name === name) ?? FRAMEWORKS[FRAMEWORKS.length - 1];
}

/**
 * Can this directory actually be served as an app? A dev script is the same
 * test baseline.ts uses before serving a base commit, so detection and serving
 * agree; a recognised framework counts too, for apps started some other way.
 */
export function isServableApp(root: string): boolean {
  return devScript(root) !== null || frameworkForRoot(root) !== 'generic';
}

export function frameworkForRoot(root: string): Framework {
  return FRAMEWORKS.find(f => f.matches(root))!.name;
}

// ============================================================
// App roots
// ============================================================

const APP_SCAN_DEPTH = 3;

/**
 * Directory names that can look like an app but never are the one under
 * review. Test fixtures in particular are whole little apps, and a PR touching
 * them can easily out-number the real app in the diff.
 */
const NON_APP_DIRS = new Set(['tests', 'test', '__tests__', 'fixtures', 'examples', 'example', 'e2e', 'cypress', 'playwright']);

/** Directories (depth ≤ 3) that look like an app: package.json, or app/ pages/ route folders. */
export function findAppRoots(baseDir: string): string[] {
  const roots: string[] = [];
  const walk = (dir: string, depth: number) => {
    // A package.json marks an app; so do app/ or pages/ route folders, except inside src/
    // (src/app belongs to the package one level up).
    const isSrc = path.basename(dir) === 'src';
    if (fs.existsSync(path.join(dir, 'package.json')) || (!isSrc && (appDir(dir) || pagesDir(dir)))) roots.push(dir);
    if (depth === 0) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !NON_APP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        walk(path.join(dir, entry.name), depth - 1);
      }
    }
  };
  walk(baseDir, APP_SCAN_DEPTH);
  return roots;
}

/**
 * Auto-detect the framework used in the project: the most specific framework
 * any app root matches, in adapter order.
 */
export function detectFramework(rootDir?: string): Framework {
  const found = findAppRoots(rootDir || process.cwd()).map(frameworkForRoot);
  return FRAMEWORKS.find(f => found.includes(f.name))?.name ?? 'generic';
}

// ============================================================
// Ranking
// ============================================================

const CONFIDENCE_ORDER = { high: 0, medium: 1, low: 2 };

export function deduplicateRoutes(routes: DetectedRoute[]): DetectedRoute[] {
  const byPath = new Map<string, DetectedRoute>();
  for (const route of routes) {
    const existing = byPath.get(route.path);
    if (!existing || CONFIDENCE_ORDER[route.confidence] < CONFIDENCE_ORDER[existing.confidence]) {
      byPath.set(route.path, route);
    }
  }
  return Array.from(byPath.values());
}

function rankAndCap(routes: DetectedRoute[], maxRoutes: number, warn?: (msg: string) => void): DetectedRoute[] {
  let out = deduplicateRoutes(routes);
  out.sort((a, b) => CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence] || a.path.localeCompare(b.path));
  if (out.length > maxRoutes) {
    const original = out.length;
    out = out.slice(0, maxRoutes);
    warn?.(`Detected ${original} routes, capping at ${maxRoutes}. Use --max-routes to increase.`);
  }
  return out;
}

export function isDynamicRoute(route: string): boolean {
  return /[[\]:*]/.test(route);
}

/** Apply a sample URL for a dynamic route; returns the route unchanged when static. */
export function resolveSample(route: string, samples: Record<string, string> = {}): string {
  return samples[route] ?? route;
}

// ============================================================
// File-list API (framework rules only, no import graph)
// ============================================================

export function getChangedFiles(diffTarget?: string, cwd = process.cwd()): string[] {
  try {
    return gitChangedFiles(cwd, diffTarget);
  } catch {
    return [];
  }
}

export function detectRoutes(changedFiles: string[], options: RouteDetectionOptions = {}): DetectedRoute[] {
  if (changedFiles.length === 0) return [];
  const adapter = adapterFor(options.framework || detectFramework());
  return rankAndCap(adapter.directRoutes(changedFiles.map(adapter.normalize)), options.maxRoutes ?? CONFIG_DEFAULTS.maxRoutes, options.log);
}

// ============================================================
// Repo-aware detection (import graph, monorepo, samples)
// ============================================================

export interface RepoRouteDetection {
  framework: Framework;
  appRoot: string;
  changedFiles: string[];
  routes: DetectedRoute[];
  /** Dynamic routes with no sample URL configured */
  skippedDynamic: string[];
  /** Milliseconds spent */
  durationMs: number;
}

export interface RepoDetectionOptions {
  cwd?: string;
  config?: PrePostConfig;
  framework?: Framework;
  maxRoutes?: number;
  diffTarget?: string;
  /** Override changed files (tests) */
  changedFiles?: string[];
  /** Where warnings go. Left unset, they are silent — --json must stay parseable. */
  log?: (msg: string) => void;
}

/** For a layout-only route (no page of its own), the closest static page beneath it. */
function nearestPageRoute(route: string, knownRoutes: string[]): string | null {
  if (knownRoutes.includes(route)) return route;
  const prefix = route === '/' ? '/' : route + '/';
  return knownRoutes.find(r => r.startsWith(prefix) && !isDynamicRoute(r)) ?? null;
}

export function detectRoutesForRepo(options: RepoDetectionOptions = {}): RepoRouteDetection {
  const started = Date.now();
  const root = gitRepoRoot(options.cwd || process.cwd());
  const config = options.config || {};
  const maxRoutes = options.maxRoutes ?? config.maxRoutes ?? CONFIG_DEFAULTS.maxRoutes;

  const ignore = (config.ignore || []).map(p => p.replace(/^\.?\//, ''));
  const allChanged = (options.changedFiles ?? gitChangedFiles(root, options.diffTarget))
    // Our own config file is written mid-run; it never affects which routes changed.
    .filter(f => f !== CONFIG_FILENAME)
    .filter(f => !ignore.some(prefix => f === prefix || f.startsWith(prefix.replace(/\/?$/, '/'))));

  // Choose the app root the PR is about. The repo root contains every changed
  // file, so it would always match at least as many as any app nested inside
  // it; score the nested app roots only, and fall back to the repo root when
  // none of them owns a changed file.
  //
  // Servability outranks file count. Counting alone once picked this repo's
  // own tests/fixtures over its marketing site by a single file, and then
  // reported routes for a directory nothing can serve. A directory that cannot
  // be served is not the app a branch changed, however much of the diff lands
  // in it; among candidates that can be served, the diff decides, deepest
  // first on a tie.
  const scored = findAppRoots(root)
    .map(dir => ({ dir, rel: toPosix(path.relative(root, dir)) }))
    .filter(c => c.rel)
    .map(c => ({
      dir: c.dir,
      count: allChanged.filter(f => f.startsWith(c.rel + '/')).length,
      servable: isServableApp(c.dir),
    }))
    .filter(c => c.count > 0)
    .sort((a, b) =>
      Number(b.servable) - Number(a.servable)
      || b.count - a.count
      || b.dir.length - a.dir.length);
  const appRoot = scored[0]?.dir ?? root;
  const adapter = adapterFor(options.framework || frameworkForRoot(appRoot));
  const appPrefix = toPosix(path.relative(root, appRoot));
  const appRel = allChanged
    .filter(f => !appPrefix || f.startsWith(appPrefix + '/'))
    .map(f => (appPrefix ? f.slice(appPrefix.length + 1) : f));

  const routes: DetectedRoute[] = [];

  // Always-on routes from config.
  for (const r of config.routes || []) {
    routes.push({ path: r, sourceFile: '.pre-post.json', confidence: 'high', reason: 'Configured route' });
  }

  // Direct framework rules.
  routes.push(...adapter.directRoutes(appRel.map(adapter.normalize)));

  // Import graph: changed files → pages that import them. One walk serves both.
  if (appRel.length) {
    const files = walkSourceFiles(appRoot);
    const aliases = readAliases(appRoot);
    const entries = adapter.routeEntries(appRoot, files, aliases);

    if (entries.size) {
      const graph = buildImportGraph(appRoot, { files, aliases });
      const changedAbs = appRel.map(f => path.join(appRoot, f)).filter(f => graph.files.has(f));
      const affected = findAffectedEntries(graph, changedAbs, f => entries.has(f));
      for (const [entry, { via, depth }] of affected) {
        const viaRel = toPosix(path.relative(appRoot, via));
        const entryRel = toPosix(path.relative(appRoot, entry));
        routes.push({
          path: entries.get(entry)!,
          sourceFile: viaRel,
          confidence: depth === 0 ? 'high' : depth <= 2 ? 'medium' : 'low',
          reason: depth === 0 ? 'Page file changed' : `${entryRel} imports ${viaRel}${depth > 1 ? ` (${depth} hops)` : ''}`,
        });
      }

      // Layout/special-file routes may not have a page of their own; snap them to the nearest page.
      const known = Array.from(new Set(entries.values())).sort((a, b) => a.length - b.length);
      const knownSet = new Set(known);
      for (const r of routes) {
        if (!knownSet.has(r.path)) {
          const snapped = nearestPageRoute(r.path, known);
          if (snapped) r.path = snapped;
        }
      }
    }
  }

  // Fallback: something changed in the app but nothing mapped → home page, low confidence.
  if (routes.length === 0 && appRel.length > 0) {
    routes.push({ path: '/', sourceFile: appRel[0], confidence: 'low', reason: 'No route mapping found; defaulting to /' });
  }

  // Dynamic routes: use samples or skip.
  const samples = config.samples || {};
  const skippedDynamic = new Set<string>();
  const resolved: DetectedRoute[] = [];
  for (const r of deduplicateRoutes(routes)) {
    if (!isDynamicRoute(r.path)) resolved.push(r);
    else if (samples[r.path]) resolved.push({ ...r, reason: `${r.reason} (sample: ${samples[r.path]})` });
    else skippedDynamic.add(r.path);
  }

  return {
    framework: adapter.name,
    appRoot,
    changedFiles: allChanged,
    routes: rankAndCap(resolved, maxRoutes, options.log),
    skippedDynamic: Array.from(skippedDynamic),
    durationMs: Date.now() - started,
  };
}
