/**
 * Public API. Everything else under src/ is internal and may change.
 */
export * from './types.js';
export type { Settings } from './config.js';
export { loadConfig, resolveSettings, CONFIG_DEFAULTS } from './config.js';
export { NeedsHumanError, HttpStatusError, NavigationError, BrowserNotFoundError, GitHubError } from './errors.js';
export { captureScreenshot, captureBeforeAfter } from './capture.js';
export { closeBrowser } from './browser.js';
export { diffImages } from './diff.js';
export type { DiffOptions } from './diff.js';
export { parseViewport, resolveViewport } from './viewport.js';
export { generateFilename } from './filename.js';
export { detectRoutes, detectRoutesForRepo, detectFramework, getChangedFiles } from './routes.js';
export type { RepoRouteDetection, RepoDetectionOptions } from './routes.js';
export { buildComment, buildSummary, STICKY_MARKER } from './report.js';
export { runPr } from './commands/pr.js';
export type { PrCommandOptions } from './commands/pr.js';
export { runCompare } from './commands/compare.js';
export type { CompareOptions } from './commands/compare.js';
export { runLogin } from './commands/login.js';
export { runPrune } from './commands/prune.js';
export { runDoctor } from './commands/doctor.js';
export { runDetect } from './commands/detect.js';
