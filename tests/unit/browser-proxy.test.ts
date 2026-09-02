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

  it('passes NO_PROXY through as a bypass list so dev servers connect directly', () => {
    expect(proxyFromEnv({ HTTPS_PROXY: 'http://p:8080', NO_PROXY: 'localhost, 127.0.0.1 ,internal' }))
      .toEqual({ server: 'http://p:8080', bypass: 'localhost,127.0.0.1,internal' });
  });

  it('omits an empty bypass rather than sending a blank list', () => {
    expect(proxyFromEnv({ HTTPS_PROXY: 'http://p:8080', NO_PROXY: ' , ' })).toEqual({ server: 'http://p:8080' });
  });
});
