import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig, resolveSettings, saveConfig, updateConfig, CONFIG_FILENAME, CONFIG_DEFAULTS } from '../../src/config';

let root: string;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pre-post-config-'))); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('config', () => {
  it('returns an empty config when the file is missing', () => {
    expect(loadConfig(root)).toEqual({});
  });

  it('round-trips and merges updates', () => {
    saveConfig(root, { before: 'https://acme.com' });
    expect(loadConfig(root).before).toBe('https://acme.com');
    updateConfig(root, { routes: ['/pricing'] });
    expect(loadConfig(root)).toEqual({ before: 'https://acme.com', routes: ['/pricing'] });
    expect(fs.readFileSync(path.join(root, CONFIG_FILENAME), 'utf-8').endsWith('\n')).toBe(true);
  });

  it('fails loudly on invalid JSON', () => {
    fs.writeFileSync(path.join(root, CONFIG_FILENAME), '{ nope');
    expect(() => loadConfig(root)).toThrow(/not valid JSON/);
  });

  it('has sane defaults', () => {
    expect(CONFIG_DEFAULTS.viewports).toEqual(['desktop', 'mobile']);
    expect(CONFIG_DEFAULTS.scale).toBe(2);
    expect(CONFIG_DEFAULTS.fullPage).toBe(true);
    expect(CONFIG_DEFAULTS.assetsBranch).toBe('pre-post-assets');
  });
});

/**
 * minChangedPixels was device pixels and library callers passed it both in
 * .pre-post.json and as an override to runPr/runCompare. Dropping either would
 * silently reset a tuned value to the new default.
 */
describe('legacy minChangedPixels', () => {
  it('converts the config value at the capture scale', () => {
    expect(resolveSettings({ minChangedPixels: 400 }).minChangedArea).toBe(100);
    expect(resolveSettings({ minChangedPixels: 400, scale: 1 }).minChangedArea).toBe(400);
  });

  it('converts an override too, not just the config field', () => {
    expect(resolveSettings({}, { minChangedPixels: 800 } as never).minChangedArea).toBe(200);
  });

  it('lets the new key win over the legacy one at the same level', () => {
    expect(resolveSettings({ minChangedPixels: 400, minChangedArea: 55 }).minChangedArea).toBe(55);
    expect(resolveSettings({ minChangedPixels: 4000 }, { minChangedArea: 12 }).minChangedArea).toBe(12);
  });

  it('lets an override beat the config file', () => {
    expect(resolveSettings({ minChangedArea: 999 }, { minChangedPixels: 800 } as never).minChangedArea).toBe(200);
  });

  it('falls back to the default when neither is set', () => {
    expect(resolveSettings({}).minChangedArea).toBe(100);
  });
});
