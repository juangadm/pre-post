import { describe, it, expect, afterEach } from 'vitest';
import { checkLanding, leftTheSite, looksLikeSignIn, siteOf, signInHint } from '../../src/landing';
import { resolveAuth } from '../../src/sessions';

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

  it('flags the real Vercel deployment-protection wall', () => {
    // Observed on a live protected preview, 2026-09-05: HTTP 200 after a
    // redirect off-site, which is why the 401/403 guard never saw it.
    const l = checkLanding(
      'https://prepost-lqlivj5ce-juangabrieldelgado-6681s-projects.vercel.app/',
      'https://vercel.com/login?next=%2Fsso-api%3Furl%3Dhttps%253A%252F%252Fprepost-lqlivj5ce-juangabrieldelgado-6681s-projects.vercel.app%252F%26nonce%3Da8d4dab1',
      'Login – Vercel',
    );
    expect(l.blocked).toBe(true);
    expect(l.offSite).toBe(true);
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

describe('the Vercel bypass headers', () => {
  const saved = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  afterEach(() => {
    if (saved === undefined) delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    else process.env.VERCEL_AUTOMATION_BYPASS_SECRET = saved;
  });

  it('sends the bypass header and nothing else', () => {
    // `x-vercel-set-bypass-cookie` asks the host to set a cookie through a
    // redirect, which the cookie-less reachability probe can never satisfy: it
    // looped until it threw, and every protected preview read as unreachable.
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = 'secret-value';
    const auth = resolveAuth({ urls: [] });
    expect(auth?.headers).toEqual({ 'x-vercel-protection-bypass': 'secret-value' });
  });

  it('leaves an explicit header alone', () => {
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = 'from-env';
    const auth = resolveAuth({ headers: { 'x-vercel-protection-bypass': 'explicit' }, urls: [] });
    expect(auth?.headers['x-vercel-protection-bypass']).toBe('explicit');
  });
});
