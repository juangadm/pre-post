# Pre-Post TODO

## Dogfooding Issues (found 2026-02-11)

### Auth-protected deployments (Vercel)
- Vercel preview/production URLs return **401** when "Vercel Authentication" is enabled
- `pre-post compare --before-base <vercel-url>` silently captures a login page instead of the actual site
- **Fix ideas:**
  - [ ] Detect 401/403 on before-base URL and warn clearly before capturing
  - [ ] Support `--cookie` or `--header` flag to pass auth tokens
  - [ ] Support Vercel's `_vercel_jwt` cookie for bypassing deployment protection
  - [ ] Document workaround: disable Vercel Auth on production, or use a custom domain

### Route detection misses new files
- `npx pre-post detect` only found `next-env.d.ts` when the real changes were new component files (`iterative-hero.tsx`, `terminal.tsx`, etc.)
- New files (untracked → staged) don't map to routes in the current detection logic
- **Fix ideas:**
  - [ ] Also scan for new files that import into route-level components (e.g. page.tsx imports)
  - [ ] Follow import chains: if `page.tsx` imports `iterative-hero.tsx` and that file is new, flag `/` as changed
  - [ ] Fallback: if no routes detected, suggest capturing `/` by default

### Skill name mismatch
- Skill installed as `before-after` (symlink name) but user expects `/pre-post`
- Claude Code's Skill tool didn't recognize it
- [ ] Rename skill symlink to `pre-post` or register both aliases

## Site / Hero

- [ ] Mobile layout check — stacked or scaled workspace view
- [ ] Consider reduced-motion: skip animations, show static workspace + PR side by side

---

## Video/GIF Support — Spec

### 1. Feature Summary

`--video` flag on the `pre-post` CLI captures animated GIFs of web pages.
GIFs show page-load animations, CSS transitions, and layout changes.
They render inline in GitHub PR comments alongside static screenshots.

`--video` is opt-in. Static PNG screenshots remain the default behavior.

### 2. Encoding Pipeline

Sequential Playwright JPEG screenshots encoded into animated GIF via gifenc.
Single codepath. No FFmpeg. No external dependencies beyond Playwright + gifenc
(both already in `package.json`).

**Step-by-step:**

```
1. getBrowser()           → get/create shared Playwright Browser instance
2. browser.newPage()      → new page with viewport at DPR 1 (no animation-killing CSS)
3. page.goto(url)         → waitUntil: 'networkidle'
4. page.evaluate()        → document.fonts.ready
5. page.waitForTimeout()  → --delay ms (default 0)
6. [optional] locator.scrollIntoViewIfNeeded() → if --selector provided
7. LOOP (totalFrames = duration × fps):
   a. page.screenshot({ type: 'jpeg', quality: 80 })  → JPEG Buffer
   b. page.waitForTimeout(frameInterval)               → pace capture
8. page.close()
9. For each JPEG Buffer:
   a. Decode to RGBA via hidden canvas page (base64 data URL → drawImage → getImageData)
   b. quantize(rgba, 256, { format: 'rgba4444' })      → 256-color palette
   c. applyPalette(rgba, palette, 'rgba4444')           → indexed pixel array
   d. encoder.writeFrame(indexed, width, height, { palette, delay, repeat: 0 })
10. encoder.finish()
11. Buffer.from(encoder.bytes())                        → GIF Buffer
12. Size check: if > 10 MB → error
13. uploadGitNative() → commit to .pre-post/, push, return blob+SHA URL
```

**JPEG decode detail (step 9a):**
Reuse the shared Browser to open a utility page with `<canvas id="c">`.
Pass each JPEG as `data:image/jpeg;base64,...` into `page.evaluate()`,
draw onto canvas at target dimensions, call `getImageData()`, return
pixel array. This avoids adding `sharp` or `pngjs` as dependencies.
The utility page is created once and reused across all frames.
Closed in a `finally` block after encoding completes.

**gifenc import detail:**
gifenc ships as CJS. Use `createRequire(import.meta.url)` for ESM compat:
```typescript
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { GIFEncoder, quantize, applyPalette } = require('gifenc');
```

### 3. Capture Settings

