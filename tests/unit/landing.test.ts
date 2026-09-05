import { describe, it, expect } from 'vitest';
import { checkLanding, leftTheSite, looksLikeSignIn, siteOf, signInHint } from '../../src/landing';

describe('siteOf', () => {
  it('reduces a host to its registrable part', () => {
    expect(siteOf('https://www.example.com/x')).toBe('example.com');
    expect(siteOf('https://example.com')).toBe('example.com');
    expect(siteOf('https://prepost-abc123.vercel.app/')).toBe('vercel.app');
    expect(siteOf('http://localhost:3000/')).toBe('localhost');
  });

  it('returns empty for anything unparseable', () => {
    expect(siteOf('not a url')).toBe('');
  });
});

describe('leftTheSite', () => {
  it('treats apex and www as the same site', () => {
    expect(leftTheSite('https://example.com/', 'https://www.example.com/')).toBe(false);
  });

  it('notices a move to a different site', () => {
    expect(leftTheSite('https://app.vercel.app/', 'https://vercel.com/sso-api?url=x')).toBe(true);
  });
});

describe('looksLikeSignIn', () => {
  it('recognises sign-in URLs', () => {
    expect(looksLikeSignIn('https://vercel.com/sso-api?url=https%3A%2F%2Fx')).toBe(true);
    expect(looksLikeSignIn('https://example.com/login')).toBe(true);
    expect(looksLikeSignIn('https://example.com/auth/signin')).toBe(true);
    expect(looksLikeSignIn('https://accounts.google.com/o/oauth2/v2/auth')).toBe(true);
  });

  it('recognises sign-in titles when the URL says nothing', () => {
    expect(looksLikeSignIn('https://example.com/gate', 'Sign in to continue')).toBe(true);
    expect(looksLikeSignIn('https://example.com/gate', 'Authentication Required')).toBe(true);
  });

  it('leaves ordinary pages alone', () => {
    expect(looksLikeSignIn('https://example.com/pricing', 'Pricing')).toBe(false);
    expect(looksLikeSignIn('https://example.com/', 'Home')).toBe(false);
  });
});

describe('checkLanding', () => {
  it('passes a page that never moved', () => {
    const l = checkLanding('https://example.com/', 'https://example.com/', 'Home');
    expect(l.blocked).toBe(false);
  });

  it('passes a canonical-domain redirect', () => {
    // The project's own .xyz → .org redirect must not read as a wall.
    const l = checkLanding('https://prepost.juangabriel.xyz/', 'https://prepost.juangabriel.org/', 'pre-post');
    expect(l.blocked).toBe(false);
    expect(l.offSite).toBe(true);
  });

  it('passes a trailing-slash redirect', () => {
    const l = checkLanding('https://example.com/docs', 'https://example.com/docs/', 'Docs');
    expect(l.blocked).toBe(false);
  });

  it('flags a redirect to deployment protection', () => {
    const l = checkLanding(
      'https://app-abc.vercel.app/',
      'https://vercel.com/sso-api?url=https%3A%2F%2Fapp-abc.vercel.app%2F',
      'Login',
    );
    expect(l.blocked).toBe(true);
    expect(l.offSite).toBe(true);
  });

  it('flags a redirect to a sign-in page on the same site', () => {
    const l = checkLanding('https://example.com/dashboard', 'https://example.com/login', 'Sign in');
    expect(l.blocked).toBe(true);
    expect(l.offSite).toBe(false);
  });

  it('does not flag asking for the login page itself', () => {
    const l = checkLanding('https://example.com/login', 'https://example.com/login', 'Sign in');
    expect(l.blocked).toBe(false);
  });
});

describe('signInHint', () => {
  it('names the bypass secret for deployment protection', () => {
    expect(signInHint('https://x.vercel.app/', true)).toContain('VERCEL_AUTOMATION_BYPASS_SECRET');
  });

  it('names the login command otherwise', () => {
    expect(signInHint('http://localhost:3000', false)).toContain('pre-post login');
  });
});
