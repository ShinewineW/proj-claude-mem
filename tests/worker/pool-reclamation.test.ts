/**
 * Tests for waitForSlot active pool reclamation.
 *
 * NOTE: ProcessRegistry is mock.module()'d by other test files (session-complete-status,
 * session-manager-isolation, session-manager-reaper). Since bun:test mock.module() is
 * process-level, we cannot import the real module here.
 *
 * Instead, we test the reclamation LOGIC directly — the callback contract and the
 * decision flow — without depending on the real processRegistry Map.
 */
import { describe, test, expect } from 'bun:test';

describe('waitForSlot active reclamation logic', () => {
  // Simulate the reclamation decision logic from waitForSlot
  function simulateReclamation(
    poolOccupants: Array<{ pid: number; sessionDbId: number; dbPath?: string }>,
    maxConcurrent: number,
    isProcessStale: (pid: number, sessionDbId: number, dbPath?: string) => boolean
  ): { reclaimed: number[]; poolSize: number } {
    const reclaimed: number[] = [];
    let poolSize = poolOccupants.length;

    if (poolSize < maxConcurrent) return { reclaimed, poolSize };

    for (const occupant of poolOccupants) {
      if (isProcessStale(occupant.pid, occupant.sessionDbId, occupant.dbPath)) {
        reclaimed.push(occupant.pid);
        poolSize--;
        if (poolSize < maxConcurrent) break;
      }
    }

    return { reclaimed, poolSize };
  }

  test('reclaims stale process when pool is full', () => {
    const occupants = [
      { pid: 1001, sessionDbId: 5, dbPath: '/proj-a/.claude/mem.db' }
    ];

    const result = simulateReclamation(occupants, 1, () => true);

    expect(result.reclaimed).toEqual([1001]);
    expect(result.poolSize).toBe(0);
  });

  test('passes dbPath to isProcessStale callback', () => {
    const testDbPath = '/tmp/project-a/.claude/mem.db';
    const occupants = [
      { pid: 2001, sessionDbId: 10, dbPath: testDbPath }
    ];

    let receivedDbPath: string | undefined;
    const isStale = (_pid: number, _sid: number, dbPath?: string) => {
      receivedDbPath = dbPath;
      return true;
    };

    simulateReclamation(occupants, 1, isStale);
    expect(receivedDbPath).toBe(testDbPath);
  });

  test('does not reclaim when isProcessStale returns false', () => {
    const occupants = [
      { pid: 3001, sessionDbId: 15, dbPath: '/proj-b/.claude/mem.db' }
    ];

    const result = simulateReclamation(occupants, 1, () => false);

    expect(result.reclaimed).toEqual([]);
    expect(result.poolSize).toBe(1);
  });

  test('stops reclaiming when enough slots are freed', () => {
    const occupants = [
      { pid: 4001, sessionDbId: 20, dbPath: '/proj-c/.claude/mem.db' },
      { pid: 4002, sessionDbId: 21, dbPath: '/proj-d/.claude/mem.db' },
      { pid: 4003, sessionDbId: 22, dbPath: '/proj-e/.claude/mem.db' }
    ];

    // Only need 1 slot (maxConcurrent=3, poolSize=3)
    const result = simulateReclamation(occupants, 3, () => true);

    expect(result.reclaimed).toEqual([4001]);
    expect(result.poolSize).toBe(2);
  });

  test('skips non-stale processes and reclaims only stale ones', () => {
    const occupants = [
      { pid: 5001, sessionDbId: 30 },  // healthy
      { pid: 5002, sessionDbId: 31 },  // stale
      { pid: 5003, sessionDbId: 32 },  // healthy
    ];

    const staleSessionIds = new Set([31]);
    const result = simulateReclamation(occupants, 2, (_pid, sid) => staleSessionIds.has(sid));

    expect(result.reclaimed).toEqual([5002]);
    expect(result.poolSize).toBe(2);
  });

  test('passes through immediately when pool has space', () => {
    const result = simulateReclamation([], 4, () => true);

    expect(result.reclaimed).toEqual([]);
    expect(result.poolSize).toBe(0);
  });
});
