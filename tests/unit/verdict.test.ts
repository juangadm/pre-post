import { describe, it, expect } from 'vitest';
import { verdictFor } from '../../src/run';
import { RouteCaptureOutcome } from '../../src/types';

const sides = {
  before: { url: 'https://prod.example', detail: 'production deployment for 26aa6cd' },
  after: { url: 'https://preview.example' },
};

const outcome = (o: Partial<RouteCaptureOutcome>): RouteCaptureOutcome =>
  ({ route: '/', resolvedRoute: '/', viewport: 'desktop', status: 'changed', ...o });

const walled = (side: 'before' | 'after') =>
  outcome({ status: 'error', blocked: { side, finalUrl: 'https://vercel.com/login', vercel: true } });

const compared = (textOverlap: number, titleOverlap = 1, route = '/') =>
  outcome({ route, textOverlap, titleOverlap });

describe('verdictFor', () => {
  it('is silent about a run that really compared the two sites', () => {
    expect(verdictFor([compared(0.9), compared(0.95, 1, '/about')], sides)).toBe(null);
  });

  it('reports a wall only when every route hit one', () => {
    expect(verdictFor([walled('after'), walled('after')], sides)?.kind).toBe('walled');
    // One route walled and another compared is a per-route error, not a verdict
    // about the run — the comparison still has something to say.
    expect(verdictFor([walled('after'), compared(0.9)], sides)).toBe(null);
  });

  it('names the side that was walled, so the advice points somewhere real', () => {
    expect(verdictFor([walled('before')], sides)?.hint).toContain(sides.before.url);
    expect(verdictFor([walled('after')], sides)?.hint).toContain(sides.after.url);
  });

  it('reports two different sites, naming how Pre was chosen', () => {
    const verdict = verdictFor([compared(0, 0), compared(0, 0, '/about')], sides);
    expect(verdict?.kind).toBe('different-sites');
    expect(verdict?.hint).toContain('production deployment for 26aa6cd');
  });

  /**
   * A sign-in page shares no words with the site, so a walled run also looks
   * like two different sites. The wall is the more specific diagnosis and its
   * fix is credentials rather than a URL, so it has to win.
   */
  it('calls a wall a wall, not a different site', () => {
    expect(verdictFor([walled('after'), walled('after')], sides)?.kind).toBe('walled');
  });

  it('says nothing when there was nothing to judge', () => {
    expect(verdictFor([], sides)).toBe(null);
    expect(verdictFor([outcome({ status: 'error', error: 'timed out' })], sides)).toBe(null);
  });
});
