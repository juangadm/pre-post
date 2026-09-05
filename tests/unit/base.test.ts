/**
 * Base resolution: what a run diffs against.
 *
 * These build real repositories, because the bug they guard against only
 * appears in clone shapes — a shallow, single-branch checkout has no
 * origin/<base> ref, and every mistake here is silent: the run reports an
 * empty diff rather than an error.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EMPTY_TREE, changedFiles, requireBase, resolveBase } from '../../src/git';
import { NeedsHumanError } from '../../src/errors';

const IDENT = ['-c', 'user.email=t@example.com', '-c', 'user.name=t'];

function run(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(cwd: string, file: string, body: string, message: string): void {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), body);
  run(['add', '-A'], cwd);
  run([...IDENT, 'commit', '-m', message], cwd);
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-base-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** An origin with `main`, plus a `feature` branch one commit ahead of it. */
function originWithFeature(): string {
  const origin = path.join(tmp, 'origin');
  fs.mkdirSync(origin);
  run(['init', '-b', 'main'], origin);
  commit(origin, 'app/page.tsx', 'export default () => null;\n', 'initial');
  run(['checkout', '-b', 'feature'], origin);
  commit(origin, 'app/page.tsx', 'export default () => <p>hi</p>;\n', 'change the homepage');
  run(['checkout', 'main'], origin);
  return origin;
}

describe('resolveBase', () => {
  it('uses the local merge base when the clone has one', () => {
    const origin = originWithFeature();
    const clone = path.join(tmp, 'full');
    run(['clone', `file://${origin}`, clone, '--branch', 'feature'], tmp);

    const base = resolveBase(clone);
    expect(base?.source).toBe('merge-base');
    expect(changedFiles(clone, base!.sha)).toContain('app/page.tsx');
  });

  it('fetches the base branch in a shallow single-branch clone', () => {
    const origin = originWithFeature();
    const clone = path.join(tmp, 'shallow');
    run(['clone', '--depth', '1', '--single-branch', '--branch', 'feature', `file://${origin}`, clone], tmp);

    // The shape that used to report nothing: no origin/main to fork from.
    expect(run(['rev-parse', '--is-shallow-repository'], clone)).toBe('true');
    expect(() => run(['merge-base', 'origin/main', 'HEAD'], clone)).toThrow();

    const base = resolveBase(clone);
    expect(base?.source).toBe('fetched');
    // The change is committed, so only a correct base surfaces it at all.
    expect(changedFiles(clone, base!.sha)).toContain('app/page.tsx');
  });

  it('returns null rather than guessing when there is no shared history', () => {
    const origin = originWithFeature();
    const clone = path.join(tmp, 'blind');
    run(['clone', '--depth', '1', '--single-branch', '--branch', 'feature', `file://${origin}`, clone], tmp);
    run(['remote', 'remove', 'origin'], clone);

    expect(resolveBase(clone)).toBeNull();
    expect(() => requireBase(clone)).toThrow(NeedsHumanError);
    expect(() => requireBase(clone)).toThrow(/shallow checkout/);
  });

  it('treats a repository with no commits as all-new', () => {
    const repo = path.join(tmp, 'fresh');
    fs.mkdirSync(repo);
    run(['init', '-b', 'main'], repo);
    fs.writeFileSync(path.join(repo, 'app.tsx'), 'export default () => null;\n');

    expect(resolveBase(repo)).toEqual({ sha: EMPTY_TREE, source: 'head' });
  });

  it('diffs uncommitted work when standing on the base branch', () => {
    const origin = originWithFeature();
    const clone = path.join(tmp, 'on-main');
    run(['clone', `file://${origin}`, clone], tmp);
    fs.writeFileSync(path.join(clone, 'app/page.tsx'), 'export default () => <p>edited</p>;\n');

    const base = resolveBase(clone);
    expect(base).not.toBeNull();
    expect(changedFiles(clone, base!.sha)).toContain('app/page.tsx');
  });

  it('honours an explicit ref, and rejects one that does not exist', () => {
    const origin = originWithFeature();
    const clone = path.join(tmp, 'explicit');
    run(['clone', `file://${origin}`, clone, '--branch', 'feature'], tmp);

    expect(resolveBase(clone, { explicit: 'HEAD~1' })?.source).toBe('explicit');
    expect(() => resolveBase(clone, { explicit: 'no-such-ref' })).toThrow(NeedsHumanError);
  });

  it('does not reach the network when the base is already local', () => {
    const origin = originWithFeature();
    const clone = path.join(tmp, 'offline');
    run(['clone', `file://${origin}`, clone, '--branch', 'feature'], tmp);
    // A broken remote proves no fetch was attempted: it would fail loudly.
    run(['remote', 'set-url', 'origin', 'file:///nonexistent-remote'], clone);

    expect(resolveBase(clone)?.source).toBe('merge-base');
  });
});
