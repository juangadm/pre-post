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
import { NeedsHumanError } from './errors.js';
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
  /**
   * A second install to try, and the failure that earns it — or undefined when
   * this manager has no looser mode.
   *
   * Both halves together, because apart they drift: a predicate matching npm's
   * `ERESOLVE` sitting at module scope would be applied to whichever managers
   * happened to have a retry argv, which is right today only because npm is
   * the only one that does.
   *
   * Only npm needs one. npm 7+ treats a peer range as a hard constraint and
   * aborts the whole install over a single lagging package; pnpm, yarn and bun
   * warn and carry on. A React 19 app with one dependency whose peer range
   * still says <=18 is an ordinary, temporary state of a real repository — and
   * it took the local baseline, the fallback that is supposed to always work,
   * down with it.
   */
  retry?: { argv: string[]; when: (output: string) => boolean };
}

const NPM: PackageManager = { bin: 'npm', install: ['install'], retry: { argv: ['install', '--legacy-peer-deps'], when: isPeerConflict }, run: (s, a) => ['run', s, '--', ...a] };
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
    // throwIfNoEntry keeps the common case (a miss) from constructing an
    // exception; the catch stays for the rarer EACCES/ELOOP.
    try { return fs.statSync(path.join(dir, bin + ext), { throwIfNoEntry: false })?.isFile() ?? false; } catch { return false; }
  }));
}

export interface ManagerChoice {
  /** The manager to run, or null when neither it nor npm is installed here. */
  pm: PackageManager | null;
  /** What the repository declares. Differs from `pm` when we fell back. */
  declared: PackageManager;
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
  if (has(declared.bin)) return { pm: declared, declared };
  return { pm: has(NPM.bin) ? NPM : null, declared };
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

/**
 * How a package manager's install ended, and what it said.
 *
 * The output is kept because it is the only thing that can answer "why". The
 * old path discarded it (`stdio: 'ignore'`) and told the reader to run the
 * install themselves in their checkout — advice that could not reproduce the
 * failure, because the install had run in a throwaway worktree that was
 * already deleted by the time they read it.
 */
export interface InstallAttempt {
  argv: string[];
  ok: boolean;
  /** The tail of the manager's own stdout+stderr. */
  output: string;
}

export interface InstallResult {
  ok: boolean;
  /** In order. Length 2 when a first failure earned a retry. */
  attempts: InstallAttempt[];
}

export type InstallRunner = (bin: string, argv: string[], cwd: string, timeoutMs: number) => InstallAttempt;

/** Keep the end of the output: managers put the diagnosis last. */
function tail(text: string, lines = 24): string {
  const kept = text.replace(/\s+$/, '').split('\n').slice(-lines);
  return kept.join('\n').trim();
}

/**
 * Room for the noisiest install that still works.
 *
 * Node's default is 1 MiB per stream, and exceeding it kills the child with
 * ENOBUFS — which this code would read as a failed install. A verbose set of
 * postinstall scripts must not be the reason a baseline cannot be built, and
 * the buffer is transient and freed as soon as the tail is taken.
 */
const MAX_INSTALL_OUTPUT = 64 * 1024 * 1024;

const runInstall: InstallRunner = (bin, argv, cwd, timeoutMs) => {
  try {
    execFileSync(bin, argv, { cwd, timeout: Math.max(1, timeoutMs), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MAX_INSTALL_OUTPUT });
    // Only a failure has anything to explain, so the successful install's log
    // is dropped rather than split into lines nothing will read.
    return { argv, ok: true, output: '' };
  } catch (err) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    const output = [e.stdout, e.stderr].map(part => (part ? String(part) : '')).join('');
    return { argv, ok: false, output: tail(output || e.message || '') };
  }
};

/**
 * Does this look like npm refusing to resolve a peer range?
 *
 * Matched on npm's own error code rather than on prose, so it does not depend
 * on the wording of a given npm release. The second pattern is the same
 * failure as reported by older npm, which does not always print the code.
 */
export function isPeerConflict(output: string): boolean {
  return /ERESOLVE/i.test(output) || /could not resolve dependency/i.test(output);
}

/**
 * Install this app's dependencies, retrying once past a peer-dependency wall.
 *
 * The retry is deliberately narrow: only on the specific failure that a looser
 * resolver would not have had, and only for a manager that has a looser mode.
 * A baseline installed with `--legacy-peer-deps` is not a perfect reproduction
 * of the branch's own install — but the alternative is no baseline at all, and
 * the comparison this tool exists to make is between two renders of the same
 * app, not between two dependency trees.
 */
