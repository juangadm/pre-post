/**
 * `pre-post detect` — which routes does this branch touch? Compact JSON for agents.
 */

import path from 'path';
import { Framework } from '../types.js';
import { loadConfig } from '../config.js';
import { repoRoot } from '../git.js';
import { detectRoutesForRepo } from '../routes.js';

export function runDetect(opts: { cwd?: string; maxRoutes?: number; framework?: Framework; base?: string } = {}) {
  const root = repoRoot(opts.cwd);
  const detection = detectRoutesForRepo({ cwd: root, config: loadConfig(root), maxRoutes: opts.maxRoutes, framework: opts.framework, diffTarget: opts.base });
  return {
    framework: detection.framework,
    appRoot: path.relative(root, detection.appRoot) || '.',
    changedFiles: detection.changedFiles.length,
    // Which commit the count is relative to. A reader who cannot see this
    // cannot tell "nothing changed" from "compared against the wrong thing".
    base: detection.base && { sha: detection.base.sha.slice(0, 7), source: detection.base.source },
    routes: detection.routes.map(r => ({ path: r.path, confidence: r.confidence, reason: r.reason })),
    skippedDynamic: detection.skippedDynamic,
  };
}
