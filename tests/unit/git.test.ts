import { describe, it, expect } from 'vitest';
import { parseOwnerRepo } from '../../src/git';

describe('parseOwnerRepo', () => {
  it.each([
    ['https://github.com/acme/web.git', 'acme/web'],
    ['https://github.com/acme/web', 'acme/web'],
    ['git@github.com:acme/web.git', 'acme/web'],
    ['ssh://git@github.com/acme/web.git', 'acme/web'],
    ['http://proxy@localhost:9999/git/acme/web', 'acme/web'],
    ['https://ghe.example.com/org/repo.git', 'org/repo'],
  ])('%s → %s', (url, expected) => {
    expect(parseOwnerRepo(url)).toBe(expected);
  });

  it('returns null for garbage', () => {
    expect(parseOwnerRepo('nonsense')).toBeNull();
  });
});
