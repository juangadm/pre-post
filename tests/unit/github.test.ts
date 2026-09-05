import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GitHub, publishAssets, upsertStickyComment, findOpenPr, blobUrl, pruneAssets, checkWriteAccess, cannotPublishHint } from '../../src/github';
import { NeedsHumanError } from '../../src/errors';

type Call = { method: string; path: string; body?: any };
let calls: Call[];
let responses: Array<(c: Call) => { status: number; body: any } | undefined>;

function route(pattern: RegExp, method: string, handler: (c: Call, m: RegExpMatchArray) => any, status = 200) {
  responses.push(c => {
    const m = c.path.match(pattern);
    if (!m || c.method !== method) return undefined;
    return { status, body: handler(c, m) };
  });
}

beforeEach(() => {
  calls = [];
  responses = [];
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    const path = url.replace('https://api.github.com', '');
    const call: Call = { method: init.method, path, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    for (const r of responses) {
      const res = r(call);
      if (res) return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  });
});

afterEach(() => vi.unstubAllGlobals());

const gh = new GitHub('token');

describe('blobUrl', () => {
  it('builds a raw-rendering blob URL and encodes path segments', () => {
    expect(blobUrl('acme/web', 'abc', 'pr-1/a b.png')).toBe('https://github.com/acme/web/blob/abc/pr-1/a%20b.png?raw=true');
  });
});

describe('auth failures', () => {
  it('turns a 401 into a one-sentence instruction for the human', async () => {
    route(/\/pulls\?/, 'GET', () => ({ message: 'Bad credentials' }), 401);
    await expect(findOpenPr(gh, 'acme/web', 'x')).rejects.toBeInstanceOf(NeedsHumanError);
  });
});

describe('findOpenPr', () => {
  it('queries by owner:branch head', async () => {
    route(/\/repos\/acme\/web\/pulls\?/, 'GET', () => [{ number: 7, html_url: 'u' }]);
    const pr = await findOpenPr(gh, 'acme/web', 'feat/x');
    expect(pr?.number).toBe(7);
    expect(calls[0].path).toContain('head=acme%3Afeat%2Fx');
  });

  it('returns null when there is no PR', async () => {
    route(/\/pulls\?/, 'GET', () => []);
    expect(await findOpenPr(gh, 'acme/web', 'nope')).toBeNull();
  });
});

describe('publishAssets', () => {
  const files = [
    { path: 'pr-1/a.png', content: Buffer.from('a') },
    { path: 'pr-1/b.png', content: Buffer.from('b') },
  ];

  it('creates an orphan branch when the assets branch does not exist', async () => {
    let blob = 0;
    route(/\/git\/blobs$/, 'POST', () => ({ sha: `blob${++blob}` }), 201);
    route(/\/git\/trees$/, 'POST', () => ({ sha: 'tree1' }), 201);
    route(/\/git\/commits$/, 'POST', () => ({ sha: 'commit1' }), 201);
    route(/\/git\/refs$/, 'POST', () => ({ ref: 'refs/heads/pre-post-assets' }), 201);

    const result = await publishAssets(gh, 'acme/web', 'pre-post-assets', files, 'msg');
    expect(result.sha).toBe('commit1');
    expect(result.urls.get('pr-1/a.png')).toBe('https://github.com/acme/web/blob/commit1/pr-1/a.png?raw=true');

    const commit = calls.find(c => c.path.endsWith('/git/commits') && c.method === 'POST')!;
    expect(commit.body.parents).toEqual([]);
    const tree = calls.find(c => c.path.endsWith('/git/trees'))!;
    expect(tree.body.base_tree).toBeUndefined();
    expect(tree.body.tree).toHaveLength(2);
    expect(calls.filter(c => c.path.endsWith('/git/blobs'))).toHaveLength(2);
  });

  it('appends a single commit on top of an existing branch', async () => {
    route(/\/git\/blobs$/, 'POST', () => ({ sha: 'blob' }), 201);
    route(/\/git\/ref\/heads%2Fpre-post-assets$/, 'GET', () => ({ object: { sha: 'head0' } }));
    route(/\/git\/commits\/head0$/, 'GET', () => ({ tree: { sha: 'tree0' } }));
    route(/\/git\/trees$/, 'POST', () => ({ sha: 'tree1' }), 201);
    route(/\/git\/commits$/, 'POST', () => ({ sha: 'commit1' }), 201);
    route(/\/git\/refs\/heads%2Fpre-post-assets$/, 'PATCH', () => ({ object: { sha: 'commit1' } }));

    const result = await publishAssets(gh, 'acme/web', 'pre-post-assets', files, 'msg');
    expect(result.sha).toBe('commit1');
    const commit = calls.find(c => c.path.endsWith('/git/commits') && c.method === 'POST')!;
    expect(commit.body.parents).toEqual(['head0']);
    const tree = calls.find(c => c.path.endsWith('/git/trees'))!;
    expect(tree.body.base_tree).toBe('tree0');
    expect(calls.some(c => c.method === 'PATCH')).toBe(true);
  });

  it('retries when another run moved the ref first', async () => {
    let patches = 0;
    route(/\/git\/blobs$/, 'POST', () => ({ sha: 'blob' }), 201);
    route(/\/git\/ref\/heads%2F/, 'GET', () => ({ object: { sha: 'head0' } }));
    route(/\/git\/commits\/head0$/, 'GET', () => ({ tree: { sha: 'tree0' } }));
    route(/\/git\/trees$/, 'POST', () => ({ sha: 'tree1' }), 201);
    route(/\/git\/commits$/, 'POST', () => ({ sha: 'commit1' }), 201);
    responses.push(c => {
      if (c.method !== 'PATCH') return undefined;
      patches++;
      return patches === 1 ? { status: 422, body: { message: 'Update is not a fast forward' } } : { status: 200, body: {} };
    });
    const result = await publishAssets(gh, 'acme/web', 'pre-post-assets', files, 'msg');
    expect(result.sha).toBe('commit1');
    expect(patches).toBe(2);
  });
});

