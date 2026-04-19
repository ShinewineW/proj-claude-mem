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

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

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
    store = new SessionStore(':memory:');
    pendingStore = new PendingMessageStore(store.db);
    dbManager = makeStubDbManager(store, pendingStore);
    sessionManager = new SessionManager(dbManager);
  });

  afterEach(() => {
    store.close();
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
