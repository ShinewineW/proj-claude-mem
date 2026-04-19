/**
 * SDKAgent.runFreshSummarize orchestration tests.
 *
 * runFreshSummarizeQuery (the core) has 14 unit tests in fresh-summarize.test.ts.
 * storeFreshSummaryForSession has 6 tests in fresh-summarize-fk-race.test.ts.
 * This file covers the OUTER orchestration in SDKAgent.runFreshSummarize —
 * specifically the early-return paths that guard against calling the SDK
 * when the session row is missing or its memory_session_id is null.
 *
 * These paths cannot be triggered through the existing fresh-summarize.test.ts
 * (which exercises the query function directly) nor through the FK-race tests
 * (which assume a valid session row). A bug here would cause a crash before
 * the in-flight counter is decremented in SessionManager.queueSummarize's
 * .finally() — the exact regression the fresh-query refactor was meant to
 * eliminate.
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
import { SDKAgent } from '../../src/services/worker/SDKAgent.js';

describe('SDKAgent.runFreshSummarize — early-return orchestration', () => {
  let store: SessionStore;
  let pendingStore: PendingMessageStore;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  let sdkAgent: SDKAgent;
  let spies: Array<ReturnType<typeof spyOn>>;

  function makeStubDbManager(
    s: SessionStore,
    p: PendingMessageStore,
  ): DatabaseManager {
    return {
      getSessionStore: () => s,
      getPendingMessageStore: () => p,
      getSessionById: (id: number) => s.getSessionById(id),
      getChromaSync: () => undefined,
    } as unknown as DatabaseManager;
  }

  beforeEach(() => {
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
    sdkAgent = new SDKAgent(dbManager, sessionManager);
  });

  afterEach(() => {
    store.close();
    for (const s of spies) s.mockRestore();
  });

  it('returns silently when sessionRow does not exist (nonexistent sessionDbId)', async () => {
    // No session seeded — sessionDbId 9999 returns undefined from getSessionById.
    // runFreshSummarize must not throw and must not attempt to spawn Claude.
    //
    // A crash here would propagate up to queueSummarize's .finally() only
    // if the .catch handler fires, which it does — but the behavioral
    // contract is that the method is a silent no-op for invalid sessions.
    const result = await sdkAgent.runFreshSummarize(9999, 'any text', undefined);
    expect(result).toBeUndefined();
  });

  it('returns silently when sessionRow exists but memory_session_id is null', async () => {
    // Create session WITHOUT registering memory_session_id. This mirrors the
    // first-hook window where a session is created from observation route
    // (cwd-derived project) but no SDK response has captured a real
    // memory_session_id yet. Calling summarize in that window should just
    // no-op — there is nothing to key the summary against.
    const sessionDbId = store.createSDKSession('cs-null', 'test-project', 'do thing');
    // Intentionally NOT calling ensureMemorySessionIdRegistered.

    const sessionRow = store.getSessionById(sessionDbId);
    expect(sessionRow?.memory_session_id).toBeFalsy();

    const result = await sdkAgent.runFreshSummarize(sessionDbId, 'any text', undefined);
    expect(result).toBeUndefined();

    // No summary was stored — verify DB is empty.
    const summaryCount = store.db
      .prepare(`SELECT COUNT(*) AS c FROM session_summaries`)
      .get() as { c: number };
    expect(summaryCount.c).toBe(0);
  });

  it('does not throw when called on a session whose row was deleted mid-flight', async () => {
    // Simulates the "session row went away while handler was queued"
    // scenario — different from the FK-race (which is about memory_session_id
    // being UPDATED). Here the row is DELETED. getSessionById returns
    // undefined → same early-return branch as test 1, but triggered through
    // a realistic deletion path.
    const sessionDbId = store.createSDKSession('cs-del', 'test-project', 'do thing');
    store.ensureMemorySessionIdRegistered(sessionDbId, 'mem-del');

    // Delete the session row.
    store.db.prepare(`DELETE FROM sdk_sessions WHERE id = ?`).run(sessionDbId);

    const result = await sdkAgent.runFreshSummarize(sessionDbId, 'text', undefined);
    expect(result).toBeUndefined();
  });
});
