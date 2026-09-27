import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { stopGroup } from '../../src/baseline';

/** Spawned the way the baseline spawns a dev server: detached, its own group. */
function detached(script: string) {
  const child = spawn('sh', ['-c', script], { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

const groupAlive = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether the group is gone within `ms`. Killed members answer signal 0 until
 * they are reaped — on Linux that is a moment after the kill, not before it —
 * so one immediate check races the reaper. That lag is also why stopGroup
 * itself does not use signal 0 to decide.
 */
async function goneWithin(pid: number, ms = 2_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (groupAlive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise(r => setTimeout(r, 20));
  }
  return true;
}

describe('stopGroup', () => {
  it('returns once the whole group has exited on SIGTERM', async () => {
    const child = detached('sleep 30');
    await new Promise(r => setTimeout(r, 100));
    const started = Date.now();
    await stopGroup(child);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await goneWithin(child.pid!)).toBe(true);
  });

  // The package manager is the child; the server it starts can outlive it.
  // Once the child is gone, whatever is left of the group is killed.
  it('leaves nothing of the group running once the child has exited', async () => {
    const child = detached('sh -c "trap \'\' TERM; sleep 30" & sleep 30');
    await new Promise(r => setTimeout(r, 150));
    const started = Date.now();
    await stopGroup(child);
    // The child exits on SIGTERM, so this never waits out the timeout.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await goneWithin(child.pid!)).toBe(true);
  });

  it('kills a group that ignores SIGTERM once the timeout passes', async () => {
    const child = detached('trap "" TERM; while true; do sleep 0.05; done');
    await new Promise(r => setTimeout(r, 100));
    const started = Date.now();
    await stopGroup(child, 300);
    // It waited out the timeout rather than returning at once; timers can
    // fire a millisecond before Date.now() says they should, so allow a margin.
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(await goneWithin(child.pid!)).toBe(true);
  });

  it('is a no-op for a process that is already gone', async () => {
    const child = detached('exit 0');
    await new Promise(r => setTimeout(r, 200));
    await expect(stopGroup(child)).resolves.toBeUndefined();
  });
});
