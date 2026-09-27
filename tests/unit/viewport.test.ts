import { describe, it, expect } from 'vitest';
import { resolveViewport, viewportsFromFlags } from '../../src/viewport';
import { VIEWPORT_PRESETS } from '../../src/types';

describe('resolveViewport', () => {
  it('returns desktop preset by default when no config provided', () => {
    const result = resolveViewport();
    expect(result).toEqual(VIEWPORT_PRESETS.desktop);
  });

  it('returns desktop preset for "desktop" string', () => {
    const result = resolveViewport('desktop');
    expect(result).toEqual({ width: 1280, height: 800 });
  });

  it('returns tablet preset for "tablet" string', () => {
    const result = resolveViewport('tablet');
    expect(result).toEqual({ width: 768, height: 1024 });
  });

  it('returns mobile preset for "mobile" string', () => {
    const result = resolveViewport('mobile');
    expect(result).toEqual({ width: 375, height: 812 });
  });

  it('returns custom dimensions when given width and height', () => {
    const result = resolveViewport({ width: 1920, height: 1080 });
    expect(result).toEqual({ width: 1920, height: 1080 });
  });

  it('passes through exact dimensions without modification', () => {
    const custom = { width: 500, height: 300 };
    const result = resolveViewport(custom);
    expect(result).toEqual(custom);
  });

  it('returns desktop when undefined is passed explicitly', () => {
    const result = resolveViewport(undefined);
    expect(result).toEqual(VIEWPORT_PRESETS.desktop);
  });
});

describe('viewportsFromFlags', () => {
  it('is desktop only (undefined) with no flags', () => {
    expect(viewportsFromFlags({})).toBeUndefined();
  });

  it('--mobile adds mobile on top of desktop', () => {
    expect(viewportsFromFlags({ mobile: true })).toEqual(['desktop', 'mobile']);
  });

  it('-r / --responsive still adds mobile', () => {
    expect(viewportsFromFlags({ responsive: true })).toEqual(['desktop', 'mobile']);
  });

  it('--viewports wins over --mobile', () => {
    expect(viewportsFromFlags({ viewports: 'mobile', mobile: true })).toEqual(['mobile']);
  });
});
