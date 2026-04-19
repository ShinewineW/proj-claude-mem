/**
 * Regression test for the FOREIGN KEY constraint failure that hit
 * runFreshSummarize in production on 2026-04-19.
 *
 * Scenario:
 *   1. runFreshSummarize captures sessionRow.memory_session_id at start (X).
 *   2. Fresh query runs ~30s.
 *   3. Observer path (different code path, same session) captures a new
 *      memory_session_id from Claude's own response and calls
 *      ensureMemorySessionIdRegistered(sessionDbId, Y), which UPDATEs
 *      sdk_sessions.memory_session_id from X to Y.
 *   4. Fresh query finishes, runFreshSummarize calls storeSummary(X, ...).
 *   5. INSERT fails because sdk_sessions no longer has a row with
 *      memory_session_id=X (only Y exists). CASCADE on UPDATE only rewrites
 *      existing dependents — it doesn't help a brand-new INSERT with the
 *      stale value.
 *
 * The fix: refetch memory_session_id right before storeSummary, and use the
 * CURRENT value — semantically correct because the summary represents work
 * on sessionDbId N, and whichever memory_session_id is current belongs to
 * that same session.
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
import {
  runFreshSummarizeQuery,
  type FreshSummarizeDeps,
} from '../../src/services/worker/fresh-summarize.js';
import { storeFreshSummaryForSession } from '../../src/services/worker/fresh-summarize-store.js';

describe('fresh-summarize storeSummary with concurrent memory_session_id update', () => {
  let store: SessionStore;
  let sessionDbId: number;

  beforeEach(() => {
    store = new SessionStore(':memory:');
    sessionDbId = store.createSDKSession('c-race', 'test-project', 'do the thing');
    store.ensureMemorySessionIdRegistered(sessionDbId, 'old-id');
  });

  afterEach(() => {
    store.close();
  });

  it('reproduces the bug: using a stale memory_session_id directly throws FK', () => {
    // Simulate observer replacing the id mid-fresh-query.
    store.ensureMemorySessionIdRegistered(sessionDbId, 'new-id');
    // Now INSERT with the STALE id that runFreshSummarize had cached.
    expect(() => {
      store.storeSummary('old-id', 'test-project', {
        request: 'r', investigated: 'i', learned: 'l',
        completed: 'c', next_steps: 'n', notes: null,
      });
    }).toThrow(/FOREIGN KEY/);
  });

  it('storeFreshSummaryForSession succeeds after observer replaces the id', () => {
    // The in-flight fresh query had captured old-id at start.
    // Meanwhile, observer captured a new id and UPDATEd sdk_sessions:
    store.ensureMemorySessionIdRegistered(sessionDbId, 'new-id');
    // Fresh query's storage helper should use the CURRENT id, not the stale one.
    const stored = storeFreshSummaryForSession(store, sessionDbId, {
      request: 'r', investigated: 'i', learned: 'l',
      completed: 'c', next_steps: 'n', notes: null,
    });
    expect(stored).not.toBeNull();
    expect(stored!.id).toBeGreaterThan(0);
    const row = store.db
      .prepare('SELECT memory_session_id FROM session_summaries WHERE id = ?')
      .get(stored!.id) as { memory_session_id: string };
    // Summary attached to the CURRENT id (not the stale one)
    expect(row.memory_session_id).toBe('new-id');
  });

  it('storeFreshSummaryForSession returns null when memory_session_id is NULL', () => {
    // Simulate a case where the session row has no memory_session_id at all
    // (observer never captured one — shouldn't summarize in that case).
    store.db.prepare('UPDATE sdk_sessions SET memory_session_id = NULL WHERE id = ?').run(sessionDbId);
    const stored = storeFreshSummaryForSession(store, sessionDbId, {
      request: 'r', investigated: 'i', learned: 'l',
      completed: 'c', next_steps: 'n', notes: null,
    });
    expect(stored).toBeNull();
  });

  it('storeFreshSummaryForSession returns null when session row is gone', () => {
    store.db.prepare('DELETE FROM sdk_sessions WHERE id = ?').run(sessionDbId);
    const stored = storeFreshSummaryForSession(store, sessionDbId, {
      request: 'r', investigated: 'i', learned: 'l',
      completed: 'c', next_steps: 'n', notes: null,
    });
    expect(stored).toBeNull();
  });

  it('storeFreshSummaryForSession writes with no churn when id is unchanged', () => {
    const stored = storeFreshSummaryForSession(store, sessionDbId, {
      request: 'r', investigated: 'i', learned: 'l',
      completed: 'c', next_steps: 'n', notes: null,
    });
    expect(stored).not.toBeNull();
    const row = store.db
      .prepare('SELECT memory_session_id FROM session_summaries WHERE id = ?')
      .get(stored!.id) as { memory_session_id: string };
    expect(row.memory_session_id).toBe('old-id');
  });

  it('storeFreshSummaryForSession forwards promptNumber / project', () => {
    const stored = storeFreshSummaryForSession(
      store, sessionDbId,
      { request: 'r', investigated: '', learned: '', completed: '',
        next_steps: '', notes: null },
      { promptNumber: 7 },
    );
    expect(stored).not.toBeNull();
    const row = store.db.prepare('SELECT prompt_number, project FROM session_summaries WHERE id = ?')
      .get(stored!.id) as { prompt_number: number; project: string };
    expect(row.prompt_number).toBe(7);
    expect(row.project).toBe('test-project');
  });
});
