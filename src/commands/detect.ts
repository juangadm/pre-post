/**
 * `pre-post detect` — which routes does this branch touch? Compact JSON for agents.
 */

import path from 'path';
import { Framework } from '../types.js';
import { loadConfig } from '../config.js';
import { repoRoot } from '../git.js';
import { detectRoutesForRepo } from '../routes.js';

export function runDetect(opts: { cwd?: string; maxRoutes?: number; framework?: Framework } = {}) {
  const root = repoRoot(opts.cwd);
  const detection = detectRoutesForRepo({ cwd: root, config: loadConfig(root), maxRoutes: opts.maxRoutes, framework: opts.framework });
  return {
    framework: detection.framework,
    appRoot: path.relative(root, detection.appRoot) || '.',
    changedFiles: detection.changedFiles.length,
    routes: detection.routes.map(r => ({ path: r.path, confidence: r.confidence, reason: r.reason })),
    skippedDynamic: detection.skippedDynamic,
  };
}
