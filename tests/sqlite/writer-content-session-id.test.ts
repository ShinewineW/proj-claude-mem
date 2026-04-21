/**
 * Verifies the SessionStore writers (storeObservation, storeSummary) persist
 * the new `content_session_id` column when the optional param is provided.
 *
 * Related migrations (27-31) add the column + partial unique index. This
 * test pins the writer↔schema contract so a future refactor can't silently
 * drop `content_session_id` from the INSERT.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { createSDKSession } from '../../src/services/sqlite/Sessions.js';

describe('writer content_session_id threading', () => {
  let store: SessionStore;
  let sessionDbId: number;

  beforeEach(() => {
    store = new SessionStore(':memory:');
    sessionDbId = createSDKSession(store.db, 'c-writer', 'test-project', 'prompt');
    store.ensureMemorySessionIdRegistered(sessionDbId, 'm-writer');
  });

  afterEach(() => {
    store.close();
  });

  it('storeObservation inserts with content_session_id populated', () => {
    const result = store.storeObservation(
      'm-writer',
      'test-project',
      {
        type: 'discovery',
        title: 'hello',
        subtitle: null,
        facts: [],
        narrative: 'narrative',
        concepts: [],
        files_read: [],
        files_modified: [],
      },
      1,
      0,
      undefined,
      'c-writer', // content_session_id
    );

    const row = store.db.prepare(
      'SELECT content_session_id FROM observations WHERE id = ?',
    ).get(result.id) as { content_session_id: string | null };
    expect(row.content_session_id).toBe('c-writer');
  });

  it('storeObservation defaults content_session_id to NULL when not provided', () => {
    const result = store.storeObservation(
      'm-writer',
      'test-project',
      {
        type: 'discovery',
        title: 'no content session',
        subtitle: null,
        facts: [],
        narrative: 'n',
        concepts: [],
        files_read: [],
        files_modified: [],
      },
    );

    const row = store.db.prepare(
      'SELECT content_session_id FROM observations WHERE id = ?',
    ).get(result.id) as { content_session_id: string | null };
    expect(row.content_session_id).toBeNull();
  });

  it('storeSummary inserts with content_session_id populated', () => {
    const result = store.storeSummary(
      'm-writer',
      'test-project',
      {
        request: 'r',
        investigated: 'i',
        learned: 'l',
        completed: 'c',
        next_steps: 'n',
        notes: null,
      },
      2,
      0,
      undefined,
      'c-writer',
    );

    const row = store.db.prepare(
      'SELECT content_session_id FROM session_summaries WHERE id = ?',
    ).get(result.id) as { content_session_id: string | null };
    expect(row.content_session_id).toBe('c-writer');
  });

  it('storeSummary defaults content_session_id to NULL when not provided', () => {
    const result = store.storeSummary(
      'm-writer',
      'test-project',
      {
        request: 'r2',
        investigated: 'i2',
        learned: 'l2',
        completed: 'c2',
        next_steps: 'n2',
        notes: null,
      },
    );

    const row = store.db.prepare(
      'SELECT content_session_id FROM session_summaries WHERE id = ?',
    ).get(result.id) as { content_session_id: string | null };
    expect(row.content_session_id).toBeNull();
  });

  it('storeObservations (batch) threads content_session_id onto every inserted row', () => {
    const result = store.storeObservations(
      'm-writer',
      'test-project',
      [
        {
          type: 'discovery',
          title: 'a',
          subtitle: null,
          facts: [],
          narrative: 'na',
          concepts: [],
          files_read: [],
          files_modified: [],
        },
        {
          type: 'feature',
          title: 'b',
          subtitle: null,
          facts: [],
          narrative: 'nb',
          concepts: [],
          files_read: [],
          files_modified: [],
        },
      ],
      {
        request: 'sreq',
        investigated: 'si',
        learned: 'sl',
        completed: 'sc',
        next_steps: 'sn',
        notes: null,
      },
      3,
      0,
      undefined,
      'c-writer',
    );

    expect(result.observationIds).toHaveLength(2);
    const rows = store.db.prepare(
      `SELECT content_session_id FROM observations WHERE id IN (${result.observationIds.join(',')})`,
    ).all() as Array<{ content_session_id: string | null }>;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.content_session_id).toBe('c-writer');
    }

    const sumRow = store.db.prepare(
      'SELECT content_session_id FROM session_summaries WHERE id = ?',
    ).get(result.summaryId) as { content_session_id: string | null };
    expect(sumRow.content_session_id).toBe('c-writer');
  });
});
