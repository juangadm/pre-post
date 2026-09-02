/**
 * .pre-post.json — per-repo configuration. Optional; every field has a default.
 * `resolveSettings` is the one place defaults, config, and CLI overrides meet.
 */

import fs from 'fs';
import path from 'path';
import { PrePostConfig } from './types.js';

export const CONFIG_FILENAME = '.pre-post.json';

export const CONFIG_DEFAULTS = {
  viewports: ['desktop', 'mobile'] as string[],
  threshold: 0.001,
  minChangedPixels: 40,
  maxRoutes: 6,
  fullPage: true,
  maxHeight: 2400,
  scale: 2,
  assetsBranch: 'pre-post-assets',
  pruneDays: 90,
};

export interface Settings {
  viewports: string[];
  threshold: number;
  minChangedPixels: number;
  maxRoutes: number;
  fullPage: boolean;
  maxHeight: number;
  scale: number;
  assetsBranch: string;
  pruneDays: number;
}

/** Defaults < .pre-post.json < explicit overrides (undefined overrides are ignored). */
export function resolveSettings(config: PrePostConfig = {}, overrides: Partial<Settings> = {}): Settings {
  const pick = <K extends keyof Settings>(key: K): Settings[K] =>
    (overrides[key] ?? (config as Partial<Settings>)[key] ?? CONFIG_DEFAULTS[key]) as Settings[K];
  return {
    viewports: pick('viewports'),
    threshold: pick('threshold'),
    minChangedPixels: pick('minChangedPixels'),
    maxRoutes: pick('maxRoutes'),
    fullPage: pick('fullPage'),
    maxHeight: pick('maxHeight'),
    scale: pick('scale'),
    assetsBranch: pick('assetsBranch'),
    pruneDays: pick('pruneDays'),
  };
}

export function configPath(repoRoot: string): string {
  return path.join(repoRoot, CONFIG_FILENAME);
}

export function loadConfig(repoRoot: string): PrePostConfig {
  const file = configPath(repoRoot);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (parsed && typeof parsed === 'object') return parsed as PrePostConfig;
    return {};
  } catch (err) {
    throw new Error(`${CONFIG_FILENAME} is not valid JSON: ${(err as Error).message}`);
  }
}

export function saveConfig(repoRoot: string, config: PrePostConfig): void {
  fs.writeFileSync(configPath(repoRoot), JSON.stringify(config, null, 2) + '\n');
}

/** Merge a partial update into the on-disk config (creating it if needed). */
export function updateConfig(repoRoot: string, patch: Partial<PrePostConfig>): PrePostConfig {
  const next = { ...loadConfig(repoRoot), ...patch };
  saveConfig(repoRoot, next);
  return next;
}
