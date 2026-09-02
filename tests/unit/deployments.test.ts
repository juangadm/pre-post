import { describe, it, expect } from 'vitest';
import { deploymentUrlForSha } from '../../src/deployments';
import { GitHub } from '../../src/github';

/** A GitHub client whose responses are canned per path fragment. */
function fakeGh(routes: Record<string, unknown>, calls: string[] = []): GitHub {
  const gh = new GitHub('t');
  (gh as unknown as { request: (m: string, p: string) => Promise<unknown> }).request = async (_m, p) => {
    calls.push(p);
    const key = Object.keys(routes).find(k => p.includes(k));
    if (!key) throw new Error(`unexpected request: ${p}`);
    const value = routes[key];
    if (value instanceof Error) throw value;
    return value;
  };
  return gh;
}

const ok = (url: string) => [{ state: 'success', environment_url: url, created_at: '2026-01-01' }];

describe('deploymentUrlForSha', () => {
  it('finds the preview deployment for a commit', async () => {
    const gh = fakeGh({
      '/deployments?sha=': [{ id: 1, environment: 'Preview', created_at: '2026-01-01' }],
      '/deployments/1/statuses': ok('https://my-app-git-feature.vercel.app'),
    });
    const found = await deploymentUrlForSha(gh, 'o/r', 'abc', { production: false });
    expect(found).toEqual({ url: 'https://my-app-git-feature.vercel.app', environment: 'Preview' });
  });

  it('never returns a preview when production was asked for', async () => {
    const gh = fakeGh({
      '/deployments?sha=': [{ id: 1, environment: 'Preview', created_at: '2026-01-01' }],
      '/deployments/1/statuses': ok('https://preview.example.com'),
    });
    expect(await deploymentUrlForSha(gh, 'o/r', 'abc', { production: true })).toBeNull();
  });

  it('picks production out of a mixed list and ignores the preview', async () => {
    const gh = fakeGh({
      '/deployments?sha=': [
        { id: 1, environment: 'Preview', created_at: '2026-01-02' },
        { id: 2, environment: 'Production', created_at: '2026-01-01' },
      ],
      '/deployments/2/statuses': ok('https://example.com'),
    });
    const found = await deploymentUrlForSha(gh, 'o/r', 'abc', { production: true });
    expect(found?.url).toBe('https://example.com');
  });

  it('skips a deployment that never succeeded and tries the next', async () => {
    const gh = fakeGh({
      '/deployments?sha=': [
        { id: 1, environment: 'Preview', created_at: '2026-01-02' },
        { id: 2, environment: 'Preview', created_at: '2026-01-01' },
      ],
      '/deployments/1/statuses': [{ state: 'failure', environment_url: null, created_at: '2026-01-02' }],
      '/deployments/2/statuses': ok('https://second.example.com'),
    });
    const found = await deploymentUrlForSha(gh, 'o/r', 'abc', { production: false });
    expect(found?.url).toBe('https://second.example.com');
  });

  it('returns null rather than throwing when the token cannot read deployments', async () => {
    const gh = fakeGh({ '/deployments?sha=': new Error('403') });
    expect(await deploymentUrlForSha(gh, 'o/r', 'abc', { production: false })).toBeNull();
  });

  it('returns null for a repo with no deployments', async () => {
    const gh = fakeGh({ '/deployments?sha=': [] });
    expect(await deploymentUrlForSha(gh, 'o/r', 'abc', { production: false })).toBeNull();
  });

  it('caps how many deployments it inspects', async () => {
    const calls: string[] = [];
    const many = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, environment: 'Preview', created_at: '2026-01-01' }));
    const gh = fakeGh(
      { '/deployments?sha=': many, '/statuses': [{ state: 'failure', environment_url: null, created_at: '2026-01-01' }] },
      calls,
    );
    expect(await deploymentUrlForSha(gh, 'o/r', 'abc', { production: false })).toBeNull();
    expect(calls.filter(c => c.includes('/statuses'))).toHaveLength(5);
  });
});
