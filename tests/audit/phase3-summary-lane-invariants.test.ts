/**
 * Phase 3 audit: property-based regression coverage for SummaryLane
 * invariants.
 *
 * These properties are universal — any combination of random inputs must
 * satisfy them. They are the shape-level guarantees that the 8-chunk
 * SummaryLane refactor promises:
 *
 *   P1: Turn-key uniqueness. After migration 34, the partial unique index
 *       `idx_session_summaries_turnnum_unique` rejects any second INSERT of
 *       (content_session_id, turn_number) where both are non-null.
 *       Legacy NULL-turn_number rows are NOT constrained — multiple can
 *       coexist for the same content_session_id.
 *
 *   P2: queueSummarize idempotency. Re-enqueueing the SAME
 *       (contentSessionId, turnNumber) pair must never produce a second
 *       `pending` pending_messages row. `shouldDeduplicateTurnSummary`
 *       catches both already-summarized and already-queued. Keyed on turn
 *       IDENTITY since migration 34 — keying on prompt_number collapsed
 *       consecutive redacted-placeholder turns onto one slot.
 *
 *   P3: Migration 31 dedup preserves ALL NULL prompt_number legacy rows.
 *       Only (content_session_id IS NOT NULL AND prompt_number IS NOT NULL)
 *       rows are subject to dedup. Any NULL-prompt_number row present
 *       pre-migration must still exist post-migration.
 *
 * Each property runs N random trials; a single counterexample fails the
 * suite.
 */

import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MigrationRunner } from '../../src/services/sqlite/migrations/runner.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { PendingMessageStore } from '../../src/services/sqlite/PendingMessageStore.js';
import { createSDKSession } from '../../src/services/sqlite/Sessions.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';

function freshDb(): Database {
  const db = new Database(':memory:');
  new MigrationRunner(db).runAllMigrations();
  return db;
}

function randomContentSessionId(i: number): string {
  return `cs-${i}-${Math.floor(Math.random() * 1_000_000)}`;
}

function randomTurnNumber(): number {
  return 1 + Math.floor(Math.random() * 50);
}

// ----------------------------------------------------------------------------
// P1 — Turn-key uniqueness invariant
// ----------------------------------------------------------------------------

describe('P1: turn-key uniqueness (content_session_id, turn_number)', () => {
  it('rejects duplicate inserts with both columns non-null across 50 random pairs', () => {
    const db = freshDb();
    db.prepare(`
      INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, user_prompt, status,
         started_at, started_at_epoch)
      VALUES ('cs-shared', 'mem-shared', 'proj', 'p', 'active', ?, ?)
    `).run(new Date().toISOString(), Date.now());

    const insert = db.prepare(`
      INSERT INTO session_summaries
        (memory_session_id, content_session_id, project, request, investigated,
         learned, completed, next_steps, notes, prompt_number, turn_number,
         discovery_tokens, created_at, created_at_epoch, content_hash)
      VALUES ('mem-shared', ?, 'proj', 'r', 'i', 'l', 'c', 'n', null,
              1, ?, 0, ?, ?, ?)
    `);

    for (let trial = 0; trial < 50; trial++) {
      const cs = randomContentSessionId(trial);
      const turnNumber = randomTurnNumber();
      const hashBase = `${cs}-${turnNumber}-${trial}`;

      const nowIso = new Date(Date.now() + trial).toISOString();
      const nowEpoch = Date.now() + trial;

      insert.run(cs, turnNumber, nowIso, nowEpoch, `${hashBase}-first`);
      expect(() =>
        insert.run(cs, turnNumber, nowIso, nowEpoch, `${hashBase}-duplicate`)
      ).toThrow();
    }

    const count = db.prepare(
      `SELECT COUNT(*) AS c FROM session_summaries`,
    ).get() as { c: number };
    expect(count.c).toBe(50);
  });

  it('allows unlimited rows when turn_number IS NULL (partial index excludes them)', () => {
    const db = freshDb();
    db.prepare(`
      INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, user_prompt, status,
         started_at, started_at_epoch)
      VALUES ('cs-legacy', 'mem-legacy', 'proj', 'p', 'active', ?, ?)
    `).run(new Date().toISOString(), Date.now());

    const insert = db.prepare(`
      INSERT INTO session_summaries
        (memory_session_id, content_session_id, project, request, investigated,
         learned, completed, next_steps, notes, prompt_number, turn_number,
         discovery_tokens, created_at, created_at_epoch, content_hash)
      VALUES ('mem-legacy', 'cs-legacy', 'proj', 'r', 'i', 'l', 'c', 'n', null,
              1, NULL, 0, ?, ?, ?)
    `);

    // 10 NULL-turn rows with unique content hashes — all must succeed.
    for (let i = 0; i < 10; i++) {
      const now = Date.now() + i;
      insert.run(new Date(now).toISOString(), now, `legacy-hash-${i}-${Math.random()}`);
    }

    const count = db.prepare(
      `SELECT COUNT(*) AS c FROM session_summaries WHERE content_session_id = 'cs-legacy' AND turn_number IS NULL`,
    ).get() as { c: number };
    expect(count.c).toBe(10);
  });
});

