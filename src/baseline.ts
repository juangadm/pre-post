/**
 * Serve the PR's base commit locally, as the "Pre" side.
 *
 * This is the baseline that always works: it needs no deployment, no
 * production URL and no network, so it is what keeps pre-post usable inside a
 * sandbox — a cloud agent container, a CI job, or any box behind an egress
 * allowlist. It is also the most honest comparison available, because both
 * sides then render in the same environment with the same fonts and the same
 * browser, leaving the diff as the only variable.
 *
 * The cost is time: a checkout, an install and a dev-server boot. So callers
 * reach for it after a reachable deployment, not before one.
 */

import { spawn, ChildProcess, execFileSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { devScript, readPackage } from './pkg.js';
import { findAppRoots } from './routes.js';

export interface LocalBaseline {
  url: string;
  /** Stop the dev server and delete the worktree. Safe to call twice. */
  stop: () => Promise<void>;
}


interface PackageManager {
  bin: string;
  install: string[];
  /** Build `run <script>` argv, appending extra args the way this manager wants. */
  run: (script: string, args: string[]) => string[];
}

const NPM: PackageManager = { bin: 'npm', install: ['install'], run: (s, a) => ['run', s, '--', ...a] };
const PNPM: PackageManager = { bin: 'pnpm', install: ['install', '--prefer-offline'], run: (s, a) => ['run', s, ...a] };
const YARN: PackageManager = { bin: 'yarn', install: ['install'], run: (s, a) => ['run', s, ...a] };
const BUN: PackageManager = { bin: 'bun', install: ['install'], run: (s, a) => ['run', s, ...a] };

const MANAGERS: Array<{ lockfile: string; pm: PackageManager }> = [
  { lockfile: 'pnpm-lock.yaml', pm: PNPM },
  { lockfile: 'yarn.lock', pm: YARN },
  { lockfile: 'bun.lockb', pm: BUN },
  { lockfile: 'package-lock.json', pm: NPM },
];

const BY_NAME: Record<string, PackageManager> = { npm: NPM, pnpm: PNPM, yarn: YARN, bun: BUN };

/**
 * Which package manager this tree *declares*, from its `packageManager` field
 * or its lockfile. Defaults to npm.
 *
 * The field wins over the lockfile because it is the deliberate statement: a
 * repository mid-migration can carry two lockfiles, but it names one manager.
 */
export function detectPackageManager(dir: string, repoRoot?: string): PackageManager {
  for (const candidate of [dir, repoRoot].filter(Boolean) as string[]) {
    const field = readPackage(candidate)?.packageManager;
    const named = typeof field === 'string' ? BY_NAME[field.split('@')[0].trim()] : undefined;
    if (named) return named;
    for (const { lockfile, pm } of MANAGERS) {
      if (fs.existsSync(path.join(candidate, lockfile))) return pm;
    }
  }
  return NPM;
}

/**
 * Is `bin` runnable here?
 *
 * A PATH scan rather than a `--version` subprocess: this answers before every
 * local baseline, and spawning a process to learn that a process cannot be
 * spawned is the wrong shape.
 */
export function onPath(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  return dirs.some(dir => exts.some(ext => {
    try { return fs.statSync(path.join(dir, bin + ext)).isFile(); } catch { return false; }
  }));
}

export interface ManagerChoice {
  /** The manager that will actually be run. */
  pm: PackageManager;
  /** What the repository declares. Differs from `pm.bin` when we fell back. */
  declared: string;
  /** False when neither the declared manager nor npm is installed here. */
  available: boolean;
}

/**
 * The manager to actually run: what the repository declares, if it is installed.
 *
 * Declaring pnpm does not put pnpm on PATH. On a real machine it was not there,
 * and the local baseline — the fallback that exists for when nothing is
 * deployed — died on `pnpm install` with no hint that the missing piece was
 * pnpm itself. The same shell could still build the CLI, so the tool ran while
 * its last resort could not.
 *
 * npm ships with Node, so it is the fallback with the best odds of being
 * present. It will not honour a pnpm or yarn lockfile, so the baseline it
 * installs can drift from the locked versions — worth saying out loud, and
 * still far better than no baseline at all.
 */
export function resolvePackageManager(
  dir: string,
  repoRoot?: string,
  has: (bin: string) => boolean = onPath,
): ManagerChoice {
  const declared = detectPackageManager(dir, repoRoot);
  if (has(declared.bin)) return { pm: declared, declared: declared.bin, available: true };
  if (has(NPM.bin)) return { pm: NPM, declared: declared.bin, available: true };
  return { pm: declared, declared: declared.bin, available: false };
}

/**
 * The directory to actually serve.
 *
 * The app root is detected from the files a branch changed, which answers
 * "which routes moved" — not "which package can be served". A PR touching only
 * the CLI resolves to the repo root, which has no dev script even though the
 * site next door does. So prefer the detected directory and otherwise take the
 * nearest package that can start a server.
 */
export function servableDir(treeRoot: string, appPrefix?: string): { dir: string; script: string } | null {
  const preferred = appPrefix ? path.join(treeRoot, appPrefix) : treeRoot;
  const preferredScript = devScript(preferred);
  if (preferredScript) return { dir: preferred, script: preferredScript };
  // Deepest first: a workspace app beats the repo root that merely contains it.
  for (const dir of findAppRoots(treeRoot).sort((a, b) => b.length - a.length)) {
    const script = devScript(dir);
    if (script) return { dir, script };
  }
  return null;
}

/** Local env files, in the order a framework would layer them. */
const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local'];

/**
 * Copy the working checkout's local env files into a throwaway worktree.
 *
 * .env files are gitignored, so a fresh worktree of the base commit has none.
 * An app that needs one to boot then either never starts or serves an error
 * page — and an error page diffed against the real branch reports a wall of
 * changes the PR never made, which is worse than reporting no baseline at all.
 *
 * Only ever writes inside `to`, and returns names, never values: these files
 * are exactly the ones that hold secrets.
 */
export function copyEnvFiles(from: string, to: string, appPrefix?: string): string[] {
  const copied: string[] = [];
  const root = path.resolve(to);
  for (const dir of appPrefix ? ['', appPrefix] : ['']) {
    for (const name of ENV_FILES) {
      const src = path.join(from, dir, name);
      const dest = path.resolve(root, dir, name);
      // The worktree is the only place this may write.
      if (dest !== root && !dest.startsWith(root + path.sep)) continue;
      if (!fs.existsSync(src) || fs.existsSync(dest)) continue;
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        copied.push(path.posix.join(dir, name));
      } catch { /* best effort: a missing env file is not fatal on its own */ }
    }
  }
  return copied;
}

