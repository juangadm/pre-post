import { describe, it, expect } from 'vitest';
import { differentSitesHint, looksLikeDifferentSites, MIN_WORDS, pageWords, SAME_SITE_FLOOR, textOverlap, titleOverlap } from '../../src/sameness';

// Two pages with enough distinct words to be judgeable at all.
const SITE = `pre-post visual diff screenshots pull request route detection playwright
  capture pixelmatch baseline deployment preview viewport crop publish assets branch`;
const REDESIGNED = `pre-post visual diff screenshots pull request route detection playwright
  capture pixelmatch baseline deployment preview viewport crop publish assets branch`;
const OTHER = `ledgerly accounting reconciliation ledger bank feeds month close checklist
  audit trail immutable entries finance teams toronto trial invoices payroll`;

describe('pageWords', () => {
  it('drops the words every English page shares', () => {
    const words = pageWords('The pricing page has more than one plan for you and your team');
    expect(words.has('pricing')).toBe(true);
    expect(words.has('plan')).toBe(true);
    for (const stop of ['the', 'has', 'more', 'than', 'for', 'you', 'your', 'and']) {
      expect(words.has(stop)).toBe(false);
    }
  });

  it('ignores punctuation and case', () => {
    expect(pageWords('Pricing, PRICING; pricing.')).toEqual(new Set(['pricing']));
  });
});

describe('textOverlap', () => {
  it('is 1 for a page against itself', () => {
    expect(textOverlap(SITE, SITE)).toBe(1);
  });

  // The case a pixel ratio gets backwards: a redesign reads ~100% changed while
  // saying exactly the same things.
  it('stays high when a page is restyled but not rewritten', () => {
    expect(textOverlap(SITE, REDESIGNED)).toBe(1);
  });

  it('is near zero for two unrelated sites', () => {
    expect(textOverlap(SITE, OTHER)).toBeLessThan(SAME_SITE_FLOOR);
  });

  it('refuses to judge a page with almost no text', () => {
    expect(textOverlap(SITE, 'Home')).toBe(null);
    expect(textOverlap('Home', SITE)).toBe(null);
    expect(textOverlap('', '')).toBe(null);
  });

  it('does not penalise a branch for adding words', () => {
    const longer = `${SITE} plus a new section about pricing plans and enterprise support tiers`;
    expect(textOverlap(SITE, longer)).toBe(1);
  });

  it('needs MIN_WORDS distinct words on both sides', () => {
    const words = Array.from({ length: MIN_WORDS }, (_, i) => `distinctword${i}`).join(' ');
    expect(textOverlap(words, words)).toBe(1);
    const oneShort = Array.from({ length: MIN_WORDS - 1 }, (_, i) => `distinctword${i}`).join(' ');
    expect(textOverlap(oneShort, oneShort)).toBe(null);
  });
});

describe('titleOverlap', () => {
  it('judges short titles that body text would be too thin to judge', () => {
    expect(titleOverlap('pre-post — visual diff for PRs', 'pre-post — visual diff for PRs')).toBe(1);
    expect(titleOverlap('pre-post — visual diff for PRs', 'Ledgerly — accounting for teams')).toBe(0);
  });

  it('declines a title with nothing distinctive in it', () => {
    expect(titleOverlap('', 'pre-post')).toBe(null);
    expect(titleOverlap('the and for', 'pre-post')).toBe(null);
  });
});

describe('looksLikeDifferentSites', () => {
  const page = (route: string, text: number | null, title: number | null = 0) =>
    ({ route, textOverlap: text, titleOverlap: title });

  it('needs every judgeable page to disagree', () => {
    expect(looksLikeDifferentSites([page('/', 0), page('/about', 0.02)])).toBe(true);
    // One rewritten page among several is a branch doing its job, not a wrong site.
    expect(looksLikeDifferentSites([page('/', 0), page('/about', 0.9)])).toBe(false);
  });

  it('says nothing when no page could be judged', () => {
    expect(looksLikeDifferentSites([page('/', null), {}])).toBe(false);
    expect(looksLikeDifferentSites([])).toBe(false);
  });

  it('ignores pages it could not judge but still trusts the ones it could', () => {
    expect(looksLikeDifferentSites([page('/', null), page('/about', 0.01)])).toBe(true);
  });

  // One route captured at several viewports is one page's evidence repeated,
  // not several pages agreeing. Without folding, a single-route run could
  // reject the very thing this function is documented to permit.
  it('does not count viewports of one route as corroborating pages', () => {
    const rewritten = [
      { route: '/', viewport: 'desktop', textOverlap: 0, titleOverlap: 0.8 },
      { route: '/', viewport: 'mobile', textOverlap: 0, titleOverlap: 0.8 },
    ];
    expect(looksLikeDifferentSites(rewritten)).toBe(false);
  });

  it('takes a route\'s strongest viewport, so one narrow layout cannot condemn it', () => {
    expect(looksLikeDifferentSites([
      { route: '/', textOverlap: 0 },
      { route: '/', textOverlap: 0.9 },
    ])).toBe(false);
  });

  describe('with only one route to go on', () => {
    it('fires when the title agrees that it is a different site', () => {
      expect(looksLikeDifferentSites([page('/', 0, 0)])).toBe(true);
    });

    it('holds back when the title still names the same site', () => {
      expect(looksLikeDifferentSites([page('/', 0, 0.5)])).toBe(false);
      expect(looksLikeDifferentSites([page('/', 0, 1)])).toBe(false);
    });

    it('holds back when there is no usable title to corroborate with', () => {
      expect(looksLikeDifferentSites([page('/', 0, null)])).toBe(false);
    });
  });
});

describe('differentSitesHint', () => {
  it('names both sides and the fix', () => {
    const hint = differentSitesHint('https://other.example', 'production deployment', 'http://localhost:3000');
    expect(hint).toContain('https://other.example');
    expect(hint).toContain('production deployment');
    expect(hint).toContain('http://localhost:3000');
    expect(hint).toContain('--before');
  });

  // AGENTS.md: a NeedsHumanError carries a single actionable sentence.
  it('is one sentence', () => {
    const hint = differentSitesHint('https://other.example', 'production deployment', 'http://localhost:3000');
    expect(hint.match(/\.(\s|$)/g) ?? []).toHaveLength(1);
    expect(hint.trimEnd().endsWith('.')).toBe(true);
  });
});