describe('upsertStickyComment', () => {
  it('updates the existing marked comment', async () => {
    route(/\/issues\/5\/comments\?/, 'GET', () => [{ id: 1, body: 'hi' }, { id: 2, body: 'MARK\nold', html_url: 'c2' }]);
    route(/\/issues\/comments\/2$/, 'PATCH', () => ({ id: 2, html_url: 'c2' }));
    const res = await upsertStickyComment(gh, 'acme/web', 5, 'MARK\nnew', 'MARK');
    expect(res.created).toBe(false);
    expect(calls.find(c => c.method === 'PATCH')!.body.body).toBe('MARK\nnew');
  });

  it('creates a comment when none carries the marker', async () => {
    route(/\/issues\/5\/comments\?/, 'GET', () => [{ id: 1, body: 'hi' }]);
    route(/\/issues\/5\/comments$/, 'POST', () => ({ id: 9, html_url: 'c9' }), 201);
    const res = await upsertStickyComment(gh, 'acme/web', 5, 'MARK\nnew', 'MARK');
    expect(res.created).toBe(true);
    expect(res.html_url).toBe('c9');
  });
});

describe('pruneAssets', () => {
  it('removes folders of PRs closed long ago and keeps open ones', async () => {
    route(/\/git\/ref\/heads%2F/, 'GET', () => ({ object: { sha: 'head' } }));
    route(/\/git\/commits\/head$/, 'GET', () => ({ tree: { sha: 'tree' } }));
    route(/\/git\/trees\/tree\?recursive=1$/, 'GET', () => ({
      truncated: false,
      tree: [
        { path: 'pr-1/x.png', type: 'blob', sha: 's', mode: '100644' },
        { path: 'pr-2/y.png', type: 'blob', sha: 's', mode: '100644' },
        { path: 'pr-3/z.png', type: 'blob', sha: 's', mode: '100644' },
      ],
    }));
    route(/\/pulls\/1$/, 'GET', () => ({ state: 'closed', closed_at: '2020-01-01T00:00:00Z', merged_at: null }));
    route(/\/pulls\/2$/, 'GET', () => ({ state: 'open', closed_at: null, merged_at: null }));
    route(/\/pulls\/3$/, 'GET', () => ({ message: 'Not Found' }), 404);
    route(/\/git\/trees$/, 'POST', () => ({ sha: 'tree2' }), 201);
    route(/\/git\/commits$/, 'POST', () => ({ sha: 'commit2' }), 201);
    route(/\/git\/refs\/heads%2F/, 'PATCH', () => ({}));

    const result = await pruneAssets(gh, 'acme/web', 'pre-post-assets', 90);
    expect(result.removed).toEqual(['pr-1', 'pr-3']);
    expect(result.kept).toEqual(['pr-2']);
    const tree = calls.find(c => c.path.endsWith('/git/trees') && c.method === 'POST')!;
    expect(tree.body.tree.map((t: any) => t.path)).toEqual(['pr-1/x.png', 'pr-3/z.png']);
    expect(tree.body.tree.every((t: any) => t.sha === null)).toBe(true);
  });

  it('does nothing when the branch does not exist', async () => {
    const result = await pruneAssets(gh, 'acme/web', 'pre-post-assets', 90);
    expect(result).toEqual({ removed: [], kept: [] });
  });
});

