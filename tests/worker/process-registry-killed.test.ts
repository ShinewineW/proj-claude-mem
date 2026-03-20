/**
 * Process Registry: proc.killed edge case test
 *
 * Verifies that ensureProcessExit properly waits for processes
 * that were signaled (proc.killed=true) but haven't exited yet
 * (exitCode=null). Before the fix, these processes were skipped.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { EventEmitter } from 'events';

// Inline minimal reimplementation to test logic without spawning real processes.
// The actual ensureProcessExit relies on ChildProcess events, so we simulate them.

describe('ensureProcessExit — proc.killed edge case', () => {
  it('should NOT skip cleanup when proc.killed=true but exitCode=null', async () => {
    // Simulate a process that was sent SIGTERM (killed=true) but hasn't exited (exitCode=null)
    const fakeProc = new EventEmitter() as any;
    fakeProc.killed = true;
    fakeProc.exitCode = null;
    fakeProc.kill = mock(() => {});

    // After the fix, the function should proceed to wait for exit, not return early.
    // We simulate the process exiting after a short delay.
    setTimeout(() => {
      fakeProc.exitCode = 0;
      fakeProc.emit('exit', 0, null);
    }, 50);

    // Import the actual function
    const { ensureProcessExit, registerProcess, unregisterProcess } = await import(
      '../../src/services/worker/ProcessRegistry.js'
    );

    // Register a fake process (required for unregisterProcess to work)
    // Use PIDs above OS range to avoid conflict with real processes
    const fakePid = 2147483001;
    registerProcess(fakePid, 1, fakeProc);

    const tracked = { pid: fakePid, sessionDbId: 1, spawnedAt: Date.now(), process: fakeProc };

    // Before fix: would return immediately due to proc.killed=true
    // After fix: waits for exit event, then unregisters
    await ensureProcessExit(tracked, 5000);

    // Process should have been cleaned up (unregistered)
    const { getActiveProcesses } = await import('../../src/services/worker/ProcessRegistry.js');
    const active = getActiveProcesses();
    const found = active.find((p: any) => p.pid === fakePid);
    expect(found).toBeUndefined();
  });

  it('should still exit immediately when exitCode is not null', async () => {
    const fakeProc = new EventEmitter() as any;
    fakeProc.killed = false;
    fakeProc.exitCode = 0;  // Already exited
    fakeProc.kill = mock(() => {});

    const { ensureProcessExit, registerProcess } = await import(
      '../../src/services/worker/ProcessRegistry.js'
    );

    const fakePid = 2147483002;
    registerProcess(fakePid, 2, fakeProc);

    const tracked = { pid: fakePid, sessionDbId: 2, spawnedAt: Date.now(), process: fakeProc };

    // Should return immediately (exitCode !== null)
    const start = Date.now();
    await ensureProcessExit(tracked, 5000);
    const elapsed = Date.now() - start;

    // Should be near-instant (well under 1s)
    expect(elapsed).toBeLessThan(1000);
  });
});
