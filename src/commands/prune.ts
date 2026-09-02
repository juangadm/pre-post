/**
 * `pre-post prune` — delete screenshots for PRs closed more than N days ago.
 */

import { loadConfig, resolveSettings } from '../config.js';
import { repoRoot, resolveOwnerRepo } from '../git.js';
import { GitHub, pruneAssets, PruneResult, requireToken } from '../github.js';

export async function runPrune(opts: { cwd?: string; days?: number; dryRun?: boolean } = {}): Promise<PruneResult> {
  const root = repoRoot(opts.cwd);
  const settings = resolveSettings(loadConfig(root), { pruneDays: opts.days });
  const gh = new GitHub(requireToken('prune screenshots'));
  return pruneAssets(gh, resolveOwnerRepo(root), settings.assetsBranch, settings.pruneDays, opts.dryRun);
}
