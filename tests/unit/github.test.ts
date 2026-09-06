import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GitHub, publishAssets, upsertStickyComment, findOpenPr, blobUrl, pruneAssets, checkWriteAccess, cannotPublishHint, findToken } from '../../src/github';
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

  // Removing every folder used to ask the API to build an empty tree, which it
  // refuses: measured on juangadm/pre-post, `base_tree` with every blob nulled
  // answers 404 and `tree: []` answers 422. So the branch keeps one file.
  it('leaves a README behind rather than asking for an empty tree', async () => {
    route(/\/git\/ref\/heads%2F/, 'GET', () => ({ object: { sha: 'head' } }));
    route(/\/git\/commits\/head$/, 'GET', () => ({ tree: { sha: 'tree' } }));
    route(/\/git\/trees\/tree\?recursive=1$/, 'GET', () => ({
      truncated: false,
      tree: [{ path: 'pr-1/x.png', type: 'blob', sha: 's', mode: '100644' }],
    }));
    route(/\/pulls\/1$/, 'GET', () => ({ state: 'closed', closed_at: '2020-01-01T00:00:00Z', merged_at: null }));
    route(/\/git\/trees$/, 'POST', () => ({ sha: 'tree2' }), 201);
    route(/\/git\/commits$/, 'POST', () => ({ sha: 'commit2' }), 201);
    route(/\/git\/refs\/heads%2F/, 'PATCH', () => ({}));

    const result = await pruneAssets(gh, 'acme/web', 'pre-post-assets', 90);
    expect(result.removed).toEqual(['pr-1']);
    expect(result.kept).toEqual([]);

    const tree = calls.find(c => c.path.endsWith('/git/trees') && c.method === 'POST')!;
    // A fresh tree, not a subtraction from the old one, and never empty.
    expect(tree.body.base_tree).toBeUndefined();
    expect(tree.body.tree.map((t: any) => t.path)).toEqual(['README.md']);
    expect(tree.body.tree[0].content).toContain('pre-post');
  });

  it('still subtracts from the existing tree when a folder survives', async () => {
    route(/\/git\/ref\/heads%2F/, 'GET', () => ({ object: { sha: 'head' } }));
    route(/\/git\/commits\/head$/, 'GET', () => ({ tree: { sha: 'tree' } }));
    route(/\/git\/trees\/tree\?recursive=1$/, 'GET', () => ({
      truncated: false,
      tree: [
        { path: 'pr-1/x.png', type: 'blob', sha: 's', mode: '100644' },
        { path: 'pr-2/y.png', type: 'blob', sha: 's', mode: '100644' },
      ],
    }));
    route(/\/pulls\/1$/, 'GET', () => ({ state: 'closed', closed_at: '2020-01-01T00:00:00Z', merged_at: null }));
    route(/\/pulls\/2$/, 'GET', () => ({ state: 'open', closed_at: null, merged_at: null }));
    route(/\/git\/trees$/, 'POST', () => ({ sha: 'tree2' }), 201);
    route(/\/git\/commits$/, 'POST', () => ({ sha: 'commit2' }), 201);
    route(/\/git\/refs\/heads%2F/, 'PATCH', () => ({}));

    await pruneAssets(gh, 'acme/web', 'pre-post-assets', 90);
    const tree = calls.find(c => c.path.endsWith('/git/trees') && c.method === 'POST')!;
    expect(tree.body.base_tree).toBe('tree');
    expect(tree.body.tree.map((t: any) => t.path)).toEqual(['pr-1/x.png']);
  });

  // An existing README is a survivor like any other, so the branch does not get
  // rebuilt from scratch once it has been emptied one time.
  it('treats a README left by an earlier prune as a survivor', async () => {
    route(/\/git\/ref\/heads%2F/, 'GET', () => ({ object: { sha: 'head' } }));
    route(/\/git\/commits\/head$/, 'GET', () => ({ tree: { sha: 'tree' } }));
    route(/\/git\/trees\/tree\?recursive=1$/, 'GET', () => ({
      truncated: false,
      tree: [
        { path: 'README.md', type: 'blob', sha: 's', mode: '100644' },
        { path: 'pr-1/x.png', type: 'blob', sha: 's', mode: '100644' },
      ],
    }));
    route(/\/pulls\/1$/, 'GET', () => ({ state: 'closed', closed_at: '2020-01-01T00:00:00Z', merged_at: null }));
    route(/\/git\/trees$/, 'POST', () => ({ sha: 'tree2' }), 201);
    route(/\/git\/commits$/, 'POST', () => ({ sha: 'commit2' }), 201);
    route(/\/git\/refs\/heads%2F/, 'PATCH', () => ({}));

    await pruneAssets(gh, 'acme/web', 'pre-post-assets', 90);
    const tree = calls.find(c => c.path.endsWith('/git/trees') && c.method === 'POST')!;
    expect(tree.body.base_tree).toBe('tree');
    expect(tree.body.tree.map((t: any) => t.path)).toEqual(['pr-1/x.png']);
  });

  // A truncated listing hides entries, so "nothing survives" would describe the
  // page rather than the branch; rebuilding on that would delete what was left
  // out. Subtracting from base_tree cannot empty a tree that has more in it.
  it('never rebuilds from a truncated listing, even when every entry it saw is stale', async () => {
    route(/\/git\/ref\/heads%2F/, 'GET', () => ({ object: { sha: 'head' } }));
    route(/\/git\/commits\/head$/, 'GET', () => ({ tree: { sha: 'tree' } }));
    route(/\/git\/trees\/tree\?recursive=1$/, 'GET', () => ({
      truncated: true,
      tree: [{ path: 'pr-1/x.png', type: 'blob', sha: 's', mode: '100644' }],
    }));
    route(/\/pulls\/1$/, 'GET', () => ({ state: 'closed', closed_at: '2020-01-01T00:00:00Z', merged_at: null }));
    route(/\/git\/trees$/, 'POST', () => ({ sha: 'tree2' }), 201);
    route(/\/git\/commits$/, 'POST', () => ({ sha: 'commit2' }), 201);
    route(/\/git\/refs\/heads%2F/, 'PATCH', () => ({}));

    await pruneAssets(gh, 'acme/web', 'pre-post-assets', 90);
    const tree = calls.find(c => c.path.endsWith('/git/trees') && c.method === 'POST')!;
    expect(tree.body.base_tree).toBe('tree');
    expect(tree.body.tree.map((t: any) => t.path)).toEqual(['pr-1/x.png']);
    expect(tree.body.tree.some((t: any) => t.path === 'README.md')).toBe(false);
  });

  it('names a race rather than blaming the token for it', async () => {
    route(/\/git\/ref\/heads%2F/, 'GET', () => ({ object: { sha: 'head' } }));
    route(/\/git\/commits\/head$/, 'GET', () => ({ tree: { sha: 'tree' } }));
    route(/\/git\/trees\/tree\?recursive=1$/, 'GET', () => ({
      truncated: false,
      tree: [
        { path: 'pr-1/x.png', type: 'blob', sha: 's', mode: '100644' },
        { path: 'pr-2/y.png', type: 'blob', sha: 's', mode: '100644' },
      ],
    }));
    route(/\/pulls\/1$/, 'GET', () => ({ state: 'closed', closed_at: '2020-01-01T00:00:00Z', merged_at: null }));
    route(/\/pulls\/2$/, 'GET', () => ({ state: 'open', closed_at: null, merged_at: null }));
    route(/\/git\/trees$/, 'POST', () => ({ sha: 'tree2' }), 201);
    route(/\/git\/commits$/, 'POST', () => ({ sha: 'commit2' }), 201);
    route(/\/git\/refs\/heads%2F/, 'PATCH', () => ({ message: 'Update is not a fast forward' }), 422);

    const failure = await pruneAssets(gh, 'acme/web', 'pre-post-assets', 90).catch(e => e);
    expect(failure).toBeInstanceOf(NeedsHumanError);
    expect(failure.message).toContain('Another run moved');
    expect(failure.message).not.toContain('contents: write');
  });

  it('calls a 5xx transient rather than an access problem', async () => {
    route(/\/git\/ref\/heads%2F/, 'GET', () => ({ object: { sha: 'head' } }));
    route(/\/git\/commits\/head$/, 'GET', () => ({ tree: { sha: 'tree' } }));
    route(/\/git\/trees\/tree\?recursive=1$/, 'GET', () => ({
      truncated: false,
      tree: [{ path: 'pr-1/x.png', type: 'blob', sha: 's', mode: '100644' }],
    }));
    route(/\/pulls\/1$/, 'GET', () => ({ state: 'closed', closed_at: '2020-01-01T00:00:00Z', merged_at: null }));
    route(/\/git\/trees$/, 'POST', () => ({ message: 'Server Error' }), 500);

    const failure = await pruneAssets(gh, 'acme/web', 'pre-post-assets', 90).catch(e => e);
    expect(failure).toBeInstanceOf(NeedsHumanError);
    expect(failure.message).toContain('500');
    expect(failure.message).not.toContain('contents: write');
  });

  it('asks the human to fix access when the write is refused', async () => {
    route(/\/git\/ref\/heads%2F/, 'GET', () => ({ object: { sha: 'head' } }));
    route(/\/git\/commits\/head$/, 'GET', () => ({ tree: { sha: 'tree' } }));
    route(/\/git\/trees\/tree\?recursive=1$/, 'GET', () => ({
      truncated: false,
      tree: [{ path: 'pr-1/x.png', type: 'blob', sha: 's', mode: '100644' }],
    }));
    route(/\/pulls\/1$/, 'GET', () => ({ state: 'closed', closed_at: '2020-01-01T00:00:00Z', merged_at: null }));
    route(/\/git\/trees$/, 'POST', () => ({ message: 'Not Found' }), 404);

    const failure = await pruneAssets(gh, 'acme/web', 'pre-post-assets', 90).catch(e => e);
    expect(failure).toBeInstanceOf(NeedsHumanError);
    expect(failure.message).toContain('pre-post-assets');
    expect(failure.message).toContain('contents: write');
    expect(failure.message.split('. ').length).toBeLessThanOrEqual(2);
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

describe('findToken', () => {
  const saved = { gh: process.env.GH_TOKEN, github: process.env.GITHUB_TOKEN };
  afterEach(() => {
    for (const [k, v] of [['GH_TOKEN', saved.gh], ['GITHUB_TOKEN', saved.github]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it('prefers GH_TOKEN and says so', () => {
    process.env.GH_TOKEN = 'a';
    process.env.GITHUB_TOKEN = 'b';
    expect(findToken()).toEqual({ token: 'a', source: 'GH_TOKEN' });
  });

  it('falls back to GITHUB_TOKEN', () => {
    delete process.env.GH_TOKEN;
    process.env.GITHUB_TOKEN = 'b';
    expect(findToken()).toEqual({ token: 'b', source: 'GITHUB_TOKEN' });
  });
});

describe('cannotPublishHint', () => {
  afterEach(() => { delete process.env.GITHUB_ACTIONS; });

  it('names the workflow permissions when the run is on the job\'s own GITHUB_TOKEN', () => {
    process.env.GITHUB_ACTIONS = 'true';
    const hint = cannotPublishHint('acme/web', 'GITHUB_TOKEN');
    expect(hint).toContain('contents: write');
    // Both, not just the one the check tested: a permissions block sets every
    // scope it omits to none, so naming contents alone would leave a token that
    // uploads the images and is then refused the PR description.
    expect(hint).toContain('pull-requests: write');
    expect(hint).not.toContain('gh auth login');
  });

  // Rewriting the job's permissions changes the GITHUB_TOKEN this run never
  // reaches: GH_TOKEN wins in findToken(), so it is the one to fix.
  it('names GH_TOKEN, not the permissions block, when a workflow sets one', () => {
    process.env.GITHUB_ACTIONS = 'true';
    const hint = cannotPublishHint('acme/web', 'GH_TOKEN');
    expect(hint).toContain('GH_TOKEN');
    expect(hint).toContain('unset it');
  });

  it('names the gh CLI login outside a runner', () => {
    const hint = cannotPublishHint('acme/web', 'gh');
    expect(hint).toContain('gh auth login');
    expect(hint).toContain('acme/web');
    expect(hint).not.toContain('permissions');
  });

  // An env var shadows the gh CLI, so "run gh auth login" is advice that cannot
  // work while it is set — the same mistake as the permissions block above.
  it('does not send someone to gh auth login while an env var is shadowing it', () => {
    const hint = cannotPublishHint('acme/web', 'GH_TOKEN');
    expect(hint).toContain('GH_TOKEN');
    expect(hint).toContain('unset it');
  });

  // AGENTS.md: a NeedsHumanError carries a single actionable sentence.
  it('is one sentence for every source, in and out of a runner', () => {
    for (const inActions of [true, false]) {
      if (inActions) process.env.GITHUB_ACTIONS = 'true'; else delete process.env.GITHUB_ACTIONS;
      for (const source of ['GH_TOKEN', 'GITHUB_TOKEN', 'gh'] as const) {
        const hint = cannotPublishHint('acme/web', source);
        expect(hint.match(/\.(\s|$)/g) ?? []).toHaveLength(1);
        expect(hint.trimEnd().endsWith('.')).toBe(true);
      }
    }
  });
});
