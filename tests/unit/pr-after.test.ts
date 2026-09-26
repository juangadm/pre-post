import { describe, it, expect } from 'vitest';
import { afterFor } from '../../src/commands/pr';

describe('afterFor', () => {
  it('uses the configured Post URL normally', () => {
    expect(afterFor({}, { after: 'http://localhost:3000' })).toBe('http://localhost:3000');
  });

  // --local promises Post is built from this checkout, and a configured
  // `after` is usually the author's localhost, which a CI runner cannot reach.
  it('ignores the configured Post URL in local mode', () => {
    expect(afterFor({ local: true }, { after: 'http://localhost:3000' })).toBeUndefined();
  });

  it('still honours --after given on the command in local mode', () => {
    expect(afterFor({ local: true, after: 'http://localhost:4000' }, { after: 'http://localhost:3000' })).toBe('http://localhost:4000');
  });
});