| Setting | Default | Max | Rationale |
|---------|---------|-----|-----------|
| FPS | 5 | 10 | Each JPEG screenshot at 1280x800 DPR 1 takes ~100-200ms. 5 FPS is reliably achievable. |
| Duration | 3s | 10s | 3s covers page load + initial CSS transitions. 10s cap → 50 frames max. |
| DPR | 1 | 1 | Fixed at 1. DPR 2 quadruples pixel count; 256-color GIF cannot reproduce the detail. |
| Viewport | Inherited | — | Uses existing viewport flags (--mobile, --tablet, --size, default desktop). |

**Frame interval calculation:**
```typescript
const frameInterval = Math.round(1000 / fps);  // 200ms at 5 FPS
const totalFrames = Math.ceil(duration * fps);  // 15 at 3s × 5fps
```
The actual FPS will be slightly lower than target because `page.screenshot()` takes
~100-200ms on top of the interval. At 5 FPS target, real-world is ~3-4 FPS.
Animations continue playing during screenshots — frames are temporally correct.

### 4. Viewport Dimensions for GIF

GIFs capture at the full viewport size. No downscaling.

| Viewport preset | GIF dimensions | Est. file size (15 frames) | Est. file size (50 frames) |
|----------------|---------------|---------------------------|---------------------------|
| `desktop` | 1280×800 | 1.5–3.5 MB | 4–8 MB |
| `mobile` | 375×667 | 0.2–0.7 MB | 0.5–2 MB |
| `tablet` | 768×1024 | 0.8–2 MB | 2–5 MB |

**Mobile height is 667px, not 812px.** The existing `mobile` preset uses 812px
(full iPhone viewport). For GIF mode, the height is capped at 667px (above-the-fold)
to avoid a comically tall image in PR comments. This is done in `captureVideo()` by
overriding the viewport height when the mobile preset is detected.

### 5. Size Limit

**10 MB hard limit.** Enforced in `uploadGitNative()` before writing the file.
Error message: `"GIF is ${size} MB (limit: 10 MB). Reduce --duration or --fps."`

No automatic downscaling. The user controls output size via `--duration` and `--fps`.

### 6. Upload

Uses the existing `uploadGitNative()` flow — identical to PNG screenshots:
1. Write GIF to `.pre-post/` directory in repo root
2. `git add -f` the file
3. `git commit -m "chore: add pre/post screenshots"`
4. `git push origin HEAD`
5. Construct blob URL: `https://github.com/{owner}/{repo}/blob/{sha}/.pre-post/{filename}?raw=true`

GIF content type is handled automatically — GitHub serves `?raw=true` blob URLs
with the correct MIME type based on file extension.

### 7. CLI Interface

New `parseArgs` options in `src/bin/cli.ts`:

```typescript
video: { type: 'boolean' },
duration: { type: 'string' },
fps: { type: 'string' },
delay: { type: 'string' },
```

Help text addition:
```
VIDEO OPTIONS:
      --video                Capture animated GIF instead of static screenshot
      --duration <seconds>   Recording duration (default: 3, max: 10)
      --fps <n>              Target frames per second (default: 5, max: 10)
      --delay <ms>           Wait after page load before recording (default: 0)
```

**Flag validation:**
- `--video` + `--full` → hard error: `"--full (fullPage) is not supported with --video"`
- `--duration` > 10 → hard error: `"Max duration is 10 seconds"`
- `--fps` > 10 → hard error: `"Max FPS is 10"`
- `--duration` or `--fps` or `--delay` without `--video` → ignored (no error)

**Integration points:**

`runDefault()` — When `--video` is set:
- Replace `captureBeforeAfter()` calls with `captureVideo()` for both before and after URLs
- Generate `.gif` filenames instead of `.png`
- Upload GIFs via same `uploadAndOutputMarkdown()` path

`runCompare()` — When `--video` is set:
- Replace `captureScreenshot()` calls with `captureVideo()` for each route
- Works with `--responsive` (desktop GIF + mobile GIF per route)

`runFull()` — Passes `--video` through to `runCompare()`.

**CLI examples:**
```bash
pre-post https://old.com https://new.com --video
pre-post https://old.com https://new.com --video --duration 5 --delay 500
pre-post compare --before-base prod.com --after-base localhost:3000 --video
pre-post compare --before-base prod.com --after-base localhost:3000 --video --responsive
pre-post compare --before-base prod.com --after-base localhost:3000 --video --mobile --duration 5
pre-post run --before-base prod.com --after-base localhost:3000 --video
```