export function installDeps(
  pm: PackageManager,
  cwd: string,
  timeoutMs: number,
  run: InstallRunner = runInstall,
): InstallResult {
  const deadline = Date.now() + timeoutMs;
  const first = run(pm.bin, pm.install, cwd, timeoutMs);
  if (first.ok || !pm.retry?.when(first.output)) return { ok: first.ok, attempts: [first] };
  // The remainder of the original budget, not a fresh one: a first attempt
  // that burned the clock must not let the retry double the wall time.
  const second = run(pm.bin, pm.retry.argv, cwd, deadline - Date.now());
  return { ok: second.ok, attempts: [first, second] };
}

/**
 * The install failed and nothing else can rescue this run.
 *
 * Its own error rather than a quiet null, for the reason docs/portability.md
 * §1 gives about base resolution: a run that compared nothing must not exit
 * clean. A null here fell through to "no baseline", and on a repository with a
 * configured production URL it fell through to comparing against that instead
 * — a different answer to a different question, published as if it were this
 * one.
 */
function installFailureMessage(result: InstallResult, where: string, ranIn: string, throwaway: boolean): string {
  const [first, retried] = result.attempts;
  const last = retried ?? first;
  const tried = result.attempts.map(a => `\`${a.argv.join(' ')}\``).join(', then ');
  const lines = [`Could not install ${where}: ${tried} failed.`];
  // Naming the worktree would be useless: cleanup has already deleted it. What
  // the reader needs is that their own checkout is not what failed.
  lines.push(throwaway
    ? `That install ran in a throwaway worktree of the base commit, not in ${ranIn}, so the same command may well succeed in your checkout.`
    : `It ran in ${ranIn}.`);
  // The flag comes from the manager record rather than a second copy of it
  // here, so a change to the retry cannot leave this sentence naming a flag
  // that was never run.
  if (retried) lines.push(`The retry with ${retried.argv[retried.argv.length - 1]} did not clear it either.`);
  return `${lines.join('\n')}\n\n${last.output}`;
}

export class BaselineInstallError extends NeedsHumanError {
  constructor(public readonly result: InstallResult, where: string, ranIn: string, throwaway: boolean) {
    super(installFailureMessage(result, where, ranIn, throwaway));
    this.name = 'BaselineInstallError';
  }
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
  /** Injectable for tests; defaults to a real PATH scan. */
  pathHas?: (bin: string) => boolean;
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

  const { pm, declared } = resolvePackageManager(appDir, worktree, opts.pathHas);
  const rel = path.relative(worktree, appDir);
  // The worktree is a throwaway that cleanup deletes on the way out, so every
  // "run it by hand" below names the same directory in the caller's own
  // checkout instead — the one that will still be there to run it in.
  const appIn = path.join(opts.repoRoot, rel);
  const where = rel || 'the repository';
  if (!pm) {
    await cleanup();
    return skip(`neither ${declared.bin} nor npm is on PATH, so nothing can install ${where}.`);
  }

  const install = !fs.existsSync(path.join(appDir, 'node_modules'));
  // Substituting npm for the declared manager is safe in a throwaway worktree
  // and not in the caller's own checkout: npm cannot share a node_modules with
  // pnpm, so installing over their tree leaves the working copy broken — the
  // state the README tells people to `rm -rf node_modules` out of. Taking
  // screenshots must not cost someone their install, so this stops instead.
  // Only the install is dangerous; running a script against a tree that is
  // already installed is not, which is why this asks about both.
  if (pm !== declared && install && worktree === opts.repoRoot) {
    await cleanup();
    return skip(`${declared.bin} is not on PATH, and installing ${where} with npm instead would leave a node_modules your ${declared.bin} cannot use. Install ${declared.bin}, or run \`${declared.bin} install\` in ${appIn}.`);
  }
  if (pm !== declared) {
    log(`${declared.bin} is not on PATH; installing the baseline with ${pm.bin} instead (it will not honour the ${declared.bin} lockfile).`);
  }
  log(`Starting a dev server for ${what} (${pm.bin} ${script}) ...`);
  if (install) {
    const result = installDeps(pm, appDir, deadline - Date.now());
    if (!result.ok) {
      await cleanup();
      throw new BaselineInstallError(result, where, appIn, worktree !== opts.repoRoot);
    }
    const retried = result.attempts[1];
    if (retried) {
      log(`\`${pm.bin} ${pm.install.join(' ')}\` hit a peer-dependency conflict; installed the baseline with \`${retried.argv.join(' ')}\` instead.`);
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
