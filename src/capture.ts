import {
  CaptureOptions,
  CaptureResult,
  BeforeAfterCaptureOptions,
  BeforeAfterCaptureResult,
  ViewportConfig,
} from './types.js';
import { resolveViewport } from './viewport.js';
import { captureScreenshot as browserCapture } from './browser.js';

function normalizeOptions(input: CaptureOptions | string): CaptureOptions {
  if (typeof input === 'string') {
    return { url: input };
  }
  return input;
}

export async function captureScreenshot(options: CaptureOptions): Promise<CaptureResult> {
  const viewport = resolveViewport(options.viewport);

  const image = await browserCapture(options.url, {
    viewport,
    fullPage: options.fullPage ?? false,
    selector: options.selector,
  });

  return {
    image,
    viewport,
    url: options.url,
    selector: options.selector,
  };
}

export async function captureBeforeAfter(
  options: BeforeAfterCaptureOptions,
): Promise<BeforeAfterCaptureResult> {
  const sharedViewport = options.viewport;

  const beforeOpts = normalizeOptions(options.before);
  const afterOpts = normalizeOptions(options.after);

  // Apply shared options if not overridden individually
  if (sharedViewport && !beforeOpts.viewport) {
    beforeOpts.viewport = sharedViewport;
  }
  if (sharedViewport && !afterOpts.viewport) {
    afterOpts.viewport = sharedViewport;
  }

  // Capture in parallel — each gets its own page from the pool
  const [before, after] = await Promise.all([
    captureScreenshot(beforeOpts),
    captureScreenshot(afterOpts),
  ]);

  return { before, after };
}

/**
 * Capture a URL at multiple viewports (desktop + mobile by default).
 * Returns a map of viewport label → CaptureResult.
 */
export async function captureResponsive(
  url: string,
  viewports: ViewportConfig[] = ['desktop', 'mobile'],
): Promise<Map<string, CaptureResult>> {
  const entries = await Promise.all(
    viewports.map(async (vp) => {
      const label = typeof vp === 'string' ? vp : `${vp.width}x${vp.height}`;
      const result = await captureScreenshot({ url, viewport: vp });
      return [label, result] as const;
    }),
  );
  return new Map(entries);
}
