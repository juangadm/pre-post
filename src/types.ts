// ============================================================
// Viewport
// ============================================================

export interface ViewportSize {
  width: number;
  height: number;
}

export type ViewportPreset = 'desktop' | 'tablet' | 'mobile';

export type ViewportConfig = ViewportPreset | ViewportSize;

export const VIEWPORT_PRESETS: Record<ViewportPreset, ViewportSize> = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 375, height: 812 },
};

// ============================================================
// Capture
// ============================================================

export interface AuthOptions {
  /** Extra request headers sent with every request (e.g. Vercel bypass). */
  headers?: Record<string, string>;
  /** Cookies to set before navigation. */
  cookies?: Array<{ name: string; value: string; domain?: string; path?: string; url?: string }>;
}

export interface CaptureOptions {
  /** URL to capture (file://, http://, https://) */
  url: string;
  /** Optional CSS selector - scrolls element into view before capture */
  selector?: string;
  /** Viewport size or preset name */
  viewport?: ViewportConfig;
  /** Capture full scrollable page instead of viewport. Default: false */
  fullPage?: boolean;
  /** Maximum page height (CSS px) for full-page captures. Default: 3× viewport height */
  maxHeight?: number;
  /** Device scale factor. Default: 2 */
  scale?: number;
  /** Hard cap on settle wait (ms). Default: 8000 */
  settleTimeout?: number;
  /** Extra fixed wait after settle (ms). Default: 0 */
  wait?: number;
  /** Auth headers / cookies */
  auth?: AuthOptions;
}

export interface CaptureResult {
  /** Raw PNG image data */
  image: Buffer;
  /** Viewport used for capture */
  viewport: ViewportSize;
  /** URL that was captured */
  url: string;
  /** CSS selector used, if any */
  selector?: string;
  /** HTTP status of the main document */
  status?: number;
  /** Wall-clock milliseconds for navigation + settle + screenshot */
  durationMs: number;
}

export interface BeforeAfterCaptureOptions {
  before: CaptureOptions | string;
  after: CaptureOptions | string;
  /** Viewport applied to both captures unless overridden individually */
  viewport?: ViewportConfig;
}

export interface BeforeAfterCaptureResult {
  before: CaptureResult;
  after: CaptureResult;
}

// ============================================================
// Diff
// ============================================================

export interface DiffRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DiffResult {
  /** Fraction of pixels that differ, 0..1 (over the union canvas) */
  changedRatio: number;
  /** Number of differing pixels */
  changedPixels: number;
  /** Canvas size used for comparison (device pixels) */
  width: number;
  height: number;
  /** Bounding box of all changes in device pixels, or null when identical */
  region: DiffRegion | null;
  /** Whether the two images had different dimensions */
  sizeChanged: boolean;
  /** Highlight image: grayscale page with changed pixels in red (PNG). Absent when identical. */
  highlight?: Buffer;
  /** Crops of before/after around the changed region, when the change is localized */
  crop?: { before: Buffer; after: Buffer; region: DiffRegion };
  /** Vertical displacement explaining most of the difference, when one does */
  shift?: ShiftSummary;
}

/**
 * A layout shift: Post content moved down (or up) by a constant amount from a
 * given row, and what remains different once the two sides are put back in
 * register. Plain numbers, so it survives the worker-thread boundary.
 */
export interface ShiftSummary {
  /** Device pixels Post content moved down by; negative means up. */
  dy: number;
  /** First row, in Pre coordinates, that moved. Rows above it stayed put. */
  from: number;
  /** Changed pixels once Post is aligned with Pre. */
  alignedChangedPixels: number;
  /** Aligned changed pixels as a fraction of the canvas. */
  alignedChangedRatio: number;
}

// ============================================================
// Route Detection
// ============================================================

export type Framework = 'nextjs-app' | 'nextjs-pages' | 'vite' | 'generic';

export interface DetectedRoute {
  /** Route path, e.g., "/dashboard" */
  path: string;
  /** Source file that triggered detection, e.g., "app/dashboard/page.tsx" */
  sourceFile: string;
  /** How confident is the detection */
  confidence: 'high' | 'medium' | 'low';
  /** Human-readable reason for detection */
  reason: string;
}

export interface RouteDetectionOptions {
  /** Force a specific framework instead of auto-detecting */
  framework?: Framework;
  /** Maximum number of routes to return (default: 6) */
  maxRoutes?: number;
  /** Where warnings go. Left unset, they are silent. */
  log?: (msg: string) => void;
}

// ============================================================
// Config (.pre-post.json)
// ============================================================

export interface PrePostConfig {
  /** Production base URL — the "before" state */
  before?: string;
  /** Local base URL — the "after" state (auto-detected when omitted) */
  after?: string;
  /** Routes to always include */
  routes?: string[];
  /** Sample URLs for dynamic routes, e.g. { "/blog/[slug]": "/blog/hello" } */
  samples?: Record<string, string>;
  /** Viewports to capture. Default: ["desktop"] */
  viewports?: Array<ViewportPreset | string>;
  /** Extra headers for every request */
  headers?: Record<string, string>;
  /** Change ratio (fraction 0..1) at or above which a route counts as changed. Default 0.001 */
  threshold?: number;
  /** Absolute changed-pixel floor at or above which a route counts as changed, so small edits on tall pages register. Default 40 */
  /** Smallest painted change that counts, in CSS pixels². */
  minChangedArea?: number;
  /** @deprecated device pixels; use minChangedArea. Converted at the capture scale. */
  minChangedPixels?: number;
  /** Max detected routes. Default 6 */
  maxRoutes?: number;
  /** Capture full page. Default true */
  fullPage?: boolean;
  /** Max full-page height in CSS px. Default 2400 */
  maxHeight?: number;
  /** Device scale factor. Default 2 */
  scale?: number;
  /** Assets branch name. Default "pre-post-assets" */
  assetsBranch?: string;
  /** Skip paths (glob-ish prefixes) from route detection */
  ignore?: string[];
}

// ============================================================
// PR run result
// ============================================================

/** Pre, post, and (when there was a change) diff and crop images, as local paths or URLs. */
export interface ArtifactSet {
  before: string;
  after: string;
  diff?: string;
  cropBefore?: string;
  cropAfter?: string;
}

export const ARTIFACT_KINDS = ['before', 'after', 'diff', 'cropBefore', 'cropAfter'] as const;

export interface RouteCaptureOutcome {
  route: string;
  /** Route actually requested (after sample substitution) */
  resolvedRoute: string;
  viewport: string;
  status: 'changed' | 'unchanged' | 'error';
  changedRatio?: number;
  sizeChanged?: boolean;
  error?: string;
  files?: ArtifactSet;
  urls?: ArtifactSet;
  durationMs?: number;
  /** Extra context, e.g. "new page (404 on production)" */
  note?: string;
  /** Vertical displacement of Post against Pre, when one explains the change */
  shift?: RouteShift;
}

export interface RouteShift {
  /** CSS pixels the content moved down by; negative means up. */
  px: number;
  /** Whether anything changed beyond the move, judged by the same rule as any other capture. */
  otherChange: boolean;
}

export interface PrRunResult {
  repo: string;
  prNumber?: number;
  commentUrl?: string;
  beforeBase: string;
  afterBase: string;
  outcomes: RouteCaptureOutcome[];
  skippedDynamic: string[];
  durationMs: number;
  markdown: string;
  /** Local directory holding every captured file */
  outputDir: string;
}
