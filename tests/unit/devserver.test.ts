import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import { looksLikeDevServer, scanDevServers } from '../../src/doctor';

const html = { status: 200, vercel: false, contentType: 'text/html' };

describe('looksLikeDevServer', () => {
  it('accepts a page', () => {
    expect(looksLikeDevServer(html)).toBe(true);
    expect(looksLikeDevServer({ ...html, contentType: 'application/xhtml+xml' })).toBe(true);
  });

  it('rejects the port that started this: something listening but forbidding', () => {
    // macOS AirPlay Receiver on 5000: answers, 403, no body, no site.
    expect(looksLikeDevServer({ status: 403, vercel: false })).toBe(false);
    expect(looksLikeDevServer({ status: 401, vercel: false })).toBe(false);
    // Even if a wall serves its login page as HTML, it is still not the site.
    expect(looksLikeDevServer({ status: 403, vercel: false, contentType: 'text/html' })).toBe(false);
  });

  it('rejects a port that answers with something other than a page', () => {
    expect(looksLikeDevServer({ status: 200, vercel: false, contentType: 'application/json' })).toBe(false);
    expect(looksLikeDevServer({ status: 200, vercel: false })).toBe(false);
  });

  it('rejects a port nothing is on', () => {
    expect(looksLikeDevServer({ status: null, vercel: false })).toBe(false);
  });

  it('accepts a redirect, which has no body to judge', () => {
    expect(looksLikeDevServer({ status: 307, vercel: false })).toBe(true);
    expect(looksLikeDevServer({ status: 301, vercel: false })).toBe(true);
  });

  it('keeps a dev server that has no / route, or a compile error on it', () => {
    expect(looksLikeDevServer({ ...html, status: 404 })).toBe(true);
    expect(looksLikeDevServer({ ...html, status: 500 })).toBe(true);
  });
});

describe('scanDevServers', () => {
  const servers: http.Server[] = [];
  const serve = (port: number, handler: http.RequestListener): Promise<void> =>
    new Promise(resolve => {
      const s = http.createServer(handler);
      servers.push(s);
      s.listen(port, '127.0.0.1', () => resolve());
    });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(s => new Promise(r => s.close(() => r(null)))));
  });

  const forbidden: http.RequestListener = (_q, r) => { r.writeHead(403, { 'Content-Length': '0' }); r.end(); };
  const page: http.RequestListener = (_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<html></html>'); };

  it('does not adopt a port that only forbids, and says it passed it over', async () => {
    await serve(45071, forbidden);
    const scan = await scanDevServers([45071]);
    expect(scan.url).toBe(null);
    expect(scan.ignored).toEqual([{ port: 45071, status: 403 }]);
  });

  it('finds the dev server past a stranger holding an earlier port', async () => {
    await serve(45071, forbidden);
    await serve(45072, page);
    const scan = await scanDevServers([45071, 45072]);
    expect(scan.url).toBe('http://localhost:45072');
  });

  it('reports nothing when nothing is listening', async () => {
    const scan = await scanDevServers([45079]);
    expect(scan).toEqual({ url: null, ignored: [] });
  });
});
