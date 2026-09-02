/**
 * `pre-post login <url>` — open a real browser once, let the human sign in,
 * and keep the session for future captures of that host.
 */

import readline from 'readline';
import { launchHeadedBrowser } from '../doctor.js';
import { saveSession } from '../sessions.js';
import { normalizeUrl } from '../run.js';

function waitForEnter(prompt: string): Promise<void> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

export async function runLogin(url: string, log: (msg: string) => void = console.error): Promise<string> {
  const target = normalizeUrl(url);
  const host = new URL(target).hostname;
  const browser = await launchHeadedBrowser();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    log(`A browser window is open at ${target}.`);
    await waitForEnter('Log in there, then press Enter here to save the session... ');
    const state = await ctx.storageState();
    const file = saveSession(host, state as any);
    log(`Saved session for ${host} (${state.cookies.length} cookie(s)) to ${file}`);
    return file;
  } finally {
    await browser.close().catch(() => undefined);
  }
}
