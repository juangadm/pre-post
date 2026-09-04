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
  /**
   * Smallest painted change that counts, in CSS pixels².
   *
   * Roughly a third of a 16px icon. Against the fixture ladder every real
   * change measures 242 CSS px² or more while every no-op measures exactly 0,
   * so this sits in the middle of a wide empty band — low enough that missing
   * a real change (the worse error by far: the tool would report "no visual
   * changes" on a PR that changed something) stays implausible, high enough to
   * absorb antialiasing differences between two machines.
   */
  minChangedArea: 100,
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
  minChangedArea: number;
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
  // minChangedPixels was device pixels. Fold it into the one precedence chain
  // rather than silently ignoring a value someone tuned.
  if (config.minChangedArea === undefined && config.minChangedPixels !== undefined) {
    const scale = pick('scale');
    config = { ...config, minChangedArea: config.minChangedPixels / (scale * scale) };
  }
  return {
    viewports: pick('viewports'),
    threshold: pick('threshold'),
    minChangedArea: pick('minChangedArea'),
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