describe('checkWriteAccess', () => {
  const blobs = /\/repos\/acme\/web\/git\/blobs$/;

  it('writes the empty blob, which stores nothing a repository does not already have', async () => {
    route(blobs, 'POST', () => ({ sha: 'e69de29' }), 201);
    expect(await checkWriteAccess(gh, 'acme/web')).toEqual({ writable: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ content: '', encoding: 'utf-8' });
  });

  // Measured on juangadm/pre-post: a workflow mapping secrets.GITHUB_TOKEN with
  // the repository's default permissions reads /pulls at 200 and gets this.
  it('reports a rejection when the write is refused', async () => {
    route(blobs, 'POST', () => ({ message: 'Resource not accessible by integration' }), 403);
    expect(await checkWriteAccess(gh, 'acme/web')).toEqual({ writable: false, reason: 'rejected' });
  });

  it('reports a rejection when the token is not accepted at all', async () => {
    route(blobs, 'POST', () => ({ message: 'Bad credentials' }), 401);
    expect(await checkWriteAccess(gh, 'acme/web')).toEqual({ writable: false, reason: 'rejected' });
  });

  it('reports a rejection when the repository is hidden rather than refused', async () => {
    route(blobs, 'POST', () => ({ message: 'Not Found' }), 404);
    expect(await checkWriteAccess(gh, 'acme/web')).toEqual({ writable: false, reason: 'rejected' });
  });

  // A broken API is not evidence about a token. Reading it as one would stop
  // runs whose credentials are fine — the mirror image of the all-clear.
  it('does not call a server error a rejection', async () => {
    route(blobs, 'POST', () => ({ message: 'Server Error' }), 500);
    const access = await checkWriteAccess(gh, 'acme/web');
    expect(access).toMatchObject({ writable: false, reason: 'unknown' });
  });

  it('does not call an unreachable API a rejection', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed'); });
    const access = await checkWriteAccess(gh, 'acme/web');
    expect(access).toMatchObject({ writable: false, reason: 'unknown', detail: 'fetch failed' });
  });
});

describe('cannotPublishHint', () => {
  afterEach(() => { delete process.env.GITHUB_ACTIONS; });

  // Both permissions, not just the one the check tested: a permissions block
  // sets every scope it omits to none, so naming contents alone would leave a
  // token that uploads the images and is then refused the PR description.
  it('names the workflow permissions inside a runner, where gh auth login is not an option', () => {
    process.env.GITHUB_ACTIONS = 'true';
    const hint = cannotPublishHint('acme/web');
    expect(hint).toContain('contents: write');
    expect(hint).toContain('pull-requests: write');
    expect(hint).not.toContain('gh auth login');
  });

  it('names the token outside a runner, where the workflow file is not the problem', () => {
    const hint = cannotPublishHint('acme/web');
    expect(hint).toContain('gh auth login');
    expect(hint).toContain('acme/web');
    expect(hint).not.toContain('permissions');
  });

  // AGENTS.md: a NeedsHumanError carries a single actionable sentence.
  it('is one sentence either way', () => {
    for (const inActions of [true, false]) {
      if (inActions) process.env.GITHUB_ACTIONS = 'true'; else delete process.env.GITHUB_ACTIONS;
      const hint = cannotPublishHint('acme/web');
      expect(hint.match(/\.(\s|$)/g) ?? []).toHaveLength(1);
      expect(hint.trimEnd().endsWith('.')).toBe(true);
    }
  });
});
