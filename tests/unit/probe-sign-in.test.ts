import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import { probeUrl } from '../../src/doctor';

/**
 * Vercel Deployment Protection does not answer 401: it redirects to
 * vercel.com/sso-api, which lands on a 200 login page. The probe follows
 * redirects, so without looking at where it ended up it reads the wall as a site.
 */
describe('probeUrl behind a sign-in redirect', () => {
  const servers: http.Server[] = [];
  const serve = (handler: http.RequestListener): Promise<string> =>
    new Promise(resolve => {
      const s = http.createServer(handler);
      servers.push(s);
      s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as { port: number }).port}`));
    });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(s => new Promise(r => s.close(() => r(null)))));
  });

  const page = (r: http.ServerResponse, body = '<html></html>') => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(body); };

  /** A stand-in for vercel.com: /sso-api bounces to /login, which renders a form. */
  async function vercelSso(): Promise<string> {
    const sso = await serve((q, r) => {
      if (q.url?.startsWith('/sso-api')) { r.writeHead(302, { location: '/login?next=%2Fsso-api' }); r.end(); return; }
      page(r, '<title>Login – Vercel</title>');
    });
    return sso;
  }

  it('reports the sign-in page a protected deployment redirects to', async () => {
    const sso = await vercelSso();
    const preview = await serve((q, r) => {
      r.writeHead(302, { location: `${sso}/sso-api?url=${encodeURIComponent('https://preview.app/')}` });
      r.end();
    });
    const result = await probeUrl(`${preview}/`);
    expect(result.status).toBe(200);
    expect(result.signIn).toBe(`${sso}/login?next=%2Fsso-api`);
  });

  it('does not flag a deployment reached with the bypass header, which is not redirected', async () => {
    const sso = await vercelSso();
    const preview = await serve((q, r) => {
      if (q.headers['x-vercel-protection-bypass'] === 'secret') { page(r); return; }
      r.writeHead(302, { location: `${sso}/sso-api?url=x` });
      r.end();
    });
    const result = await probeUrl(`${preview}/`, { 'x-vercel-protection-bypass': 'secret' });
    expect(result.status).toBe(200);
    expect(result.signIn).toBeUndefined();
  });

  it('does not flag an ordinary redirect', async () => {
    const site = await serve((q, r) => {
      if (q.url === '/') { r.writeHead(307, { location: '/en' }); r.end(); return; }
      page(r);
    });
    const result = await probeUrl(`${site}/`);
    expect(result.status).toBe(200);
    expect(result.signIn).toBeUndefined();
  });

  it('does not flag a page that is itself a login route', async () => {
    const site = await serve((_q, r) => page(r));
    expect((await probeUrl(`${site}/login`)).signIn).toBeUndefined();
  });
});