/** An OS-assigned free port. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForServer(url: string, timeoutMs: number, alive: () => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive()) return false;
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return false;
}

export interface BaselineOptions {
  repoRoot: string;
  /** Commit to serve. Omit to serve the working tree as it stands. */
  sha?: string;
  /** Directory holding the app's package.json, relative to the repo root. */
  appPrefix?: string;
  /** Budget for install + boot. */
  timeoutMs?: number;
  log?: (msg: string) => void;
}

/**
 * Check out `sha` into a throwaway worktree, install, and start its dev server.
 *
 * Returns null when this repo cannot be served this way (no dev script, no
 * install, server never came up). Callers treat that as "try the next option",
 * so every failure path cleans up after itself and stays quiet.
 */
export async function serveBaseCommit(opts: BaselineOptions): Promise<LocalBaseline | null> {
  return serveLocally(opts);
}

/**
 * Boot this repository's dev server without one already running.
 *
 * The working tree is what the author is looking at, uncommitted edits and all,
 * so it is the honest "Post" when nothing is deployed. Serving it needs no
 * worktree and usually no install, which is why it is cheaper than the base
 * side it gets paired with.
 */
export async function serveWorkingTree(opts: Omit<BaselineOptions, 'sha'>): Promise<LocalBaseline | null> {
  return serveLocally({ ...opts, sha: undefined });
}

