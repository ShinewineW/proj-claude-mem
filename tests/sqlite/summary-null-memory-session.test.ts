/**
 * Regression: summary store must survive a null memory_session_id (#SUM-loss)
 *
 * Production failure (paper-rolling, 2026-06-09):
 *   1. SDK hits "Context overflow" → SDKAgent nulls sdk_sessions.memory_session_id
 *      AND session.memorySessionId (src/services/worker/SDKAgent.ts).
 *   2. An in-flight summary-only store (obsCount=0, hasSummary=true) then reaches
 *      the single summary-insert chokepoint SessionStore.insertSummaryDeduped with
 *      memorySessionId = null.
 *   3. `INSERT INTO session_summaries` throws
 *      `NOT NULL constraint failed: session_summaries.memory_session_id`,
 *      crashing the generator and permanently dropping that turn's summary.
 *
 * Established convention elsewhere (fresh-summarize-store.ts:69,
 * bypass-observation-store.ts:73) is to SKIP — return null — when the session has
 * no memory_session_id, never to crash. The summary chokepoint must do the same.
 *
 * These tests target the chokepoint through the public store API, so they hold
 * regardless of which (possibly racy) caller leaks the null.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { storeSummary as storeSummaryModule } from '../../src/services/sqlite/Summaries.js';
import {
  storeObservations as storeObservationsModule,
  storeObservationsAndMarkComplete as storeObservationsAndMarkCompleteModule,
} from '../../src/services/sqlite/transactions.js';

const SUMMARY = {
  request: 'r',
  investigated: 'i',
  learned: 'l',
  completed: 'c',
  next_steps: 'n',
  notes: null,
};

describe('summary store survives null memory_session_id', () => {
  let store: SessionStore;
  let testDbPath: string;

  beforeEach(() => {
    testDbPath = `/tmp/test-sum-null-${crypto.randomUUID()}.db`;
    store = new SessionStore(testDbPath);
  });

  afterEach(() => {
    store.close();
    try {
      require('fs').unlinkSync(testDbPath);
    } catch {
      // ignore
    }
  });

  it('storeObservations skips the summary (no crash) when memory_session_id is null', () => {
    let result: { observationIds: number[]; summaryId: number | null } | undefined;

    // Production scenario: summary-only store (no observations) after overflow nulled the id.
    expect(() => {
      result = store.storeObservations(
        null as unknown as string,
        'test-project',
        [], // obsCount=0
        SUMMARY,
        7, // promptNumber
        0,
      );
    }).not.toThrow();

    expect(result?.summaryId).toBeNull();
    // Nothing should have been persisted.
    expect(store.getRecentSummaries('test-project', 10).length).toBe(0);
  });

  it('storeSummary (fresh-path entry) skips and returns id=null when memory_session_id is null', () => {
    // Generality: the guard lives at the shared chokepoint (insertSummaryDeduped),
    // so EVERY public entry — not just storeObservations — survives a null id.
    let res: { id: number | null; createdAtEpoch: number } | undefined;
    expect(() => {
      res = store.storeSummary(null as unknown as string, 'test-project', SUMMARY, 7);
    }).not.toThrow();

    expect(res?.id).toBeNull();
    expect(store.getRecentSummaries('test-project', 10).length).toBe(0);
  });

  it('storeObservationsAndMarkComplete skips the summary while still completing the message', () => {
    const sessionDbId = store.createSDKSession('null-content-complete', 'test-project', 'p');
    const messageId = Number(store.db.prepare(`
      INSERT INTO pending_messages
      (session_db_id, content_session_id, message_type, created_at_epoch, status)
      VALUES (?, ?, 'observation', ?, 'processing')
    `).run(sessionDbId, 'null-content-complete', Date.now()).lastInsertRowid);

    const result = store.storeObservationsAndMarkComplete(
      null as unknown as string,
      'test-project',
      [],
      SUMMARY,
      messageId,
    );

    expect(result.summaryId).toBeNull();
    expect(store.getRecentSummaries('test-project', 10).length).toBe(0);
    const row = store.db.prepare('SELECT status FROM pending_messages WHERE id = ?').get(messageId) as { status: string };
    expect(row.status).toBe('processed');
  });

  it('module-level storeSummary also skips and returns id=null when memory_session_id is null', () => {
    const res = storeSummaryModule(store.db, null as unknown as string, 'test-project', SUMMARY, 7);

    expect(res.id).toBeNull();
    expect(store.getRecentSummaries('test-project', 10).length).toBe(0);
  });

  it('module-level transactions skip summary inserts when memory_session_id is null', () => {
    const res = storeObservationsModule(
      store.db,
      null as unknown as string,
      'test-project',
      [],
      SUMMARY,
      7,
    );

    expect(res.summaryId).toBeNull();

    const sessionDbId = store.createSDKSession('null-module-complete', 'test-project', 'p');
    const messageId = Number(store.db.prepare(`
      INSERT INTO pending_messages
      (session_db_id, content_session_id, message_type, created_at_epoch, status)
      VALUES (?, ?, 'observation', ?, 'processing')
    `).run(sessionDbId, 'null-module-complete', Date.now()).lastInsertRowid);

    const completed = storeObservationsAndMarkCompleteModule(
      store.db,
      null as unknown as string,
      'test-project',
      [],
      SUMMARY,
      messageId,
      7,
    );

    expect(completed.summaryId).toBeNull();
    expect(store.getRecentSummaries('test-project', 10).length).toBe(0);
  });

  it('empty-string memory_session_id is also skipped (no orphan row, no FK crash)', () => {
    // updateMemorySessionId writes null in prod, but an empty string is equally
    // unusable (no matching sdk_sessions row). Falsy check covers both.
    expect(() => {
      store.storeSummary('', 'test-project', SUMMARY, 7);
    }).not.toThrow();
    expect(store.getRecentSummaries('test-project', 10).length).toBe(0);
  });

  it('still stores the summary normally when memory_session_id is valid (guard is not over-eager)', () => {
    const sessionDbId = store.createSDKSession('valid-content-id', 'test-project', 'p');
    const memoryId = 'valid-memory-id';
    store.ensureMemorySessionIdRegistered(sessionDbId, memoryId);

    const res = store.storeSummary(memoryId, 'test-project', SUMMARY, 7);

    expect(res.id).not.toBeNull();
    expect(res.id!).toBeGreaterThan(0);
    expect(store.getRecentSummaries('test-project', 10).length).toBe(1);
  });
});
