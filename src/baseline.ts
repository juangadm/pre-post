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
import { readPackage } from './pkg.js';

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

const MANAGERS: Array<{ lockfile: string; pm: PackageManager }> = [
  { lockfile: 'pnpm-lock.yaml', pm: { bin: 'pnpm', install: ['install', '--prefer-offline'], run: (s, a) => ['run', s, ...a] } },
  { lockfile: 'yarn.lock', pm: { bin: 'yarn', install: ['install'], run: (s, a) => ['run', s, ...a] } },
  { lockfile: 'bun.lockb', pm: { bin: 'bun', install: ['install'], run: (s, a) => ['run', s, ...a] } },
  { lockfile: 'package-lock.json', pm: { bin: 'npm', install: ['install'], run: (s, a) => ['run', s, '--', ...a] } },
];

const NPM: PackageManager = MANAGERS[MANAGERS.length - 1].pm;

/** Which package manager this tree uses, from its lockfile. Defaults to npm. */
export function detectPackageManager(dir: string, repoRoot?: string): PackageManager {
  for (const candidate of [dir, repoRoot].filter(Boolean) as string[]) {
    for (const { lockfile, pm } of MANAGERS) {
      if (fs.existsSync(path.join(candidate, lockfile))) return pm;
    }
  }
  return NPM;
}

/** The script that starts a dev server, preferring `dev`. */
export function devScript(dir: string): string | null {
  const scripts = readPackage(dir)?.scripts as Record<string, string> | undefined;
  if (!scripts) return null;
  return ['dev', 'start:dev', 'serve', 'start'].find(name => typeof scripts[name] === 'string') ?? null;
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
  /** Commit to serve — the PR's base. */
  sha: string;
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
  const log = opts.log ?? (() => undefined);
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const deadline = Date.now() + timeoutMs;

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-base-'));
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
    try {
      execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: opts.repoRoot, stdio: 'ignore' });
    } catch {
      fs.rmSync(worktree, { recursive: true, force: true });
    }
  };

  try {
    execFileSync('git', ['worktree', 'add', '--detach', '--force', worktree, opts.sha], { cwd: opts.repoRoot, stdio: 'ignore' });
  } catch {
    await cleanup();
    return null;
  }

  const appDir = opts.appPrefix ? path.join(worktree, opts.appPrefix) : worktree;
  const script = devScript(appDir);
  if (!script) {
    await cleanup();
    return null;
  }

  const pm = detectPackageManager(appDir, worktree);
  log(`Pre: building ${opts.sha.slice(0, 7)} locally (${pm.bin} ${script}) ...`);
  try {
    execFileSync(pm.bin, pm.install, { cwd: appDir, stdio: 'ignore', timeout: Math.max(1, deadline - Date.now()) });
  } catch {
    await cleanup();
    return null;
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
    return null;
  }
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.once('exit', onSignal);
  return { url, stop: cleanup };
}
