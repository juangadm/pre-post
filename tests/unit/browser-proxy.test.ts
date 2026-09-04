import { describe, it, expect } from 'vitest';
import { proxyFromEnv } from '../../src/browser';

describe('proxyFromEnv', () => {
  it('is undefined when the environment sets no proxy', () => {
    expect(proxyFromEnv({})).toBeUndefined();
  });

  it('prefers HTTPS_PROXY, and accepts the lowercase spellings', () => {
    expect(proxyFromEnv({ HTTPS_PROXY: 'http://p:8080', HTTP_PROXY: 'http://other' })?.server).toBe('http://p:8080');
    expect(proxyFromEnv({ https_proxy: 'http://p:8080' })?.server).toBe('http://p:8080');
    expect(proxyFromEnv({ http_proxy: 'http://p:8080' })?.server).toBe('http://p:8080');
  });

  it('passes NO_PROXY through as a bypass list, without duplicating loopback', () => {
    expect(proxyFromEnv({ HTTPS_PROXY: 'http://p:8080', NO_PROXY: 'localhost, 127.0.0.1 ,internal' }))
      .toEqual({ server: 'http://p:8080', bypass: 'localhost,127.0.0.1,internal,::1' });
  });

  it('always bypasses loopback, whatever NO_PROXY says', () => {
    // A dev server on this machine is never something the proxy can route to,
    // and a proxy that refuses localhost would otherwise serve its error page
    // as both sides of the comparison.
    expect(proxyFromEnv({ HTTPS_PROXY: 'http://p:8080' })?.bypass).toBe('localhost,127.0.0.1,::1');
    expect(proxyFromEnv({ HTTPS_PROXY: 'http://p:8080', NO_PROXY: ' , ' })?.bypass).toBe('localhost,127.0.0.1,::1');
  });
});
