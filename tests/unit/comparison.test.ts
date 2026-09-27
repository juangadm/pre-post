import { describe, it, expect } from 'vitest';
import { resolveComparison, describeComparison, NoBaselineError, NoDeployedBaselineError, NoPostError, ResolveContext } from '../../src/comparison';
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

  // CI's answer to a preview it cannot open: build both sides on the runner.
  // The GitHub stub has no routes, so any deployment lookup would throw.
  it('builds both sides locally and asks GitHub nothing when told to', async () => {
    const c = await resolveComparison(ctx({
      localOnly: true,
      config: { before: 'https://prod.com' },
      servePost: async () => ({ url: 'http://localhost:42222', stop: async () => undefined }),
      serveBaseline: async () => ({ url: 'http://localhost:41111', stop: async () => undefined }),
    }));
    expect(c.strategy).toBe('local');
    expect(c.before.url).toBe('http://localhost:41111');
    expect(c.after.url).toBe('http://localhost:42222');
    expect(c.mixed).toBe(false);
  });

  it('does not fall back to a production URL when told to stay local', async () => {
    await expect(resolveComparison(ctx({
      localOnly: true,
      config: { before: 'https://prod.com' },
      servePost: async () => ({ url: 'http://localhost:42222', stop: async () => undefined }),
    }))).rejects.toBeInstanceOf(NoBaselineError);
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

  it('falls back to local when the preview redirects to a Vercel sign-in page', async () => {
    const lines: string[] = [];
    const c = await resolveComparison(ctx({
      gh: gh({
        '/deployments?sha=head': [{ id: 1, environment: 'Preview' }],
        '/deployments/1/statuses': [{ state: 'success', environment_url: 'https://preview.app' }],
      }),
      config: { before: 'https://prod.com' },
      // Deployment Protection: 302 -> vercel.com/sso-api -> vercel.com/login, which answers 200.
      probe: async url => url.includes('preview')
        ? { status: 200, vercel: true, signIn: 'https://vercel.com/login?next=%2Fsso-api' }
        : { status: 200, vercel: false },
      devServer: Promise.resolve('http://localhost:3000'),
      serveBaseline: async () => ({ url: 'http://localhost:41111', stop: async () => undefined }),
      log: line => lines.push(line),
    }));
    expect(c.strategy).toBe('local');
    expect(lines.join('\n')).toContain('Preview deployment https://preview.app is not reachable');
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

  // The PR used to name Pre by its throwaway port, a different one every run.
  it('names local sides for a reviewer, not by port', async () => {
    const c = await resolveComparison(ctx({
      gh: gh({ '/deployments?sha=head': [], [`/commits/${PR.head.sha}/status`]: vercelStatus('pending'), '/issues/7/comments': [], '/deployments?sha=base': [] }),
      devServer: Promise.resolve('http://localhost:3000'),
      serveBaseline: async () => ({ url: 'http://localhost:41111', stop: async () => undefined }),
    }));
    expect(c.before.label).toBe(`base \`${PR.base.sha.slice(0, 7)}\``);
    expect(c.after.label).toBe('this branch');
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

  it('boots Pre and Post at the same time', async () => {
    const events: string[] = [];
    const slow = (name: string, url: string) => async () => {
      events.push(`${name} start`);
      await new Promise(r => setTimeout(r, 30));
      events.push(`${name} ready`);
      return { url, stop: async () => undefined };
    };
    await resolveComparison(ctx({
      gh: gh({ '/deployments?sha=': [] }),
      servePost: slow('post', 'http://localhost:42222'),
      serveBaseline: slow('pre', 'http://localhost:41111'),
    }));
    expect(events.slice(0, 2).sort()).toEqual(['post start', 'pre start']);
  });

  it('shuts down the baseline it started when the branch cannot be served', async () => {
    let stopped = false;
    await expect(resolveComparison(ctx({
      gh: gh({ '/deployments?sha=': [] }),
      serveBaseline: async () => ({ url: 'http://localhost:41111', stop: async () => { stopped = true; } }),
    }))).rejects.toBeInstanceOf(NoPostError);
    expect(stopped).toBe(true);
  });

  it('gives up on a slow baseline as soon as the branch cannot be served', async () => {
    let cancelled = false;
    const started = Date.now();
    await expect(resolveComparison(ctx({
      gh: gh({ '/deployments?sha=': [] }),
      servePost: async () => null,
      serveBaseline: ({ signal }) => new Promise(resolve => {
        const timer = setTimeout(() => resolve({ url: 'http://localhost:41111', stop: async () => undefined }), 5000);
        signal?.addEventListener('abort', () => { cancelled = true; clearTimeout(timer); resolve(null); });
      }),
    }))).rejects.toBeInstanceOf(NoPostError);
    expect(cancelled).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('shuts down the Post server when the baseline install fails', async () => {
    let stopped = false;
    await expect(resolveComparison(ctx({
      gh: gh({ '/deployments?sha=': [] }),
      servePost: async () => ({ url: 'http://localhost:42222', stop: async () => { stopped = true; } }),
      serveBaseline: async () => { throw new Error('install failed'); },
    }))).rejects.toThrow('install failed');
    expect(stopped).toBe(true);
  });

  it('pairs a preview with what is on production when the base commit was never deployed', async () => {
    const c = await resolveComparison(ctx({
      gh: gh({
        '/deployments?sha=head': [{ id: 1, environment: 'Preview' }],
        '/deployments?sha=base': [],
        '/deployments?per_page=100': [{ id: 3, environment: 'Production', sha: 'prod999888' }],
        '/deployments/1/statuses': [{ state: 'success', environment_url: 'https://preview.app' }],
        '/deployments/3/statuses': [{ state: 'success', environment_url: 'https://prod.com' }],
      }),
    }));
    expect(c.strategy).toBe('deployed');
    expect(c.before.url).toBe('https://prod.com');
    // Says which commit Pre is, rather than implying it is the fork point.
    expect(c.before.detail).toContain('prod999');
  });

  it('says the baseline is behind access control rather than telling you to pin it', async () => {
    const failure = await resolveComparison(ctx({
      gh: gh({
        '/deployments?sha=head': [{ id: 1, environment: 'Preview' }],
        '/deployments?sha=base': [{ id: 2, environment: 'Production' }],
        '/deployments/1/statuses': [{ state: 'success', environment_url: 'https://preview.app' }],
        '/deployments/2/statuses': [{ state: 'success', environment_url: 'https://prod.com' }],
      }),
      probe: async url => ({ status: url.includes('prod') ? 401 : 200, vercel: true }),
    })).catch(e => e);
    expect(failure).toBeInstanceOf(NoDeployedBaselineError);
    expect(failure.message).toContain('https://prod.com');
    expect(failure.message).toContain('401');
    // Pinning --before to the same protected URL would fail the same way.
    expect(failure.message).not.toContain('--before');
  });

  it('says the baseline is behind access control when it redirects to a sign-in page', async () => {
    const failure = await resolveComparison(ctx({
      gh: gh({
        '/deployments?sha=head': [{ id: 1, environment: 'Preview' }],
        '/deployments/1/statuses': [{ state: 'success', environment_url: 'https://preview.app' }],
      }),
      config: { before: 'https://prod.com' },
      probe: async url => url.includes('prod')
        ? { status: 200, vercel: true, signIn: 'https://vercel.com/login?next=%2Fsso-api' }
        : { status: 200, vercel: false },
    })).catch(e => e);
    expect(failure).toBeInstanceOf(NoDeployedBaselineError);
    expect(failure.message).toContain('https://prod.com');
    expect(failure.message).toContain('sign-in page');
    expect(failure.message).toContain('VERCEL_AUTOMATION_BYPASS_SECRET');
  });

  it('finds the preview for a commit before a PR is opened', async () => {
    const c = await resolveComparison(ctx({
      pr: null,
      headSha: 'loose1234567',
      gh: gh({
        '/deployments?sha=loose': [{ id: 1, environment: 'Preview' }],
        '/deployments?per_page=100': [{ id: 3, environment: 'Production', sha: 'prod999888' }],
        '/deployments/1/statuses': [{ state: 'success', environment_url: 'https://preview.app' }],
        '/deployments/3/statuses': [{ state: 'success', environment_url: 'https://prod.com' }],
      }),
    }));
    expect(c.strategy).toBe('deployed');
    expect(c.after.detail).toContain('loose12');
  });

  it('spends no baseline requests when there is no preview to pair with', async () => {
    const seen: string[] = [];
    const client = gh({ '/deployments?sha=': [] });
    const inner = (client as unknown as { request: (m: string, p: string) => Promise<unknown> }).request;
    (client as unknown as { request: (m: string, p: string) => Promise<unknown> }).request = (m, p) => {
      seen.push(p);
      return inner(m, p);
    };
    await expect(resolveComparison(ctx({ gh: client }))).rejects.toBeInstanceOf(NoPostError);
    expect(seen.some(p => p.includes('/deployments?per_page='))).toBe(false);
  });

  it('names the preview it found when there is nothing to compare it against', async () => {
    const failure = await resolveComparison(ctx({
      gh: gh({
        '/deployments?sha=head': [{ id: 1, environment: 'Preview' }],
        '/deployments?sha=base': [],
        '/deployments?per_page=100': [],
        '/deployments/1/statuses': [{ state: 'success', environment_url: 'https://preview.app' }],
      }),
    })).catch(e => e);
    expect(failure).toBeInstanceOf(NoDeployedBaselineError);
    expect(failure.message).toContain('https://preview.app');
    expect(failure.message).not.toContain('No preview deployment');
  });

  // --base is honoured by route detection, which hands the commit it used to
  // resolveComparison as `baseSha`. An open PR used to override it, so the run
  // published images for a diff the route list never described.
  it('builds the local baseline from the base detection used, not the PR base', async () => {
    const served: string[] = [];
    const c = await resolveComparison(ctx({
      gh: gh({ '/deployments?sha=': [] }),
      baseSha: 'explicit1234',
      devServer: Promise.resolve('http://localhost:3000'),
      serveBaseline: async ({ sha }) => { served.push(sha); return { url: 'http://localhost:4000', stop: async () => undefined }; },
    }));
    expect(served).toEqual(['explicit1234']);
    expect(c.before.detail).toContain('explici');
    expect(c.before.detail).not.toContain('base765');
  });

  it('pins the deployed baseline to the base detection used, not the PR base', async () => {
    const asked: string[] = [];
    const client = gh({
      '/deployments?sha=head': [{ id: 1, environment: 'Preview' }],
      '/deployments?sha=explicit': [{ id: 2, environment: 'Production' }],
      '/deployments/1/statuses': [{ state: 'success', environment_url: 'https://preview.app' }],
      '/deployments/2/statuses': [{ state: 'success', environment_url: 'https://pinned.app' }],
    });
    const inner = (client as unknown as { request: (m: string, p: string) => Promise<unknown> }).request;
    (client as unknown as { request: (m: string, p: string) => Promise<unknown> }).request = (m, p) => { asked.push(p); return inner(m, p); };
    const c = await resolveComparison(ctx({ gh: client, baseSha: 'explicit1234' }));
    expect(c.strategy).toBe('deployed');
    expect(c.before.url).toBe('https://pinned.app');
    expect(asked.some(p => p.includes('/deployments?sha=base7654321'))).toBe(false);
  });

  // Widening to latest production answers with a commit the caller did not ask
  // for, while the route list still describes the one they did -- so a named
  // base yields to the local strategy, which can build it from source.
  it('does not widen past a base the caller named when it was never deployed', async () => {
    const served: string[] = [];
    const notes: string[] = [];
    const c = await resolveComparison(ctx({
      gh: gh({
        '/deployments?sha=head': [{ id: 1, environment: 'Preview' }],
        '/deployments?sha=explicit': [],
        '/deployments?per_page=100': [{ id: 3, environment: 'Production', sha: 'unrelated99' }],
        '/deployments/1/statuses': [{ state: 'success', environment_url: 'https://preview.app' }],
        '/deployments/3/statuses': [{ state: 'success', environment_url: 'https://prod.com' }],
      }),
      baseSha: 'explicit1234',
      baseExplicit: true,
      devServer: Promise.resolve('http://localhost:3000'),
      serveBaseline: async ({ sha }) => { served.push(sha); return { url: 'http://localhost:4000', stop: async () => undefined }; },
      log: m => notes.push(m),
    }));
    expect(c.strategy).toBe('local');
    expect(c.before.url).not.toBe('https://prod.com');
    expect(served).toEqual(['explicit1234']);
    expect(notes.join('\n')).toContain('explici');
  });

  // A fork point this tool worked out on its own is still a starting point, and
  // widening is what keeps the deployed path usable; that must not regress.
  it('still widens to production for a base it detected rather than was given', async () => {
    const c = await resolveComparison(ctx({
      gh: gh({
        '/deployments?sha=head': [{ id: 1, environment: 'Preview' }],
        '/deployments?sha=detected': [],
        '/deployments?per_page=100': [{ id: 3, environment: 'Production', sha: 'unrelated99' }],
        '/deployments/1/statuses': [{ state: 'success', environment_url: 'https://preview.app' }],
        '/deployments/3/statuses': [{ state: 'success', environment_url: 'https://prod.com' }],
      }),
      baseSha: 'detected1234',
    }));
    expect(c.strategy).toBe('deployed');
    expect(c.before.url).toBe('https://prod.com');
  });

  // The PR's base is still the answer when detection resolved none of its own.
  it('falls back to the PR base when detection resolved no commit', async () => {
    const served: string[] = [];
    await resolveComparison(ctx({
      gh: gh({ '/deployments?sha=': [] }),
      devServer: Promise.resolve('http://localhost:3000'),
      serveBaseline: async ({ sha }) => { served.push(sha); return { url: 'http://localhost:4000', stop: async () => undefined }; },
    }));
    expect(served).toEqual(['base7654321']);
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

