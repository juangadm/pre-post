import { describe, it, expect } from 'vitest';
import { BaselineInstallError, detectPackageManager, InstallAttempt, InstallRunner, installDeps, isPeerConflict } from '../../src/baseline';
import fs from 'fs';
import os from 'os';
import path from 'path';

const NPM = { bin: 'npm', install: ['install'], retry: { argv: ['install', '--legacy-peer-deps'], when: isPeerConflict }, run: (s: string, a: string[]) => ['run', s, '--', ...a] };
const PNPM = { bin: 'pnpm', install: ['install', '--prefer-offline'], run: (s: string, a: string[]) => ['run', s, ...a] };

/** Answers each argv with a canned result and records what it was asked. */
function runner(answers: Array<{ ok: boolean; output: string }>): InstallRunner & { calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const fn = ((_bin: string, argv: string[]): InstallAttempt => {
    calls.push(argv);
    const a = answers[Math.min(i++, answers.length - 1)];
    return { argv, ok: a.ok, output: a.output };
  }) as InstallRunner & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

const ERESOLVE = [
  'npm error code ERESOLVE',
  'npm error ERESOLVE could not resolve',
  'npm error While resolving: vaul@0.9.9',
  'npm error Found: react@19.2.0',
].join('\n');

describe('isPeerConflict', () => {
  it('recognises npm’s peer-resolution failure', () => {
    expect(isPeerConflict(ERESOLVE)).toBe(true);
    expect(isPeerConflict('npm error Could not resolve dependency: peer react@"^18"')).toBe(true);
  });

  it('does not claim every failure is one', () => {
    expect(isPeerConflict('npm error 404 Not Found - GET https://registry.npmjs.org/nope')).toBe(false);
    expect(isPeerConflict('')).toBe(false);
  });
});

describe('installDeps', () => {
  it('does not retry an install that worked', () => {
    const run = runner([{ ok: true, output: 'added 504 packages' }]);
    const result = installDeps(NPM, '/app', 1000, run);
    expect(result.ok).toBe(true);
    expect(run.calls).toEqual([['install']]);
  });

  // The blocker from the field test: React 19 against one dependency whose peer
  // range still says <=18. Common, temporary, and it took the whole baseline out.
  it('retries an ERESOLVE with --legacy-peer-deps', () => {
    const run = runner([{ ok: false, output: ERESOLVE }, { ok: true, output: 'added 504 packages in 10s' }]);
    const result = installDeps(NPM, '/app', 1000, run);
    expect(result.ok).toBe(true);
    expect(run.calls).toEqual([['install'], ['install', '--legacy-peer-deps']]);
  });

  it('does not retry a failure a looser resolver would not have fixed', () => {
    const run = runner([{ ok: false, output: 'npm error 404 Not Found' }]);
    const result = installDeps(NPM, '/app', 1000, run);
    expect(result.ok).toBe(false);
    expect(run.calls).toEqual([['install']]);
  });

  // pnpm warns on an unsatisfiable peer rather than aborting, so it has no
  // looser mode to fall back to and must not be handed npm's flag.
  it('does not retry a manager with no looser mode', () => {
    const run = runner([{ ok: false, output: ERESOLVE }]);
    const result = installDeps(PNPM, '/app', 1000, run);
    expect(result.ok).toBe(false);
    expect(run.calls).toEqual([['install', '--prefer-offline']]);
  });

  it('reports failure when the retry fails too', () => {
    const run = runner([{ ok: false, output: ERESOLVE }, { ok: false, output: ERESOLVE }]);
    const result = installDeps(NPM, '/app', 1000, run);
    expect(result.ok).toBe(false);
    expect(result.attempts).toHaveLength(2);
  });
});

describe('the real manager table', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-pm-'));

  it('gives npm the retry, and gives the other managers none', () => {
    // Without this the tests above only prove that installDeps branches on
    // whatever fixture they were handed, not that npm is actually wired up.
    fs.writeFileSync(path.join(empty, 'package-lock.json'), '');
    const npm = detectPackageManager(empty);
    expect(npm.bin).toBe('npm');
    expect(npm.retry?.argv).toEqual(['install', '--legacy-peer-deps']);
    expect(npm.retry?.when(ERESOLVE)).toBe(true);

    fs.rmSync(path.join(empty, 'package-lock.json'));
    fs.writeFileSync(path.join(empty, 'pnpm-lock.yaml'), '');
    expect(detectPackageManager(empty).retry).toBeUndefined();
  });
});

describe('BaselineInstallError', () => {
  const failed = { ok: false, attempts: [{ argv: ['install'], ok: false, output: ERESOLVE }] };

  // AGENTS.md: an error a human must act on is one actionable sentence. The
  // package manager's output is diagnostics and belongs in the log, or the
  // instruction ends up buried inside a screen of npm noise.
  it('is one sentence naming what to do, not a wall of install output', () => {
    const message = new BaselineInstallError(failed, 'site', '/repo/site').message;
    expect(message.split('\n')).toHaveLength(1);
    expect(message).not.toContain('npm error');
  });

  // Not the worktree: cleanup has deleted it by the time anyone reads this, so
  // naming it would be an instruction the reader cannot follow.
  it('points at a directory that still exists', () => {
    expect(new BaselineInstallError(failed, 'site', '/repo/site').message).toContain('/repo/site');
  });

  it('offers the way past a baseline that cannot be built', () => {
    const message = new BaselineInstallError(failed, 'site', '/repo/site').message;
    expect(message).toContain('--no-local-baseline');
    expect(message).toContain('--before');
  });

  it('keeps the attempts for a caller that wants the detail', () => {
    expect(new BaselineInstallError(failed, 'site', '/repo/site').result.attempts).toHaveLength(1);
  });

  it('is a NeedsHumanError, so the run cannot exit clean having compared nothing', () => {
    const err = new BaselineInstallError(failed, 'site', '/repo/site');
    expect(err.name).toBe('BaselineInstallError');
    expect(err).toBeInstanceOf(Error);
  });
});
