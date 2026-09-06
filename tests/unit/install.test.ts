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

  it('carries the manager’s own output instead of telling the reader to go find it', () => {
    const err = new BaselineInstallError(failed, 'site', '/repo/site', true);
    expect(err.message).toContain('npm error code ERESOLVE');
  });

  // The old message named the caller's checkout for an install that had run in
  // a worktree already deleted by the time anyone read it.
  it('says the install ran somewhere the reader cannot go back to', () => {
    const err = new BaselineInstallError(failed, 'site', '/repo/site', true);
    expect(err.message).toContain('throwaway worktree');
    expect(err.message).toContain('not in /repo/site');
  });

  it('names the real directory when the install was not in a worktree', () => {
    const err = new BaselineInstallError(failed, 'site', '/repo/site', false);
    expect(err.message).toContain('It ran in /repo/site.');
    expect(err.message).not.toContain('throwaway');
  });

  it('names the retry using the argv that actually ran', () => {
    const both = {
      ok: false,
      attempts: [
        { argv: ['install'], ok: false, output: ERESOLVE },
        { argv: ['install', '--legacy-peer-deps'], ok: false, output: ERESOLVE },
      ],
    };
    expect(new BaselineInstallError(both, 'site', '/repo/site', true).message)
      .toContain('The retry with --legacy-peer-deps did not clear it either.');
  });

  it('says nothing about a retry that never happened', () => {
    expect(new BaselineInstallError(failed, 'site', '/repo/site', true).message).not.toContain('retry');
  });

  it('is a NeedsHumanError, so the run cannot exit clean having compared nothing', () => {
    expect(new BaselineInstallError(failed, 'site', '/repo/site', true).name).toBe('BaselineInstallError');
    expect(new BaselineInstallError(failed, 'site', '/repo/site', true)).toBeInstanceOf(Error);
  });
});
