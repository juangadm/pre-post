import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { doctorExitCode, DoctorCheck, repoIdentityCheck } from '../../src/commands/doctor';

const ok = (name: string, required = false): DoctorCheck => ({ name, ok: true, detail: '', required });
const bad = (name: string, required = false): DoctorCheck => ({ name, ok: false, detail: '', required });

describe('doctorExitCode', () => {
  it('is 0 when every required check passed', () => {
    expect(doctorExitCode([ok('browser', true), ok('github', true), ok('git', true)])).toBe(0);
  });

  it('is 1 when a required check failed', () => {
    expect(doctorExitCode([ok('browser', true), bad('github', true)])).toBe(1);
  });

  /**
   * The reason the contract needs the distinction at all: doctor used to print
   * FAIL and exit 0, so nothing could tell pass from fail by exit code. Failing
   * on advisory checks instead would be just as useless in the other
   * direction — a healthy machine with no dev server running trips one, and
   * every automated preflight would then refuse to proceed.
   */
  it('ignores advisory failures, which a healthy machine has', () => {
    expect(doctorExitCode([ok('browser', true), ok('github', true), ok('git', true), bad('devserver'), bad('before')])).toBe(0);
  });

  it('treats an unmarked check as advisory', () => {
    expect(doctorExitCode([{ name: 'anything', ok: false, detail: '' }])).toBe(0);
  });

  it('is 0 for no checks at all', () => {
    expect(doctorExitCode([])).toBe(0);
  });
});

/**
 * Being in a git repository is not the same as being able to name it, and `pr`
 * needs both — it calls resolveOwnerRepo before anything else. doctor used to
 * check only the former and could report "ready" for a checkout that `pr`
 * throws on immediately.
 */
describe('repoIdentityCheck', () => {
  const made: string[] = [];
  const repo = (origin?: string): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-identity-')));
    made.push(dir);
    execSync('git init -q -b main', { cwd: dir });
    if (origin) execSync(`git remote add origin ${origin}`, { cwd: dir });
    return dir;
  };
  afterAll(() => made.forEach(d => fs.rmSync(d, { recursive: true, force: true })));

  it('names the repository when origin is a GitHub remote', () => {
    const check = repoIdentityCheck(repo('https://github.com/juangadm/pre-post.git'));
    expect(check.ok).toBe(true);
    expect(check.detail).toBe('juangadm/pre-post');
  });

  it('fails, and is required, when there is no origin to parse', () => {
    const check = repoIdentityCheck(repo());
    expect(check.ok).toBe(false);
    expect(check.required).toBe(true);
    expect(check.detail).toContain('GH_REPO');
    // The point: this must be able to turn a "ready" into a "not ready".
    expect(doctorExitCode([check])).toBe(1);
  });
});
