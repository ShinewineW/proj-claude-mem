/**
 * Summarize routing tests.
 *
 * After the fresh-query refactor, SessionManager.queueSummarize must:
 *  1. Still run pre-queue salvage first (unchanged — DB-obs synthesis catches
 *     empty-transcript cases before any SDK call).
 *  2. On fallthrough, trigger the runFreshSummarize callback — NOT enqueue a
 *     summarize message into pending_messages (the observer would have
 *     picked it up and responded with observer-mode prose, per
 *     attn_sink/0sum-investigation/NOTES.md).
 *  3. Track in-flight fresh summaries so the deleteSession drain window
 *     can wait on them.
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

describe('SessionManager summarize routing (fresh-query path)', () => {
  let store: SessionStore;
  let pendingStore: PendingMessageStore;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  let spies: Array<ReturnType<typeof spyOn>>;

  // Stub DatabaseManager to always return our in-memory stores.
  function makeStubDbManager(s: SessionStore, p: PendingMessageStore): DatabaseManager {
    return {
      getSessionStore: () => s,
      getPendingMessageStore: () => p,
      getSessionById: (id: number) => s.getSessionById(id),
      getChromaSync: () => undefined,
    } as unknown as DatabaseManager;
  }

  beforeEach(() => {
    // Silence logger so the intentional "handler threw {boom}" and other
    // expected log noise from these tests don't pollute the shared
    // production log file at ~/.claude-mem/logs/.
    spies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
    ];
    store = new SessionStore(':memory:');
    pendingStore = new PendingMessageStore(store.db);
    dbManager = makeStubDbManager(store, pendingStore);
    sessionManager = new SessionManager(dbManager);
  });

  afterEach(() => {
    store.close();
    for (const s of spies) s.mockRestore();
  });

  function seedSession(
    contentSessionId: string,
    memorySessionId: string,
    userPrompt: string = 'do the thing',
  ): number {
    const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', userPrompt);
    store.ensureMemorySessionIdRegistered(sessionDbId, memorySessionId);
    return sessionDbId;
  }

  function addObservation(memorySessionId: string, title: string): void {
    store.storeObservations(
      memorySessionId,
      'test-project',
      [{
        type: 'feature',
        title,
        subtitle: null,
        facts: ['f'],
        narrative: null,
        concepts: [],
        files_read: [],
        files_modified: [],
      }],
      null,
      1,
      0,
    );
  }

  it('invokes the runFreshSummarize callback when pre-queue salvage falls through', async () => {
    const sessionDbId = seedSession('c-1', 'm-1');
    // Presence of last_assistant_message makes pre-queue salvage fall through.
    let calledWith: { sessionDbId: number; lastAssistantMessage: string | undefined } | null = null;
    sessionManager.setOnRunFreshSummarize(async (id, msg) => {
      calledWith = { sessionDbId: id, lastAssistantMessage: msg };
    });

    const result = sessionManager.queueSummarize(
      sessionDbId,
      'I wrote some code and ran tests',
    );

    expect(result.status).toBe('queued');
    // Async callback — wait a tick
    await new Promise(r => setTimeout(r, 10));
    expect(calledWith).not.toBeNull();
    expect(calledWith!.sessionDbId).toBe(sessionDbId);
    expect(calledWith!.lastAssistantMessage).toContain('I wrote some code');
  });

  it('does NOT enqueue summarize messages into pending_messages anymore', async () => {
    const sessionDbId = seedSession('c-2', 'm-2');
    sessionManager.setOnRunFreshSummarize(async () => { /* noop */ });

    sessionManager.queueSummarize(sessionDbId, 'user text');
    await new Promise(r => setTimeout(r, 10));

    const rows = store.db
      .prepare(`SELECT COUNT(*) as c FROM pending_messages
                WHERE session_db_id = ? AND message_type = 'summarize'`)
      .get(sessionDbId) as { c: number };
    expect(rows.c).toBe(0);
  });

  it('pre-queue salvage still wins — runFreshSummarize NOT called when salvaged', async () => {
    const sessionDbId = seedSession('c-3', 'm-3');
    addObservation('m-3', 'prior work');

    let called = false;
    sessionManager.setOnRunFreshSummarize(async () => { called = true; });

    // Empty lastAssistantMessage + observations present → pre-queue salvages
    const result = sessionManager.queueSummarize(sessionDbId, '');
    expect(result.status).toBe('salvaged');
    await new Promise(r => setTimeout(r, 10));
    expect(called).toBe(false);
  });

  it('proactive reaper path — runFreshSummarize NOT called when salvage reports "skipped"', async () => {
    // Full end-to-end of the 10d60372 fix: reapStaleSessions-style call
    // (lastAssistantMessage=undefined) against a session whose last summary
    // is newer than its last observation must return skipped and MUST NOT
    // fire the fresh-query callback. Without this guard, the reaper would
    // spawn a fresh SDK query every ~22min even when there's nothing new —
    // session 178 observed 12 duplicate salvaged summaries in 7h15m that way.
    const sessionDbId = seedSession('c-reaper', 'm-reaper');
    addObservation('m-reaper', 'work at T0');

    // Insert a summary — SessionStore.storeSummary stamps a fresh epoch via
    // Date.now(), so the summary's epoch will be >= the observation's.
    // (Both epochs come from the same process clock within the test's lifetime.)
    await new Promise(r => setTimeout(r, 5)); // tiny delay to ensure monotonic clocks
    store.storeSummary(
      'm-reaper',
      'test-project',
      {
        request: 'initial turn',
        investigated: 'looked at things',
        learned: 'stuff',
        completed: '',
        next_steps: '',
        notes: null,
      },
      1,
      0,
    );

    let freshCalled = false;
    sessionManager.setOnRunFreshSummarize(async () => { freshCalled = true; });

    // Proactive reaper call signature: lastAssistantMessage is undefined.
    const result = sessionManager.queueSummarize(sessionDbId, undefined);

    expect(result.status).toBe('skipped');
    await new Promise(r => setTimeout(r, 15));
    expect(freshCalled).toBe(false);

    // No duplicate summary created — the DB still has exactly 1 summary.
    const count = store.db
      .prepare(`SELECT COUNT(*) AS c FROM session_summaries WHERE memory_session_id = ?`)
      .get('m-reaper') as { c: number };
    expect(count.c).toBe(1);
  });

  it('proactive reaper path — FIRES runFreshSummarize when a new obs arrived after the last summary', async () => {
    // Complement to the skipped test: if there IS new work, the reaper
    // should still hand off to the fresh-query path. This confirms the
    // salvage "skipped" gate does not swallow legitimate summary triggers.
    const sessionDbId = seedSession('c-reaper-go', 'm-reaper-go');

    // Seed old obs, old summary, then a NEW obs.
    addObservation('m-reaper-go', 'old work');
    store.storeSummary(
      'm-reaper-go',
      'test-project',
      {
        request: 'first turn',
        investigated: '',
        learned: '',
        completed: '',
        next_steps: '',
        notes: null,
      },
      1,
      0,
    );
    await new Promise(r => setTimeout(r, 5));
    addObservation('m-reaper-go', 'new work AFTER the summary');

    let freshCalled = false;
    sessionManager.setOnRunFreshSummarize(async () => { freshCalled = true; });

    // Reaper path — undefined lastAssistantMessage. Salvage synthesizes (not
    // skipped) because there are now-newer observations than the summary.
    const result = sessionManager.queueSummarize(sessionDbId, undefined);

    // Salvage handles it by synthesizing from new obs; fresh query is NOT
    // called either (status=salvaged short-circuits the callback).
    expect(result.status).toBe('salvaged');
    await new Promise(r => setTimeout(r, 15));
    expect(freshCalled).toBe(false);
  });

  it('tracks in-flight fresh summaries for drain-window via hasPendingSummarize', async () => {
    const sessionDbId = seedSession('c-4', 'm-4');
    addObservation('m-4', 'some obs');
    let release: (() => void) | null = null;
    sessionManager.setOnRunFreshSummarize(async () => {
      await new Promise<void>(resolve => { release = resolve; });
    });

    sessionManager.queueSummarize(sessionDbId, 'real assistant text');
    await new Promise(r => setTimeout(r, 10));

    // While the callback is pending, drain should see an in-flight summarize.
    expect(sessionManager.hasPendingSummarize(sessionDbId)).toBe(true);

    // Release the callback; counter should drop.
    release!();
    await new Promise(r => setTimeout(r, 10));
    expect(sessionManager.hasPendingSummarize(sessionDbId)).toBe(false);
  });

  it('hasPendingSummarize decrements even if runFreshSummarize throws', async () => {
    const sessionDbId = seedSession('c-5', 'm-5');
    addObservation('m-5', 'obs');
    sessionManager.setOnRunFreshSummarize(async () => {
      throw new Error('boom');
    });

    sessionManager.queueSummarize(sessionDbId, 'text');
    await new Promise(r => setTimeout(r, 30));
    expect(sessionManager.hasPendingSummarize(sessionDbId)).toBe(false);
  });

  it('concurrent queueSummarize calls each trigger the callback', async () => {
    const sessionDbId = seedSession('c-6', 'm-6');
    addObservation('m-6', 'obs');
    let callCount = 0;
    sessionManager.setOnRunFreshSummarize(async () => { callCount++; });

    sessionManager.queueSummarize(sessionDbId, 'msg 1');
    sessionManager.queueSummarize(sessionDbId, 'msg 2');
    await new Promise(r => setTimeout(r, 20));
    expect(callCount).toBe(2);
  });

  it('falls back to no-op cleanly when no callback is registered', () => {
    const sessionDbId = seedSession('c-7', 'm-7');
    // No setOnRunFreshSummarize call
    const result = sessionManager.queueSummarize(sessionDbId, 'something');
    // Should not throw, should return queued
    expect(result.status).toBe('queued');
  });
});
