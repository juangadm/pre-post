/**
 * Lightweight import graph. Regex-based (no TypeScript compiler), fast enough
 * to scan a few thousand files in well under a second, and good enough to
 * answer "which page files transitively import this changed file?".
 */

import fs from 'fs';
import path from 'path';

export const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.astro', '.mdx', '.md'];
const RESOLVE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.astro', '.mdx', '.md', '.css', '.scss', '.json'];

export const SKIP_DIRS = new Set([
  '.git', '.next', '.nuxt', '.svelte-kit', '.turbo', '.vercel', '.cache', 'node_modules',
  'dist', 'build', 'out', 'coverage', 'public', 'storybook-static', '.storybook', '__snapshots__',
]);

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export interface ImportGraph {
  /** Absolute paths of every scanned source file */
  files: Set<string>;
  /** file → files that import it (absolute paths) */
  importers: Map<string, Set<string>>;
}

export interface Alias {
  /** Prefix such as "@/" or "~/" */
  prefix: string;
  /** Absolute directories to try, in order */
  targets: string[];
}

const SPECIFIER_PATTERNS = [
  /(?:^|[^\w$.])(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"\n]+)['"]/g,
  /import\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /require\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];

/** Very lenient JSON parse for tsconfig/jsconfig (comments + trailing commas). */
function parseJsonc(text: string): any {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
    .replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

/**
 * Read path aliases from tsconfig.json / jsconfig.json (one level of `extends`).
 */
export function readAliases(appRoot: string): Alias[] {
  const aliases: Alias[] = [];
  const seen = new Set<string>();

  const visit = (file: string, depth: number) => {
    if (depth > 2 || seen.has(file) || !fs.existsSync(file)) return;
    seen.add(file);
    const cfg = parseJsonc(fs.readFileSync(file, 'utf-8'));
    if (!cfg) return;
    const dir = path.dirname(file);
    const baseUrl = cfg.compilerOptions?.baseUrl ? path.resolve(dir, cfg.compilerOptions.baseUrl) : dir;
    const paths: Record<string, string[]> = cfg.compilerOptions?.paths || {};
    for (const [pattern, targets] of Object.entries(paths)) {
      const prefix = pattern.replace(/\*$/, '');
      aliases.push({
        prefix,
        targets: (targets || []).map(t => path.resolve(baseUrl, t.replace(/\*$/, ''))),
      });
    }
    if (cfg.compilerOptions?.baseUrl) {
      aliases.push({ prefix: '', targets: [baseUrl] });
    }
    if (typeof cfg.extends === 'string' && cfg.extends.startsWith('.')) {
      visit(path.resolve(dir, cfg.extends.endsWith('.json') ? cfg.extends : `${cfg.extends}.json`), depth + 1);
    }
  };

  visit(path.join(appRoot, 'tsconfig.json'), 0);
  visit(path.join(appRoot, 'jsconfig.json'), 0);

  // Common conventions even without tsconfig paths.
  for (const conv of ['@/', '~/']) {
    if (!aliases.some(a => a.prefix === conv)) {
      const targets = [path.join(appRoot, 'src'), appRoot].filter(d => fs.existsSync(d));
      aliases.push({ prefix: conv, targets });
    }
  }
  // Longest prefix first; the bare baseUrl fallback last.
  return aliases.sort((a, b) => b.prefix.length - a.prefix.length);
}

function resolveFile(base: string, files: Set<string>): string | null {
  if (files.has(base)) return base;
  for (const ext of RESOLVE_EXTENSIONS) {
    if (files.has(base + ext)) return base + ext;
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    const idx = path.join(base, `index${ext}`);
    if (files.has(idx)) return idx;
  }
  return null;
}

export function resolveSpecifier(spec: string, fromFile: string, files: Set<string>, aliases: Alias[]): string | null {
  const clean = spec.split('?')[0].split('#')[0];
  if (!clean) return null;
  if (clean.startsWith('.') || clean.startsWith('/')) {
    const base = clean.startsWith('/') ? clean : path.resolve(path.dirname(fromFile), clean);
    return resolveFile(base, files);
  }
  for (const alias of aliases) {
    if (alias.prefix && !clean.startsWith(alias.prefix)) continue;
    if (!alias.prefix && (clean.startsWith('@') || !/^[\w-]+[/]/.test(clean) && !/^[\w-]+$/.test(clean))) continue;
    const rest = clean.slice(alias.prefix.length);
    for (const target of alias.targets) {
      const found = resolveFile(path.join(target, rest), files);
      if (found) return found;
    }
  }
  return null;
}

export function walkSourceFiles(root: string, maxFiles = 8000): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) stack.push(path.join(dir, entry.name));
      } else if (entry.isFile() && SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
        out.push(path.join(dir, entry.name));
      }
    }
  }
  return out;
}

export function extractSpecifiers(source: string): string[] {
  const specs: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(source))) specs.push(m[1]);
  }
  return specs;
}

/**
 * Build the reverse import graph for every source file under `appRoot`.
 */
export function buildImportGraph(appRoot: string, options: { files?: string[]; aliases?: Alias[] } = {}): ImportGraph {
  const list = options.files ?? walkSourceFiles(appRoot);
  const files = new Set(list);
  const aliases = options.aliases ?? readAliases(appRoot);
  const importers = new Map<string, Set<string>>();

  for (const file of list) {
    let source: string;
    try {
      source = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    for (const spec of extractSpecifiers(source)) {
      const target = resolveSpecifier(spec, file, files, aliases);
      if (!target || target === file) continue;
      let set = importers.get(target);
      if (!set) importers.set(target, (set = new Set()));
      set.add(file);
    }
  }
  return { files, importers };
}

export interface AffectedEntry {
  /** The changed file that led here */
  via: string;
  /** Number of import hops from the changed file (0 = the entry itself changed) */
  depth: number;
}

/**
 * Walk importers from each changed file until entry files are reached.
 * Returns entry → closest (changed file, depth).
 */
export function findAffectedEntries(
  graph: ImportGraph,
  changed: string[],
  isEntry: (file: string) => boolean,
  maxDepth = 8,
): Map<string, AffectedEntry> {
  const result = new Map<string, AffectedEntry>();
  const record = (entry: string, via: string, depth: number) => {
    const existing = result.get(entry);
    if (!existing || depth < existing.depth) result.set(entry, { via, depth });
  };

  for (const origin of changed) {
    const visited = new Set<string>([origin]);
    let frontier = [origin];
    if (isEntry(origin)) record(origin, origin, 0);
    for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
      const next: string[] = [];
      for (const file of frontier) {
        for (const importer of graph.importers.get(file) ?? []) {
          if (visited.has(importer)) continue;
          visited.add(importer);
          if (isEntry(importer)) record(importer, origin, depth);
          next.push(importer);
        }
      }
      frontier = next;
    }
  }
  return result;
}
