import { ViewportConfig, ViewportSize, ViewportPreset, VIEWPORT_PRESETS } from './types.js';

/** Accepts a preset name, a "WxH" string, or a size object. */
export function parseViewport(spec: ViewportConfig | string): { label: string; size: ViewportSize } {
  if (typeof spec !== 'string') return { label: `${spec.width}x${spec.height}`, size: spec };
  const preset = VIEWPORT_PRESETS[spec as ViewportPreset];
  if (preset) return { label: spec, size: preset };
  const m = spec.match(/^(\d+)x(\d+)$/);
  if (!m) throw new Error(`Invalid viewport "${spec}". Use desktop, tablet, mobile, or WxH (e.g. 1440x900).`);
  return { label: spec, size: { width: Number(m[1]), height: Number(m[2]) } };
}

export function resolveViewport(config?: ViewportConfig | string): ViewportSize {
  return config ? parseViewport(config).size : VIEWPORT_PRESETS.desktop;
}
