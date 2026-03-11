import { describe, it, expect } from 'bun:test';

/**
 * Tests for the drain window polling loop logic used in deleteSession().
 *
 * These tests verify the polling algorithm independently of SessionManager's
 * complex dependency graph (DatabaseManager, ProcessRegistry, EventEmitter, etc.).
 * The same loop logic is inlined in deleteSession().
 */

describe('drain window polling logic', () => {
  it('skips wait when hasPendingSummarize returns false', async () => {
    const hasPending = () => false;
    const DRAIN_MAX_WAIT_MS = 10_000;
    const DRAIN_POLL_INTERVAL_MS = 500;

    const start = Date.now();
    let waited = 0;

    if (hasPending()) {
      while (hasPending() && waited < DRAIN_MAX_WAIT_MS) {
        await new Promise(r => setTimeout(r, DRAIN_POLL_INTERVAL_MS));
        waited += DRAIN_POLL_INTERVAL_MS;
      }
    }

    expect(Date.now() - start).toBeLessThan(100);
    expect(waited).toBe(0);
  });

  it('waits until hasPendingSummarize becomes false', async () => {
    let pending = true;
    setTimeout(() => { pending = false; }, 300);
    const hasPending = () => pending;

    const DRAIN_MAX_WAIT_MS = 5_000;
    const DRAIN_POLL_INTERVAL_MS = 100;

    let waited = 0;
    while (hasPending() && waited < DRAIN_MAX_WAIT_MS) {
      await new Promise(r => setTimeout(r, DRAIN_POLL_INTERVAL_MS));
      waited += DRAIN_POLL_INTERVAL_MS;
    }

    expect(waited).toBeGreaterThanOrEqual(300);
    expect(waited).toBeLessThan(DRAIN_MAX_WAIT_MS);
    expect(hasPending()).toBe(false);
  });

  it('times out and proceeds when summarize never drains', async () => {
    const hasPending = () => true;

    const DRAIN_MAX_WAIT_MS = 1_000;
    const DRAIN_POLL_INTERVAL_MS = 200;

    let waited = 0;
    while (hasPending() && waited < DRAIN_MAX_WAIT_MS) {
      await new Promise(r => setTimeout(r, DRAIN_POLL_INTERVAL_MS));
      waited += DRAIN_POLL_INTERVAL_MS;
    }

    expect(waited).toBeGreaterThanOrEqual(DRAIN_MAX_WAIT_MS);
    expect(hasPending()).toBe(true);
  });

  it('drain error is caught and does not block', async () => {
    let callCount = 0;
    const hasPending = () => {
      callCount++;
      if (callCount === 1) throw new Error('DB connection lost');
      return false;
    };

    let drainError: Error | null = null;
    try {
      if (hasPending()) {
        // Would enter loop
      }
    } catch (error) {
      drainError = error as Error;
    }

    expect(drainError).not.toBeNull();
    expect(drainError!.message).toBe('DB connection lost');
  });
});
