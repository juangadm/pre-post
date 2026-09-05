/**
 * `pre-post doctor` — the same checks `pr` performs, reported instead of enforced.
 */

import fs from 'fs';
import path from 'path';
import { browserDescription } from '../browser.js';
import { configPath, CONFIG_FILENAME, loadConfig } from '../config.js';
import { ensureBrowser, scanDevServers } from '../doctor.js';
import { GH_LOGIN_HINT } from '../errors.js';
import { repoRoot } from '../git.js';
import { servableDir } from '../baseline.js';
import { getToken } from '../github.js';
import { closeBrowser } from '../browser.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /**
   * True when `pre-post pr` cannot run at all without this.
   *
   * The distinction is the whole exit-code contract. Most of what doctor
   * reports narrows *which strategy* a run will pick — no dev server just
   * means a deployment or the base commit will be served instead — and
   * failing the command for those would make the check useless, because
   * nearly every healthy machine trips one. Only the three things with no
   * alternative are required.
   */
  required?: boolean;
}

/**
 * doctor's contract, relied on by anything that runs it before a run:
 *
 *   exit 0  every required check passed; `pre-post pr` can run
 *   exit 1  a required check failed; it cannot
 *
 * Advisory failures never change the exit code — they are printed so a human
 * can see what was narrowed, not to fail the command.
 */
export function doctorExitCode(checks: DoctorCheck[]): number {
  return checks.some(c => c.required && !c.ok) ? 1 : 0;
}

export async function runDoctor(cwd?: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  try {
    await ensureBrowser();
    checks.push({ name: 'browser', ok: true, detail: browserDescription(), required: true });
  } catch (err) {
    checks.push({ name: 'browser', ok: false, detail: (err as Error).message, required: true });
  } finally {
    await closeBrowser();
  }
  // Required because `pr` calls requireToken() on any run that is not a dry
  // run, so without one the command stops before it captures anything.
  checks.push(getToken()
    ? { name: 'github', ok: true, detail: 'token found', required: true }
    : { name: 'github', ok: false, detail: GH_LOGIN_HINT, required: true });
  // Name the ports that answered but were passed over. "None found on the
  // usual ports" reads as a lie to anyone who knows something is listening on
  // one of them, and the usual something is a macOS system service on 5000.
  const dev = await scanDevServers();
  const ignored = dev.ignored.map(i => `${i.port} answered ${i.status}`).join(', ');
  checks.push(dev.url
    ? { name: 'devserver', ok: true, detail: dev.url }
    : { name: 'devserver', ok: false, detail: `none found on the usual ports${ignored ? ` (not a dev server: ${ignored})` : ''}` });
  try {
    const root = repoRoot(cwd);
    const cfg = loadConfig(root);
    checks.push(cfg.before ? { name: 'before', ok: true, detail: cfg.before } : { name: 'before', ok: false, detail: 'not set — pass --before once and it is saved' });
    checks.push({ name: 'config', ok: true, detail: fs.existsSync(configPath(root)) ? CONFIG_FILENAME : 'none (defaults)' });
    // The last-resort baseline serves the base commit itself, so knowing
    // whether anything here *can* be served is worth reporting before a run
    // needs it.
    const app = servableDir(root);
    checks.push(app
      ? { name: 'servable', ok: true, detail: `${path.relative(root, app.dir) || '.'} (${app.script})` }
      : { name: 'servable', ok: false, detail: 'no dev/serve/start script found; the local baseline is unavailable' });
  } catch {
    checks.push({ name: 'git', ok: false, detail: 'not a repository', required: true });
  }
  return checks;
}