// ----------------------------------------------------------------------------
// P2 — queueSummarize dedupe idempotency
// ----------------------------------------------------------------------------

function buildSessionManagerFixture() {
  const sessionStore = new SessionStore(':memory:');
  const pendingStore = new PendingMessageStore(sessionStore.db, 3);
  const dbManager = {
    getSessionStore: () => sessionStore,
    getPendingMessageStore: () => pendingStore,
    getSessionById: (id: number) => sessionStore.getSessionById(id),
    getChromaSync: () => undefined,
  } as unknown as DatabaseManager;

  const mgr = new SessionManager(dbManager);
  const contentSessionId = 'cs-dedupe';
  const sessionDbId = sessionStore.createSDKSession(contentSessionId, 'proj', 'p');
  mgr.initializeSession(sessionDbId, 'p', 1);
  return { mgr, sessionStore, pendingStore, sessionDbId, contentSessionId };
}

describe('P2: queueSummarize idempotency across random (turnNumber, re-queue count) inputs', () => {
  it('never produces more than one pending summarize row per (contentSessionId, turnNumber)', () => {
    const { mgr, pendingStore, sessionDbId } = buildSessionManagerFixture();

    const now = Date.now();
    const trials = 30;
    for (let t = 0; t < trials; t++) {
      const turnNumber = 1 + (t % 5); // 5 distinct turns reused 6 times each
      // Each call is a candidate re-enqueue; only the first per turnNumber
      // should create a row. promptNumber is deliberately held constant to
      // mirror a run of `<task-notification>` turns sharing one anchor.
      mgr.queueSummarize(sessionDbId, {
        lastAssistantMessage: `msg ${t}`,
        promptNumber: 1,
        turnNumber,
        queuedAtEpoch: now + t,
      });
    }

    // Group by turn_number; no group should have > 1 pending row.
    const rows = pendingStore['db'].prepare(
      `SELECT turn_number, COUNT(*) AS c FROM pending_messages
       WHERE message_type='summarize' AND status='pending'
       GROUP BY turn_number`,
    ).all() as { turn_number: number; c: number }[];

    for (const row of rows) {
      expect(row.c).toBe(1);
    }
    // All 5 distinct turns must have earned their own row despite sharing
    // prompt_number — this is the 2026-07-28 regression.
    expect(rows.length).toBe(5);
  });
});

// ----------------------------------------------------------------------------
// P3 — Migration 31 preserves all NULL-prompt_number legacy rows
// ----------------------------------------------------------------------------

