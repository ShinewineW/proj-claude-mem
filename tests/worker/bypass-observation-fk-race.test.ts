/**
 * Regression test for the FOREIGN KEY constraint failure that hits
 * BypassLane.processObservation when the observer rotates
 * sdk_sessions.memory_session_id while the bypass LLM call is in flight.
 *
 * Same race pattern as the April 2026 storeFreshSummaryForSession fix
 * (commit 8cba0ce0), different INSERT site:
 *
 *   1. BypassLane.consumeLoop captures session.memorySessionId at T0 (X).
 *   2. callRestApi runs for several seconds.
 *   3. Main channel's observer fires ensureMemorySessionIdRegistered(N, Y),
 *      UPDATEing sdk_sessions.memory_session_id from X to Y.
 *   4. BypassLane reaches storeObservations(X, ...).
 *   5. INSERT into observations(memory_session_id=X, ...) fails because
 *      sdk_sessions no longer has that row. ON UPDATE CASCADE rewrites
 *      existing rows when the parent key changes, but it cannot help a
 *      brand-new INSERT carrying the stale value.
 *
 * The fix: storeBypassObservationsForSession re-reads memory_session_id
 * inside the transaction immediately before the INSERT and uses the CURRENT
 * value — semantically correct because the observations are about work on
 * sessionDbId N, regardless of which memory_session_id is currently bound.
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
  storeBypassObservationsForSession,
  type BypassObservationPayload,
} from '../../src/services/worker/bypass-observation-store.js';

function makeObs(title: string): BypassObservationPayload {
  return {
    type: 'discovery',
    title,
    subtitle: null,
    facts: [],
    narrative: null,
    concepts: [],
    files_read: [],
    files_modified: [],
  };
}

describe('bypass observation store with concurrent memory_session_id update', () => {
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

  it('reproduces the bug: storeObservations with stale id throws FK', () => {
    // Observer rotated the id mid-bypass call.
    store.ensureMemorySessionIdRegistered(sessionDbId, 'new-id');
    // Direct call with the STALE id that BypassLane had cached at T0.
    expect(() => {
      store.storeObservations(
        'old-id',
        'test-project',
        [makeObs('staleInsert')],
        null,
      );
    }).toThrow(/FOREIGN KEY/);
  });

  it('storeBypassObservationsForSession succeeds after observer replaces the id', () => {
    // T0 cache would be 'old-id'. Observer just updated to 'new-id'.
    store.ensureMemorySessionIdRegistered(sessionDbId, 'new-id');

    const result = storeBypassObservationsForSession(
      store,
      sessionDbId,
      [makeObs('postRotateInsert')],
    );

    expect(result).not.toBeNull();
    expect(result!.observationIds.length).toBe(1);
    expect(result!.memorySessionId).toBe('new-id');

    const row = store.db
      .prepare('SELECT memory_session_id FROM observations WHERE id = ?')
      .get(result!.observationIds[0]) as { memory_session_id: string };
    // Observation attached to the CURRENT id, not the stale one.
    expect(row.memory_session_id).toBe('new-id');
  });

  it('returns null when memory_session_id is NULL', () => {
    store.db
      .prepare('UPDATE sdk_sessions SET memory_session_id = NULL WHERE id = ?')
      .run(sessionDbId);
    const result = storeBypassObservationsForSession(store, sessionDbId, [makeObs('x')]);
    expect(result).toBeNull();
  });

  it('returns null when session row is gone', () => {
    store.db.prepare('DELETE FROM sdk_sessions WHERE id = ?').run(sessionDbId);
    const result = storeBypassObservationsForSession(store, sessionDbId, [makeObs('x')]);
    expect(result).toBeNull();
  });

  it('writes with no churn when id is unchanged', () => {
    const result = storeBypassObservationsForSession(
      store,
      sessionDbId,
      [makeObs('unchanged')],
    );
    expect(result).not.toBeNull();
    expect(result!.memorySessionId).toBe('old-id');
    const row = store.db
      .prepare('SELECT memory_session_id FROM observations WHERE id = ?')
      .get(result!.observationIds[0]) as { memory_session_id: string };
    expect(row.memory_session_id).toBe('old-id');
  });

  it('forwards promptNumber and contentSessionId', () => {
    const result = storeBypassObservationsForSession(
      store,
      sessionDbId,
      [makeObs('forwarded')],
      { promptNumber: 7, contentSessionId: 'cs-override' },
    );
    expect(result).not.toBeNull();
    const row = store.db
      .prepare(
        'SELECT prompt_number, content_session_id, project FROM observations WHERE id = ?',
      )
      .get(result!.observationIds[0]) as {
      prompt_number: number;
      content_session_id: string;
      project: string;
    };
    expect(row.prompt_number).toBe(7);
    expect(row.content_session_id).toBe('cs-override');
    expect(row.project).toBe('test-project');
  });

  it('persists multiple observations atomically in one transaction', () => {
    const result = storeBypassObservationsForSession(
      store,
      sessionDbId,
      [makeObs('a'), makeObs('b'), makeObs('c')],
    );
    expect(result).not.toBeNull();
    expect(result!.observationIds.length).toBe(3);
    const count = store.db
      .prepare('SELECT COUNT(*) as n FROM observations')
      .get() as { n: number };
    expect(count.n).toBe(3);
  });
});
