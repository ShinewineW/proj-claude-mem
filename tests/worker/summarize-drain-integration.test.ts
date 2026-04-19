/**
 * Drain-window integration guards.
 *
 * deleteSession polls hasPendingSummarize() every 500ms for up to 60s before
 * aborting the observer subprocess. After the fresh-query refactor, the
 * drain signal comes from two sources:
 *   1. Legacy pending_messages rows (crash-recovery replay only — normal
 *      path no longer writes here)
 *   2. The freshSummarizeInFlight counter incremented/decremented around
 *      SessionManager's runFreshSummarize callback.
 *
 * These tests pin the interaction: drain MUST wait for an in-flight fresh
 * summarize, and MUST time out after the ceiling if it never completes.
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { logger } from '../../src/utils/logger.js';

mock.module('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        observation_types: [{ id: 'discovery' }, { id: 'feature' }],
      }),
      loadMode: () => {},
    }),
  },
}));

import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { PendingMessageStore } from '../../src/services/sqlite/PendingMessageStore.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';

function makeStubDbManager(s: SessionStore, p: PendingMessageStore): DatabaseManager {
  return {
    getSessionStore: () => s,
    getPendingMessageStore: () => p,
    getSessionById: (id: number) => s.getSessionById(id),
    getChromaSync: () => undefined,
  } as unknown as DatabaseManager;
}

describe('summarize drain-window integration', () => {
  let store: SessionStore;
  let pendingStore: PendingMessageStore;
  let sessionManager: SessionManager;
  let spies: Array<ReturnType<typeof spyOn>>;

  beforeEach(() => {
    // Silence logger — these tests use a real SessionManager which emits
    // info/warn into the shared production log unless suppressed.
    spies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
    ];
    store = new SessionStore(':memory:');
    pendingStore = new PendingMessageStore(store.db);
    sessionManager = new SessionManager(makeStubDbManager(store, pendingStore));
  });

  afterEach(() => {
    store.close();
    for (const s of spies) s.mockRestore();
  });

  function seed(content: string, memory: string): number {
    const id = store.createSDKSession(content, 'test-project', 'prompt');
    store.ensureMemorySessionIdRegistered(id, memory);
    sessionManager.initializeSession(id, content, 'test-project', undefined);
    return id;
  }

  function addObs(memory: string, title: string): void {
    store.storeObservations(memory, 'test-project', [{
      type: 'feature', title, subtitle: null,
      facts: ['f'], narrative: null,
      concepts: [], files_read: [], files_modified: [],
    }], null, 1, 0);
  }

  it('hasPendingSummarize reflects in-flight fresh summarize immediately', async () => {
    const sessionDbId = seed('c-1', 'm-1');
    addObs('m-1', 'obs');
    let resolve: (() => void) | null = null;
    sessionManager.setOnRunFreshSummarize(() => new Promise<void>((r) => { resolve = r; }));

    expect(sessionManager.hasPendingSummarize(sessionDbId)).toBe(false);
    sessionManager.queueSummarize(sessionDbId, 'text');
    // Synchronous check right after queueSummarize — the increment must
    // happen before queueSummarize returns, else drain could miss it.
    expect(sessionManager.hasPendingSummarize(sessionDbId)).toBe(true);

    resolve!();
    await new Promise(r => setTimeout(r, 10));
    expect(sessionManager.hasPendingSummarize(sessionDbId)).toBe(false);
  });

  it('handles multiple concurrent in-flight summaries (nested counter)', async () => {
    const sessionDbId = seed('c-2', 'm-2');
    addObs('m-2', 'obs');
    const releases: Array<() => void> = [];
    sessionManager.setOnRunFreshSummarize(
      () => new Promise<void>((r) => { releases.push(r); })
    );

    sessionManager.queueSummarize(sessionDbId, 'a');
    sessionManager.queueSummarize(sessionDbId, 'b');
    sessionManager.queueSummarize(sessionDbId, 'c');
    await new Promise(r => setTimeout(r, 10));
    expect(sessionManager.hasPendingSummarize(sessionDbId)).toBe(true);
    expect(releases.length).toBe(3);

    releases[0]();
    await new Promise(r => setTimeout(r, 10));
    expect(sessionManager.hasPendingSummarize(sessionDbId)).toBe(true);
    releases[1]();
    await new Promise(r => setTimeout(r, 10));
    expect(sessionManager.hasPendingSummarize(sessionDbId)).toBe(true);
    releases[2]();
    await new Promise(r => setTimeout(r, 10));
    expect(sessionManager.hasPendingSummarize(sessionDbId)).toBe(false);
  });

  it('isolates in-flight counters per session', async () => {
    const s1 = seed('c-3a', 'm-3a');
    const s2 = seed('c-3b', 'm-3b');
    addObs('m-3a', 'obs'); addObs('m-3b', 'obs');

    let releaseS1: (() => void) | null = null;
    sessionManager.setOnRunFreshSummarize((sessionDbId) => new Promise<void>((r) => {
      if (sessionDbId === s1) releaseS1 = r;
      else r(); // s2 resolves immediately
    }));

    sessionManager.queueSummarize(s1, 'text');
    sessionManager.queueSummarize(s2, 'text');
    await new Promise(r => setTimeout(r, 10));

    expect(sessionManager.hasPendingSummarize(s1)).toBe(true);
    expect(sessionManager.hasPendingSummarize(s2)).toBe(false);

    releaseS1!();
    await new Promise(r => setTimeout(r, 10));
    expect(sessionManager.hasPendingSummarize(s1)).toBe(false);
  });

  it('also reflects legacy pending_messages summarize rows (crash-replay path)', async () => {
    const sessionDbId = seed('c-4', 'm-4');
    // Simulate a stale summarize left by a pre-refactor worker crash.
    pendingStore.enqueue(sessionDbId, 'c-4', {
      type: 'summarize',
      last_assistant_message: 'stale',
    });
    expect(sessionManager.hasPendingSummarize(sessionDbId)).toBe(true);
  });
});
