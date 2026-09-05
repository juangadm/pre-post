import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { homepageFromPackage, homepageFromRepo, isPublishedSite, publishedSiteUrl } from '../../src/homepage';
import { GitHub } from '../../src/github';

function gh(response: unknown): GitHub {
  const client = new GitHub('t');
  (client as unknown as { request: () => Promise<unknown> }).request = async () => {
    if (response instanceof Error) throw response;
    return response;
  };
  return client;
}

function repoWith(pkg: Record<string, unknown>, appPrefix?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-homepage-'));
  const dir = appPrefix ? path.join(root, appPrefix) : root;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  return root;
}

describe('isPublishedSite', () => {
  it('accepts a deployed site', () => {
    expect(isPublishedSite('https://example.com')).toBe(true);
    expect(isPublishedSite('example.com')).toBe(true);
  });

  it('rejects a URL that points back at the source host', () => {
    expect(isPublishedSite('https://github.com/juangadm/pre-post')).toBe(false);
    expect(isPublishedSite('https://gitlab.com/o/r')).toBe(false);
  });

  it('rejects anything that is not a reachable public address', () => {
    expect(isPublishedSite('http://localhost:3000')).toBe(false);
    expect(isPublishedSite('intranet')).toBe(false);
    expect(isPublishedSite('')).toBe(false);
    expect(isPublishedSite(null)).toBe(false);
    expect(isPublishedSite(undefined)).toBe(false);
  });
});

describe('homepageFromPackage', () => {
  it('reads homepage from the app package before the repository root', () => {
    const root = repoWith({ homepage: 'https://root.example.com' });
    fs.mkdirSync(path.join(root, 'site'));
    fs.writeFileSync(path.join(root, 'site/package.json'), JSON.stringify({ homepage: 'https://app.example.com' }));
    expect(homepageFromPackage(root, 'site')?.url).toBe('https://app.example.com');
  });

  it('falls back to the repository root package', () => {
    const root = repoWith({ homepage: 'https://root.example.com' });
    fs.mkdirSync(path.join(root, 'site'));
    fs.writeFileSync(path.join(root, 'site/package.json'), JSON.stringify({ name: 'site' }));
    expect(homepageFromPackage(root, 'site')?.url).toBe('https://root.example.com');
  });

  it('ignores a homepage that is just the repository', () => {
    const root = repoWith({ homepage: 'https://github.com/o/r' });
    expect(homepageFromPackage(root)).toBeNull();
  });
});

describe('homepageFromRepo', () => {
  it('uses the website set on the repository', async () => {
    expect((await homepageFromRepo(gh({ homepage: 'https://prepost.example.org' }), 'o/r'))?.url)
      .toBe('https://prepost.example.org');
  });

  it('treats an unset website and an API failure alike', async () => {
    expect(await homepageFromRepo(gh({ homepage: null }), 'o/r')).toBeNull();
    expect(await homepageFromRepo(gh(new Error('403')), 'o/r')).toBeNull();
  });
});

describe('publishedSiteUrl', () => {
  it('prefers the repository website over package.json', async () => {
    const root = repoWith({ homepage: 'https://stale.example.com' });
    const found = await publishedSiteUrl(gh({ homepage: 'https://live.example.com' }), 'o/r', root);
    expect(found?.url).toBe('https://live.example.com');
  });

  it('falls back to package.json when the repository has no website', async () => {
    const root = repoWith({ homepage: 'https://fallback.example.com' });
    const found = await publishedSiteUrl(gh({ homepage: null }), 'o/r', root);
    expect(found?.url).toBe('https://fallback.example.com');
    expect(found?.detail).toMatch(/package\.json/);
  });

  it('works without a GitHub client', async () => {
    const root = repoWith({ homepage: 'https://offline.example.com' });
    expect((await publishedSiteUrl(null, 'o/r', root))?.url).toBe('https://offline.example.com');
  });
});