### 8. File Changes

**`src/browser.ts`** — Add exported function:
```typescript
export async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await launchBrowser();
  }
  return browser;
}
```
This gives `video.ts` access to the Browser instance without going through
`getPage()` which injects animation-killing CSS.

**`src/types.ts`** — Add types at the end of the file:
```typescript
export interface VideoOptions {
  viewport: ViewportSize;
  duration?: number;    // seconds, default 3, max 10
  fps?: number;         // default 5, max 10
  delay?: number;       // ms after load, default 0
  selector?: string;
  fullPage?: boolean;   // always false for video — validated in CLI
}

export interface VideoResult {
  gif: Buffer;
  format: 'gif';
  viewport: ViewportSize;
  url: string;
  duration: number;
  frameCount: number;
  selector?: string;
}
```

**`src/filename.ts`** — Change line 96:
```typescript
// Before:
return `${pageName}${elementPart}${suffixPart}-${timestamp}.png`;

// After:
const ext = options.format === 'gif' ? 'gif' : 'png';
return `${pageName}${elementPart}${suffixPart}-${timestamp}.${ext}`;
```
Add `format?: 'png' | 'gif'` to `FilenameOptions` interface.

**`src/video.ts`** — Rewrite the existing draft. Two exported functions:

`captureGif(page: Page, url: string, options: VideoOptions): Promise<VideoResult>`
- Takes an existing Playwright Page (caller manages lifecycle)
- Navigates, waits, captures frames, encodes GIF
- Returns VideoResult with GIF Buffer

`captureVideo(url: string, options: VideoOptions): Promise<VideoResult>`
- High-level entry point
- Calls `getBrowser()`, creates a new page at DPR 1, calls `captureGif()`
- Wraps everything in try/finally to close page + decoder page on error/success
- Includes early-stop logic: if 3 consecutive frames are identical (byte-level
  Buffer.equals comparison on JPEG data), stop capture and log
  `"Animation settled after ${i} frames"`

**`src/upload.ts`** — Add size guard at top of `uploadGitNative()`:
```typescript
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
if (image.length > MAX_FILE_SIZE) {
  const sizeMB = (image.length / 1024 / 1024).toFixed(1);
  throw new Error(
    `File is ${sizeMB} MB (limit: 10 MB). Reduce --duration or --fps.`
  );
}
```

**`src/bin/cli.ts`** — Add flags, validation, and wiring as described in section 7.

**`src/index.ts`** — Add exports:
```typescript
export { captureVideo } from './video.js';
export type { VideoOptions, VideoResult } from './types.js';
```

### 9. Edge Cases

| Scenario | Detection | Response |
|----------|-----------|----------|
| `--video` + `--full` | CLI flag check | Hard error before any browser work |
| Selector not found | `locator.count() === 0` | Hard error before recording |
| Page returns 4xx/5xx | Check `page.goto()` response status | Log warning, continue (page may still have content) |
| Infinite animation | 3+ identical JPEG frames | Stop early, log "animation settled after N frames" |
| GIF > 10 MB | Check `Buffer.length` after encoding | Hard error with actionable message |
| Memory pressure | 50 frames × 1280×800×4 = ~200 MB | Acceptable. Max frames capped at 50. |
| Decoder page leak | Page not closed on error | `try/finally` in `captureVideo()` closes page + decoder |
| Browser launch failure | Same as screenshot mode | Same error handling — fallback chain in `launchBrowser()` |

### 10. Implementation Order

```
1. src/browser.ts      → getBrowser() export (3 lines)
2. src/types.ts         → VideoOptions, VideoResult types
3. src/filename.ts      → format parameter on FilenameOptions + generateFilename()
4. src/video.ts         → full rewrite: captureGif(), captureVideo(), JPEG→RGBA decode
5. src/upload.ts        → 10 MB size guard in uploadGitNative()
6. src/bin/cli.ts       → --video, --duration, --fps, --delay flags + wiring
7. src/index.ts         → exports
8. Build                → tsc -p tsconfig.pkg.json (verify no type errors)
9. Test                 → capture real GIF against a live URL, check file size, check GitHub render
10. Commit + push
```
