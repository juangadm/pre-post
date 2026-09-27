import { describe, it, expect, vi, afterEach } from 'vitest';

// A browser whose shutdown never finishes, the way a full Chrome sometimes
// behaves. The run must not wait on it.
const close = vi.fn(() => new Promise<void>(() => undefined));
vi.mock('playwright-core', () => ({
  chromium: { launch: vi.fn(async () => ({ close, on: vi.fn(), version: () => 'fake' })) },
}));

const { BROWSER_CLOSE_TIMEOUT_MS, closeBrowser, getBrowser } = await import('../../src/browser');

describe('closeBrowser', () => {
  afterEach(() => vi.useRealTimers());

  it('stops waiting on a browser that will not exit', async () => {
    await getBrowser();
    vi.useFakeTimers();
    let done = false;
    const closing = closeBrowser().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(BROWSER_CLOSE_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(done).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when nothing was launched', async () => {
    await expect(closeBrowser()).resolves.toBeUndefined();
  });
});