async function serveLocally(opts: BaselineOptions): Promise<LocalBaseline | null> {
  const log = opts.log ?? (() => undefined);
  const what = opts.sha ? `base commit ${opts.sha.slice(0, 7)}` : 'the working tree';
  /** Every caller treats null as "try the next option", so say why before returning it. */
  const skip = (detail: string): null => {
    log(`Could not serve ${what}: ${detail}`);
    return null;
  };
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const deadline = Date.now() + timeoutMs;

  const worktree = opts.sha ? fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-base-')) : opts.repoRoot;
  let child: ChildProcess | null = null;
  let stopped = false;

  // A detached dev server survives Ctrl-C and keeps its port, so tear it down
  // on the signals that end the run as well as on the normal path.
  const onSignal = () => { void cleanup(); };
  const untrap = () => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('exit', onSignal);
  };

  const cleanup = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    untrap();
    if (child && child.exitCode === null) {
      try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* already gone */ }
    }
    // Guard on the thing that actually matters: only a throwaway worktree may be
    // removed. Checking `opts.sha` instead would let any future caller that
    // points `worktree` at a real checkout delete uncommitted work.
    if (worktree === opts.repoRoot) return;
    try {
      execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: opts.repoRoot, stdio: 'ignore' });
    } catch {
      fs.rmSync(worktree, { recursive: true, force: true });
    }
  };

  if (opts.sha) {
    try {
      execFileSync('git', ['worktree', 'add', '--detach', '--force', worktree, opts.sha], { cwd: opts.repoRoot, stdio: 'ignore' });
    } catch {
      await cleanup();
      return skip('the worktree checkout failed.');
    }
    const copied = copyEnvFiles(opts.repoRoot, worktree, opts.appPrefix);
    if (copied.length) log(`Using local env file(s) for the baseline: ${copied.join(', ')}`);
  }

  const app = servableDir(worktree, opts.appPrefix);
  if (!app) {
    await cleanup();
    return skip('no package with a dev, serve or start script was found.');
  }
  const { dir: appDir, script } = app;

  const { pm, declared, available } = resolvePackageManager(appDir, worktree);
  // The worktree is a throwaway that cleanup deletes on the way out, so every
  // "run it by hand" below names the same directory in the caller's own
  // checkout instead — the one that will still be there to run it in.
  const appIn = path.join(opts.repoRoot, path.relative(worktree, appDir));
  if (!available) {
    await cleanup();
    return skip(`neither ${declared} nor npm is on PATH, so nothing can install ${path.relative(opts.repoRoot, appIn) || 'the repository'}.`);
  }
  if (pm.bin !== declared) {
    log(`${declared} is not on PATH; installing the baseline with ${pm.bin} instead (it will not honour the ${declared} lockfile).`);
  }
  log(`Starting a dev server for ${what} (${pm.bin} ${script}) ...`);
  if (!fs.existsSync(path.join(appDir, 'node_modules'))) {
    try {
      execFileSync(pm.bin, pm.install, { cwd: appDir, stdio: 'ignore', timeout: Math.max(1, deadline - Date.now()) });
    } catch {
      await cleanup();
      return skip(`\`${pm.bin} ${pm.install.join(' ')}\` failed. Run it in ${appIn} to see why.`);
    }
  }

  const port = await freePort();
  const url = `http://localhost:${port}`;
  child = spawn(pm.bin, pm.run(script, ['--port', String(port)]), {
    cwd: appDir,
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, PORT: String(port), BROWSER: 'none' },
  });
  child.unref();

  const ready = await waitForServer(url, Math.max(1, deadline - Date.now()), () => !!child && child.exitCode === null);
  if (!ready) {
    await cleanup();
    return skip(`${pm.bin} ${script} did not start serving within ${Math.round(timeoutMs / 1000)}s (missing env vars are the usual cause).`);
  }
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.once('exit', onSignal);
  return { url, stop: cleanup };
}
