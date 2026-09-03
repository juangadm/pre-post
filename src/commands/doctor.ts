/**
 * `pre-post doctor` — the same checks `pr` performs, reported instead of enforced.
 */

import fs from 'fs';
import path from 'path';
import { browserDescription } from '../browser.js';
import { configPath, CONFIG_FILENAME, loadConfig } from '../config.js';
import { detectDevServer, ensureBrowser } from '../doctor.js';
import { GH_LOGIN_HINT } from '../errors.js';
import { repoRoot } from '../git.js';
import { servableDir } from '../baseline.js';
import { getToken } from '../github.js';
import { closeBrowser } from '../browser.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runDoctor(cwd?: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  try {
    await ensureBrowser();
    checks.push({ name: 'browser', ok: true, detail: browserDescription() });
  } catch (err) {
    checks.push({ name: 'browser', ok: false, detail: (err as Error).message });
  } finally {
    await closeBrowser();
  }
  checks.push(getToken() ? { name: 'github', ok: true, detail: 'token found' } : { name: 'github', ok: false, detail: GH_LOGIN_HINT });
  const dev = await detectDevServer();
  checks.push(dev ? { name: 'devserver', ok: true, detail: dev } : { name: 'devserver', ok: false, detail: 'none found on the usual ports' });
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
    checks.push({ name: 'git', ok: false, detail: 'not a repository' });
  }
  return checks;
}
