import { describe, it, expect } from 'vitest';
import { resolveComparison, describeComparison, NoBaselineError, NoPostError, ResolveContext } from '../../src/comparison';
import { GitHub } from '../../src/github';

const PR = { number: 7, head: { sha: 'head1234567' }, base: { sha: 'base7654321' } };

/** GitHub stub: routes keyed by a fragment of the request path. */
function gh(routes: Record<string, unknown>): GitHub {
  const client = new GitHub('t');
  (client as unknown as { request: (m: string, p: string) => Promise<unknown> }).request = async (_m, p) => {
    const key = Object.keys(routes).find(k => p.includes(k));
    if (key === undefined) throw new Error(`no route for ${p}`);
    return routes[key];
  };
  return client;
}

const vercelStatus = (state: string) => ({ statuses: [{ state, context: 'Vercel' }] });
const botComment = (url: string) => [{
  body: `[vc]: #sig:${Buffer.from(JSON.stringify({ projects: [{ name: 'app', previewUrl: url, nextCommitStatus: 'DEPLOYED' }] })).toString('base64')}`,
  user: { login: 'vercel[bot]' },
}];

function ctx(over: Partial<ResolveContext> = {}): ResolveContext {
  return {
    gh: gh({}), ownerRepo: 'o/r', pr: PR, repoRoot: '/repo', config: {},
    devServer: Promise.resolve(null),
    probe: async () => ({ status: 200, vercel: false }),
    serveBaseline: async () => null,
    servePost: async () => null,
    log: () => undefined,
    ...over,
  };
}

describe('resolveComparison', () => {
  it('honours both sides when the caller names them', async () => {
    const c = await resolveComparison(ctx({ before: 'https://prod.com', after: 'http://localhost:3000' }));
    expect(c.strategy).toBe('explicit');
    expect(c.mixed).toBe(true);
  });

  it('pairs a preview deployment with a deployed baseline', async () => {
    const c = await resolveComparison(ctx({
      gh: gh({
        '/deployments?sha=head': [{ id: 1, environment: 'Preview' }],
        '/deployments/1/statuses': [{ state: 'success', environment_url: 'https://preview.app' }],
      }),
      config: { before: 'https://prod.com' },
    }));
    expect(c.strategy).toBe('deployed');
    expect(c.after.url).toBe('https://preview.app');
    expect(c.before.url).toBe('https://prod.com');
    expect(c.mixed).toBe(false);
  });

  it('never pairs a preview against a local dev server', async () => {
    const c = await resolveComparison(ctx({
      gh: gh({
        '/deployments?sha=head': [{ id: 1, environment: 'Preview' }],
        '/deployments/1/statuses': [{ state: 'success', environment_url: 'https://preview.app' }],
        '/deployments?sha=base': [],
      }),
      devServer: Promise.resolve('http://localhost:3000'),
      serveBaseline: async () => ({ url: 'http://localhost:41111', stop: async () => undefined }),
    }));
    expect(c.strategy).toBe('local');
    expect(c.after.url).toBe('http://localhost:3000');
    expect(c.before.url).toBe('http://localhost:41111');
    expect(c.mixed).toBe(false);
  });

  it('falls back to local when the preview is behind Deployment Protection', async () => {
    const c = await resolveComparison(ctx({
      gh: gh({
        '/deployments?sha=head': [{ id: 1, environment: 'Preview' }],
        '/deployments/1/statuses': [{ state: 'success', environment_url: 'https://preview.app' }],
      }),
      config: { before: 'https://prod.com' },
      probe: async url => ({ status: url.includes('preview') ? 401 : 200, vercel: true }),
      devServer: Promise.resolve('http://localhost:3000'),
      serveBaseline: async () => ({ url: 'http://localhost:41111', stop: async () => undefined }),
    }));
    expect(c.strategy).toBe('local');
  });

  it('ignores a bot comment with no successful deployment for the head commit', async () => {
    const c = await resolveComparison(ctx({
      gh: gh({
        '/deployments?sha=head': [],
        [`/commits/${PR.head.sha}/status`]: vercelStatus('pending'),
        '/issues/7/comments': botComment('stale-preview.vercel.app'),
        '/deployments?sha=base': [],
      }),
      devServer: Promise.resolve('http://localhost:3000'),
      serveBaseline: async () => ({ url: 'http://localhost:41111', stop: async () => undefined }),
    }));
    expect(c.strategy).toBe('local');
    expect(c.after.url).not.toContain('stale-preview');
  });

  it('uses the bot comment once the head commit has a green deployment', async () => {
    const c = await resolveComparison(ctx({
      gh: gh({
        '/deployments?sha=head': [],
        [`/commits/${PR.head.sha}/status`]: vercelStatus('success'),
        '/issues/7/comments': botComment('fresh-preview.vercel.app'),
        '/deployments?sha=base': [{ id: 2, environment: 'Production' }],
        '/deployments/2/statuses': [{ state: 'success', environment_url: 'https://prod.com' }],
      }),
    }));
    expect(c.strategy).toBe('deployed');
    expect(c.after.url).toBe('https://fresh-preview.vercel.app');
  });

  it('starts a dev server itself rather than asking the user to', async () => {
    const c = await resolveComparison(ctx({
      gh: gh({ '/deployments?sha=': [] }),
      servePost: async () => ({ url: 'http://localhost:42222', stop: async () => undefined }),
      serveBaseline: async () => ({ url: 'http://localhost:41111', stop: async () => undefined }),
    }));
    expect(c.strategy).toBe('local');
    expect(c.after.url).toBe('http://localhost:42222');
    expect(c.before.url).toBe('http://localhost:41111');
    expect(c.mixed).toBe(false);
  });

  it('stops with one instruction only when it cannot serve the branch at all', async () => {
    await expect(resolveComparison(ctx({ gh: gh({ '/deployments?sha=': [] }) }))).rejects.toBeInstanceOf(NoPostError);
  });

  it('shuts down a dev server it started when no baseline can be built', async () => {
    let stopped = false;
    await expect(resolveComparison(ctx({
      gh: gh({ '/deployments?sha=': [] }),
      servePost: async () => ({ url: 'http://localhost:42222', stop: async () => { stopped = true; } }),
    }))).rejects.toBeInstanceOf(NoBaselineError);
    expect(stopped).toBe(true);
  });

  it('keeps a pinned --before even against a local Post, and says it is mixed', async () => {
    const c = await resolveComparison(ctx({
      gh: gh({ '/deployments?sha=': [] }),
      before: 'https://prod.com',
      devServer: Promise.resolve('http://localhost:3000'),
    }));
    expect(c.before.url).toBe('https://prod.com');
    expect(c.mixed).toBe(true);
    expect(describeComparison(c).join('\n')).toContain('different environments');
  });
});
