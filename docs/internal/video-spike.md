# Video spike (2026-09-27, playwright-core 1.58.0, Chrome 153, M-series Mac)

Throwaway script, not committed. It recorded a dropdown opening on two pages at once (Pre instant,
Post with a 250ms transition), resampled to 30 fps, composited Pre | Post on a canvas and encoded
with Playwright's bundled ffmpeg (revision 1011).

| Question | Result |
|---|---|
| Screencast cadence | Frames arrive only when pixels change: ~17 ms apart during the transition (~60 fps), none while idle. Pre (no transition) sent 3 frames, Post 19. |
| Public Playwright API? | No `page.screencast` in 1.58 client; use CDP `Page.startScreencast` (Chromium only, which is all we run). |
| Composite speed | 64 ticks in 620 ms (~10 ms/tick, 1624x556). A 10 s clip is ~3 s of compositing. |
| Encode | 280 ms after the last frame. 2.1 s clip = 72–83 KB (~35 KB/s). `-crf 10` dominates; `-b:v` 1M vs 3M barely matters. |
| Legibility | 16px body text scaled to an 800px pane is readable in a decoded VP8 frame at 1M. |
| Bundled ffmpeg | Has libvpx (VP8) encode, mjpeg decode, image2pipe, pad/crop/scale, webm mux. No `hstack`, no `-` alias: stdin must be `pipe:0`, as Playwright's own videoRecorder does. |
| `gh --attach` | Not tested: local gh is 2.83.1 (needs 2.99+). Built from upstream's documented flow; verify on upgrade. |

Decisions: CDP screencast (not `recordVideo`, which is fixed 25 fps and records from context
creation), clip length = recording window (not first-to-last changed frame, which would drop the
idle lead-in), canvas composite (fast enough, and the only way to get labels without drawtext).
Reuse the composited JPEG when neither pane changed between ticks, so idle stretches are free.
