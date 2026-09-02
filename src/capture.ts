import {
  CaptureOptions,
  CaptureResult,
  BeforeAfterCaptureOptions,
  BeforeAfterCaptureResult,
} from './types.js';
import { resolveViewport } from './viewport.js';
import { captureScreenshot as browserCapture } from './browser.js';

function normalizeOptions(input: CaptureOptions | string): CaptureOptions {
  return typeof input === 'string' ? { url: input } : input;
}

export async function captureScreenshot(options: CaptureOptions): Promise<CaptureResult> {
  const viewport = resolveViewport(options.viewport);
  return browserCapture(options.url, {
    viewport,
    fullPage: options.fullPage ?? false,
    maxHeight: options.maxHeight,
    scale: options.scale,
    selector: options.selector,
    settleTimeout: options.settleTimeout,
    wait: options.wait,
    auth: options.auth,
  });
}

export async function captureBeforeAfter(options: BeforeAfterCaptureOptions): Promise<BeforeAfterCaptureResult> {
  const beforeOpts = normalizeOptions(options.before);
  const afterOpts = normalizeOptions(options.after);
  if (options.viewport && !beforeOpts.viewport) beforeOpts.viewport = options.viewport;
  if (options.viewport && !afterOpts.viewport) afterOpts.viewport = options.viewport;
  const [before, after] = await Promise.all([captureScreenshot(beforeOpts), captureScreenshot(afterOpts)]);
  return { before, after };
}
