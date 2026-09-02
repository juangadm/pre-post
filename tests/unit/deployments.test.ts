import { describe, it, expect } from 'vitest';
import { deploymentUrlForSha, previewUrlFromComments } from '../../src/deployments';
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

describe('previewUrlFromComments', () => {
  // The exact comment vercel[bot] posted on juangadm/pre-post#16.
  const VERCEL_BODY = "[vc]: #6eUMzLg0RZ5WiZtXBX6sLZ/l68B2IzvlTuw/Js2hqiI=:eyJpc01vbm9yZXBvIjp0cnVlLCJ0eXBlIjoiZ2l0aHViIiwicHJvamVjdHMiOlt7Im5hbWUiOiJwcmVwb3N0IiwicHJvamVjdElkIjoicHJqX3dyYkk1SUlvWVJwSGk4SnF3cUpmSnBNZk1HTUYiLCJyb290RGlyZWN0b3J5Ijoic2l0ZSIsImluc3BlY3RvclVybCI6Imh0dHBzOi8vdmVyY2VsLmNvbS9qdWFuZ2FicmllbGRlbGdhZG8tNjY4MXMtcHJvamVjdHMvcHJlcG9zdC84bkJTd1FrYVRiUDVmVVduWWlVTWtiVG5vcUpVIiwicHJldmlld1VybCI6InByZXBvc3QtZ2l0LWNsYXVkZS1wcmUtOWU3ZDY5LWp1YW5nYWJyaWVsZGVsZ2Fkby02Njgxcy1wcm9qZWN0cy52ZXJjZWwuYXBwIiwibmV4dENvbW1pdFN0YXR1cyI6IkRFUExPWUVEIiwibGl2ZUZlZWRiYWNrIjp7InJlc29sdmVkIjowLCJ1bnJlc29sdmVkIjowLCJ0b3RhbCI6MCwibGluayI6InByZXBvc3QtZ2l0LWNsYXVkZS1wcmUtOWU3ZDY5LWp1YW5nYWJyaWVsZGVsZ2Fkby02Njgxcy1wcm9qZWN0cy52ZXJjZWwuYXBwIn19XX0=\nThe latest updates on your projects.";
  const ghWith = (comments: unknown) => fakeGh({ '/issues/': comments });

  it('reads the preview URL out of the real Vercel comment', async () => {
    const found = await previewUrlFromComments(ghWith([{ body: VERCEL_BODY, user: { login: 'vercel[bot]' } }]), 'o/r', 16, { appPrefix: 'site' });
    expect(found?.url).toBe('https://prepost-git-claude-pre-9e7d69-juangabrieldelgado-6681s-projects.vercel.app');
  });

  it('ignores an identical comment from a non-bot author', async () => {
    const spoofed = [{ body: VERCEL_BODY, user: { login: 'passer-by' } }];
    expect(await previewUrlFromComments(ghWith(spoofed), 'o/r', 16, { appPrefix: 'site' })).toBeNull();
  });

  it('refuses a project whose root directory is a different app', async () => {
    const comments = [{ body: VERCEL_BODY, user: { login: 'vercel[bot]' } }];
    expect(await previewUrlFromComments(ghWith(comments), 'o/r', 16, { appPrefix: 'docs' })).toBeNull();
  });

  it('falls back to a named Deploy Preview link', async () => {
    const comments = [{ body: 'Deploy log · [Deploy Preview](https://deploy-preview-3--site.netlify.app) ready', user: { login: 'netlify[bot]' } }];
    const found = await previewUrlFromComments(ghWith(comments), 'o/r', 3);
    expect(found?.url).toBe('https://deploy-preview-3--site.netlify.app');
  });

  it('returns null when no bot has commented', async () => {
    expect(await previewUrlFromComments(ghWith([]), 'o/r', 16)).toBeNull();
  });
});
