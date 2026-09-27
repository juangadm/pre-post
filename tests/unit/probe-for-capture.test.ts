import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { probeForCapture } from '../../src/commands/pr';
import { saveSession } from '../../src/sessions';

const SIGN_IN = 'https://vercel.com/login?next=%2Fsso-api';
/** Every URL answers the way Deployment Protection does to a request with no cookies. */
const walled = async () => ({ status: 200, vercel: true, signIn: SIGN_IN });

describe('probeForCapture', () => {
  let dir: string;
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.XDG_CONFIG_HOME;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-sessions-'));
    process.env.XDG_CONFIG_HOME = dir;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the sign-in verdict when nothing will authenticate the capture', async () => {
    const result = await probeForCapture({}, undefined, walled)('https://preview.app/');
    expect(result.signIn).toBe(SIGN_IN);
  });

  // Rejecting here would tell the user to run `pre-post login`, which they already did.
  it('leaves the sign-in redirect to capture when a saved login covers the URL', async () => {
    saveSession('preview.app', { cookies: [{ name: '_vercel_jwt', value: 'x', domain: 'preview.app', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] });
    const probe = probeForCapture({}, undefined, walled);
    expect((await probe('https://preview.app/')).signIn).toBeUndefined();
    // A session for one host says nothing about another.
    expect((await probe('https://other.app/')).signIn).toBe(SIGN_IN);
  });

  it('leaves the sign-in redirect to capture when cookies are passed on the command line', async () => {
    const result = await probeForCapture({}, [{ name: 'session', value: 'x' }], walled)('https://preview.app/');
    expect(result.signIn).toBeUndefined();
    expect(result.status).toBe(200);
  });
});
