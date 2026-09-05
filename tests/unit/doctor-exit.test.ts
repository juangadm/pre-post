import { describe, it, expect } from 'vitest';
import { doctorExitCode, DoctorCheck } from '../../src/commands/doctor';

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
