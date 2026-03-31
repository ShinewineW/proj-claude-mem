/**
 * Process Registry: proc.killed edge case test
 *
 * Verifies the proc.killed fix logic: processes that were signaled
 * (proc.killed=true) but haven't exited yet (exitCode=null) must be
 * waited on, not skipped.
 *
 * NOTE: Cannot import from ProcessRegistry.js because bypass-lane.test.ts
 * uses mock.module() which is process-level and irreversible in bun.
 * Instead, we inline the core wait-for-exit logic from ensureProcessExit.
 */

import { describe, it, expect, mock } from 'bun:test';
import { EventEmitter } from 'events';

/**
 * Inlined from ProcessRegistry.ts:ensureProcessExit — the core logic
 * we're testing. The original also calls unregisterProcess/logger, but
 * the behavioral contract is: wait for exit event or timeout.
 */
async function ensureProcessExitInlined(proc: any, timeoutMs: number): Promise<void> {
  // Already exited?
  if (proc.exitCode !== null) return;

  // Wait for graceful exit with timeout
  const exitPromise = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
  await Promise.race([exitPromise, timeoutPromise]);
}

describe('ensureProcessExit — proc.killed edge case', () => {
  it('should NOT skip cleanup when proc.killed=true but exitCode=null', async () => {
    // Simulate a process that was sent SIGTERM (killed=true) but hasn't exited (exitCode=null)
    const fakeProc = new EventEmitter() as any;
    fakeProc.killed = true;
    fakeProc.exitCode = null;
    fakeProc.kill = mock(() => {});

    // Simulate exit after 50ms
    setTimeout(() => {
      fakeProc.exitCode = 0;
      fakeProc.emit('exit', 0, null);
    }, 50);

    // Before fix: ensureProcessExit checked `if (proc.killed) return` → skipped wait
    // After fix: proc.killed is NOT checked → waits for exit event
    const start = Date.now();
    await ensureProcessExitInlined(fakeProc, 5000);
    const elapsed = Date.now() - start;

    // Should have waited ~50ms for exit, not returned instantly
    expect(elapsed).toBeGreaterThanOrEqual(30);
    expect(fakeProc.exitCode).toBe(0);
  });

  it('should still exit immediately when exitCode is not null', async () => {
    const fakeProc = new EventEmitter() as any;
    fakeProc.killed = false;
    fakeProc.exitCode = 0;  // Already exited
    fakeProc.kill = mock(() => {});

    const start = Date.now();
    await ensureProcessExitInlined(fakeProc, 5000);
    const elapsed = Date.now() - start;

    // Should be near-instant
    expect(elapsed).toBeLessThan(1000);
  });
});
