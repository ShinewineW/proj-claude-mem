/**
 * C1 Verification: Orphan Reaper Key Type Mismatch
 *
 * Proves the bug in worker-service.ts:520-525 where the orphan reaper
 * callback iterates SessionManager's `sessions` Map (string keys like
 * "dbPath::123") and adds them to Set<number>. Since Set.has() uses
 * strict equality (===), numeric sessionDbId will never match string keys,
 * causing ALL active sessions to be treated as dead → processes killed.
 *
 * Mock Justification (~0%):
 * - No mocks needed. Tests pure data structure behavior.
 */

import { describe, test, expect } from 'bun:test';

describe('C1: Orphan Reaper Key Type Mismatch', () => {
  /**
   * Reproduce the EXACT callback logic from worker-service.ts:520-525:
   *
   *   this.stopOrphanReaper = startOrphanReaper(() => {
   *     const activeIds = new Set<number>();
   *     for (const [id] of this.sessionManager['sessions']) {
   *       activeIds.add(id);
   *     }
   *     return activeIds;
   *   });
   *
   * Then check how reapOrphanedProcesses uses activeIds:
   *   if (activeSessionIds.has(info.sessionDbId)) continue; // Active = safe
   *
   * info.sessionDbId is a number. If activeIds contains strings, has() fails.
   */
  test('current callback adds string keys to Set<number>, has() never matches numeric sessionDbId', () => {
    // Simulate SessionManager.sessions Map (keys are strings from sessionKey())
    const sessions = new Map<string, { sessionDbId: number; dbPath: string }>();
    sessions.set('/project/.claude/mem.db::5', { sessionDbId: 5, dbPath: '/project/.claude/mem.db' });
    sessions.set('/other/.claude/mem.db::10', { sessionDbId: 10, dbPath: '/other/.claude/mem.db' });

    // Current buggy callback (reproduces worker-service.ts:520-525)
    const activeIds = new Set<number>();
    for (const [id] of sessions) {
      activeIds.add(id as unknown as number); // TypeScript doesn't catch this at runtime
    }

    // The Set now contains strings, not numbers
    expect(typeof [...activeIds][0]).toBe('string'); // Proof: values are strings

    // ProcessRegistry checks: activeSessionIds.has(info.sessionDbId)
    // info.sessionDbId is a number (e.g. 5)
    expect(activeIds.has(5)).toBe(false);  // BUG: should be true, but string !== number
    expect(activeIds.has(10)).toBe(false); // BUG: should be true

    // This means ALL sessions are considered "dead" by the reaper
  });

  test('fixed callback using .values() correctly populates Set with numeric sessionDbIds', () => {
    const sessions = new Map<string, { sessionDbId: number; dbPath: string }>();
    sessions.set('/project/.claude/mem.db::5', { sessionDbId: 5, dbPath: '/project/.claude/mem.db' });
    sessions.set('/other/.claude/mem.db::10', { sessionDbId: 10, dbPath: '/other/.claude/mem.db' });

    // Fixed callback: iterate values, extract sessionDbId
    const activeIds = new Set<number>();
    for (const session of sessions.values()) {
      activeIds.add(session.sessionDbId);
    }

    // Now the Set correctly contains numbers
    expect(typeof [...activeIds][0]).toBe('number');
    expect(activeIds.has(5)).toBe(true);
    expect(activeIds.has(10)).toBe(true);
  });
});
