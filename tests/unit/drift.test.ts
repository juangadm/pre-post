import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { driftNotes, satisfies, skillVersion } from '../../src/drift';

let home: string;
let repo: string;
const put = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-home-'));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-proj-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('skillVersion', () => {
  it('reads the version field first', () => {
    expect(skillVersion('---\nname: pre-post\nversion: 1.4.0\n---\nnpx -y @juangadm/pre-post@1.4.0 pr')).toBe('1.4.0');
  });

  it('falls back to a consistent pin in the npx lines', () => {
    expect(skillVersion('npx -y @juangadm/pre-post@1.2.0 pr\nnpx -y @juangadm/pre-post@1.2.0 login')).toBe('1.2.0');
  });

  it('is null for @latest or no pin at all', () => {
    expect(skillVersion('npx -y @juangadm/pre-post@latest pr')).toBeNull();
    expect(skillVersion('pre-post posts a PR comment')).toBeNull();
  });
});

describe('satisfies', () => {
  it('handles the ranges projects write for a CLI', () => {
    expect(satisfies('1.3.0', '^0.1.1')).toBe(false);
    expect(satisfies('0.1.4', '^0.1.1')).toBe(true);
    expect(satisfies('1.3.0', '^1.2.0')).toBe(true);
    expect(satisfies('2.0.0', '^1.2.0')).toBe(false);
    expect(satisfies('1.3.2', '~1.3.0')).toBe(true);
    expect(satisfies('1.4.0', '~1.3.0')).toBe(false);
    expect(satisfies('1.3.0', '1.3.0')).toBe(true);
    expect(satisfies('1.3.0', '>=1.0.0')).toBe(true);
    expect(satisfies('1.3.0', 'latest')).toBe(true);
  });

  it('never raises an alarm over a range it cannot read', () => {
    expect(satisfies('1.3.0', '1.x || 2.x')).toBe(true);
  });
});

describe('driftNotes', () => {
  it('is quiet when every copy matches this version', () => {
    put(path.join(home, '.claude/skills/pre-post/SKILL.md'), 'version: 1.3.0\n');
    expect(driftNotes({ version: '1.3.0', home, repoRoot: repo })).toEqual([]);
  });

  // The lab machine: an old skill, a shadowing command file, and a project
  // pinning ^0.1.1 while npx ran 1.3.0.
  it('names every copy and pin that disagrees, and the command that shadows the skill', () => {
    put(path.join(home, '.claude/skills/pre-post/SKILL.md'), 'npx -y @juangadm/pre-post@latest pr');
    put(path.join(home, '.claude/commands/pre-post.md'), 'posts a PR comment');
    put(path.join(repo, 'package.json'), JSON.stringify({ devDependencies: { '@juangadm/pre-post': '^0.1.1' } }));
    const notes = driftNotes({ version: '1.3.0', home, repoRoot: repo });
    expect(notes).toHaveLength(4);
    expect(notes[0]).toContain('skills/pre-post/SKILL.md was written for an unversioned pre-post, not 1.3.0');
    expect(notes[1]).toContain('commands/pre-post.md was written for an unversioned pre-post');
    expect(notes[2]).toContain('commands/pre-post.md overrides the pre-post skill');
    expect(notes[3]).toContain('package.json pins @juangadm/pre-post ^0.1.1, but this run is 1.3.0');
  });
});
