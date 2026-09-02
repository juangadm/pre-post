import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig, saveConfig, updateConfig, CONFIG_FILENAME, CONFIG_DEFAULTS } from '../../src/config';

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