describe('P3: migration 31 dedup preserves NULL prompt_number legacy rows', () => {
  it('leaves ALL NULL prompt_number rows untouched across N seeded sessions', () => {
    const db = freshDb();
    db.prepare(`
      INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, user_prompt, status,
         started_at, started_at_epoch)
      VALUES ('cs-legacy-p3', 'mem-legacy-p3', 'proj', 'p', 'active', ?, ?)
    `).run(new Date().toISOString(), Date.now());

    // Simulate legacy: 20 NULL-prompt rows that a naive dedup would kill.
    const insert = db.prepare(`
      INSERT INTO session_summaries
        (memory_session_id, content_session_id, project, request, investigated,
         learned, completed, next_steps, notes, prompt_number, discovery_tokens,
         created_at, created_at_epoch, content_hash)
      VALUES ('mem-legacy-p3', 'cs-legacy-p3', 'proj', 'r', 'i', 'l', 'c', 'n', null,
              NULL, 0, ?, ?, ?)
    `);
    const nullRowIds: number[] = [];
    for (let i = 0; i < 20; i++) {
      const now = Date.now() + i;
      const result = insert.run(new Date(now).toISOString(), now, `p3-legacy-${i}-${Math.random()}`);
      nullRowIds.push(result.lastInsertRowid as number);
    }

    // Re-run migration 31 is a no-op (schema_versions already marks it
    // applied); simulate a re-dedup scan against the current state.
    db.run(`
      DELETE FROM session_summaries
      WHERE id NOT IN (
        SELECT MAX(id)
        FROM session_summaries
        WHERE content_session_id IS NOT NULL
          AND prompt_number IS NOT NULL
        GROUP BY content_session_id, prompt_number
      )
      AND content_session_id IS NOT NULL
      AND prompt_number IS NOT NULL
    `);

    // All NULL-prompt rows must still exist.
    const survivors = db.prepare(
      `SELECT id FROM session_summaries WHERE prompt_number IS NULL AND content_session_id = 'cs-legacy-p3' ORDER BY id`,
    ).all() as { id: number }[];
    expect(survivors.length).toBe(20);
    expect(survivors.map(r => r.id).sort((a, b) => a - b)).toEqual(nullRowIds.sort((a, b) => a - b));
  });

  it('deletes duplicates only when BOTH content_session_id AND prompt_number are non-null', () => {
    const db = freshDb();
    db.prepare(`
      INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, user_prompt, status,
         started_at, started_at_epoch)
      VALUES ('cs-mixed', 'mem-mixed', 'proj', 'p', 'active', ?, ?)
    `).run(new Date().toISOString(), Date.now());

    // Seed: 3 non-null-pair duplicates (same cs+pn=5) — dedup should keep 1.
    // Plus 2 rows with NULL prompt_number (same cs) — dedup should keep both.
    const insertPaired = db.prepare(`
      INSERT INTO session_summaries
        (memory_session_id, content_session_id, project, request, investigated,
         learned, completed, next_steps, notes, prompt_number, discovery_tokens,
         created_at, created_at_epoch, content_hash)
      VALUES ('mem-mixed', 'cs-mixed', 'proj', 'r', 'i', 'l', 'c', 'n', null, ?, 0, ?, ?, ?)
    `);
    // Disable the partial unique index temporarily so we can seed the
    // "pre-migration" duplicate state. The index rejects live duplicates.
    db.run(`DROP INDEX IF EXISTS idx_session_summaries_turn_unique`);
    for (let i = 0; i < 3; i++) {
      const now = Date.now() + i;
      insertPaired.run(5, new Date(now).toISOString(), now, `mixed-pn5-${i}`);
    }
    const insertNull = db.prepare(`
      INSERT INTO session_summaries
        (memory_session_id, content_session_id, project, request, investigated,
         learned, completed, next_steps, notes, prompt_number, discovery_tokens,
         created_at, created_at_epoch, content_hash)
      VALUES ('mem-mixed', 'cs-mixed', 'proj', 'r', 'i', 'l', 'c', 'n', null, NULL, 0, ?, ?, ?)
    `);
    for (let i = 0; i < 2; i++) {
      const now = Date.now() + 100 + i;
      insertNull.run(new Date(now).toISOString(), now, `mixed-null-${i}`);
    }

    // Re-run migration 31's dedup SQL.
    db.run(`
      DELETE FROM session_summaries
      WHERE id NOT IN (
        SELECT MAX(id)
        FROM session_summaries
        WHERE content_session_id IS NOT NULL
          AND prompt_number IS NOT NULL
        GROUP BY content_session_id, prompt_number
      )
      AND content_session_id IS NOT NULL
      AND prompt_number IS NOT NULL
    `);

    const pairedSurvivors = db.prepare(
      `SELECT COUNT(*) AS c FROM session_summaries WHERE content_session_id = 'cs-mixed' AND prompt_number = 5`,
    ).get() as { c: number };
    expect(pairedSurvivors.c).toBe(1);

    const nullSurvivors = db.prepare(
      `SELECT COUNT(*) AS c FROM session_summaries WHERE content_session_id = 'cs-mixed' AND prompt_number IS NULL`,
    ).get() as { c: number };
    expect(nullSurvivors.c).toBe(2);
  });
});
