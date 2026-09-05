/**
 * Saved browser sessions from `pre-post login <url>`.
 * Stored per host under the user's config dir, never inside the repo.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { AuthOptions } from './types.js';

export interface StorageState {
  cookies: Array<{
    name: string; value: string; domain: string; path: string;
    expires: number; httpOnly: boolean; secure: boolean; sameSite: 'Strict' | 'Lax' | 'None';
  }>;
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}

export function sessionsDir(): string {
  const base = process.env.XDG_CONFIG_HOME
    || (process.platform === 'win32' ? process.env.APPDATA : undefined)
    || path.join(os.homedir(), '.config');
  return path.join(base, 'pre-post', 'sessions');
}

export function sessionPath(host: string): string {
  return path.join(sessionsDir(), `${host.replace(/[^\w.-]/g, '_')}.json`);
}

export function saveSession(host: string, state: StorageState): string {
  fs.mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });
  const file = sessionPath(host);
  fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  return file;
}

export function loadSession(host: string): StorageState | null {
  const file = sessionPath(host);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as StorageState;
  } catch {
    return null;
  }
}

/** Cookies from every saved session whose host matches one of the URLs. */
export function cookiesForUrls(urls: string[]): StorageState['cookies'] {
  const out: StorageState['cookies'] = [];
  const hosts = new Set<string>();
  for (const u of urls) {
    try {
      hosts.add(new URL(u).hostname);
    } catch { /* ignore */ }
  }
  for (const host of hosts) {
    const state = loadSession(host);
    if (!state) continue;
    const now = Date.now() / 1000;
    for (const c of state.cookies) {
      if (c.expires && c.expires > 0 && c.expires < now) continue;
      out.push(c);
    }
  }
  return out;
}

export interface ResolveAuthInput {
  /** Headers from .pre-post.json */
  configHeaders?: Record<string, string>;
  /** Headers from the command line */
  headers?: Record<string, string>;
  /** Cookies from the command line, applied to `cookieUrl` */
  cookies?: Array<{ name: string; value: string }>;
  cookieUrl?: string;
  /** URLs whose saved login sessions should be reused */
  urls: string[];
}

/**
 * Everything that authenticates a capture, from every source: config headers,
 * CLI headers, the Vercel bypass secret, CLI cookies, and saved login sessions.
 */
export function resolveAuth(input: ResolveAuthInput): AuthOptions | undefined {
  const headers: Record<string, string> = { ...(input.configHeaders || {}), ...(input.headers || {}) };
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  // The bypass header alone is enough, and it is all we send. Asking for the
  // cookie as well (`x-vercel-set-bypass-cookie: true`) makes the host set it
  // through a redirect, which a client that keeps no cookie jar can never
  // satisfy: the reachability probe uses plain `fetch`, so it looped until it
  // threw and every protected preview was reported as unreachable. Measured
  // against a live protected deployment on 2026-09-05 — with the one header,
  // 200 and no redirect; with both, 307 until curl gave up at 50.
  if (bypass && !headers['x-vercel-protection-bypass']) {
    headers['x-vercel-protection-bypass'] = bypass;
  }
  const cookies: NonNullable<AuthOptions['cookies']> = [
    ...cookiesForUrls(input.urls),
    ...(input.cookies || []).map(c => ({ ...c, url: input.cookieUrl ?? input.urls[0] })),
  ];
  return Object.keys(headers).length || cookies.length ? { headers, cookies } : undefined;
}
