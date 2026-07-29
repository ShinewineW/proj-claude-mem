/**
 * Migration 34: summary turn IDENTITY vs turn ATTRIBUTION
 *
 * Regression cover for the production failure of 2026-07-28: a long autonomous
 * run produced 22 consecutive turns whose prompts were all `<task-notification>`
 * placeholders (`is_redacted=1`). Every one of them resolved to the same
 * attribution anchor (the last real prompt), and because migration 31 made
 * `(content_session_id, prompt_number)` the uniqueness key, the first summary
 * claimed the slot and the other 21 turns were silently dropped at enqueue time.
 *
 * The fix splits the two concepts:
 *   - `turn_number`   IDENTITY    — unique per turn, what dedupe/uniqueness key on
 *   - `prompt_number` ATTRIBUTION — latest real prompt, may repeat across turns
 */

import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MigrationRunner } from '../../src/services/sqlite/migrations/runner.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { storeFreshSummaryForSession } from '../../src/services/worker/fresh-summarize-store.js';

function summaryPayload(tag: string) {
  return {
    request: `request-${tag}`,
    investigated: `investigated-${tag}`,
    learned: `learned-${tag}`,
    completed: `completed-${tag}`,
    next_steps: `next-${tag}`,
    notes: null,
  };
}

/** Seed a session whose memory_session_id is set, as the live paths require. */
function seedSession(store: SessionStore, contentSessionId: string): number {
  const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'prompt');
  store.db
    .prepare('UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?')
    .run(`m-${contentSessionId}`, sessionDbId);
  return sessionDbId;
}

describe('migration 34: schema shape', () => {
  it('adds turn_number to session_summaries and pending_messages', () => {
    const db = new Database(':memory:');
    new MigrationRunner(db).runAllMigrations();

    const summaryCols = db.query('PRAGMA table_info(session_summaries)').all() as Array<{ name: string }>;
    const pendingCols = db.query('PRAGMA table_info(pending_messages)').all() as Array<{ name: string }>;

    expect(summaryCols.some(c => c.name === 'turn_number')).toBe(true);
    expect(pendingCols.some(c => c.name === 'turn_number')).toBe(true);

    db.close();
  });

  it('replaces the prompt_number unique index with a turn_number one', () => {
    const db = new Database(':memory:');
    new MigrationRunner(db).runAllMigrations();

    const indexes = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='session_summaries'")
      .all() as Array<{ name: string }>;
    const names = new Set(indexes.map(i => i.name));

    expect(names.has('idx_session_summaries_turnnum_unique')).toBe(true);
    // prompt_number is attribution-only now and must be free to repeat.
    expect(names.has('idx_session_summaries_turn_unique')).toBe(false);

    db.close();
  });

  it('is idempotent across repeated runs', () => {
    const db = new Database(':memory:');
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();
    expect(() => runner.runAllMigrations()).not.toThrow();

    const cols = (db.query('PRAGMA table_info(session_summaries)').all() as Array<{ name: string }>)
      .filter(c => c.name === 'turn_number');
    expect(cols.length).toBe(1);

    db.close();
  });
});

describe('migration 34: backfill', () => {
  it('copies prompt_number into turn_number for pre-existing rows', () => {
    const db = new Database(':memory:');
    // Run everything, then simulate a legacy row by clearing turn_number and
    // re-running the migration from a reset schema_versions marker.
    new MigrationRunner(db).runAllMigrations();

    db.prepare(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, user_prompt, started_at, started_at_epoch, status)
       VALUES ('cs-legacy', 'm-legacy', 'p', '', '', 0, 'active')`
    ).run();
    db.prepare(
      `INSERT INTO session_summaries
         (memory_session_id, content_session_id, project, request, created_at, created_at_epoch, prompt_number, turn_number)
       VALUES ('m-legacy', 'cs-legacy', 'p', 'r', '', 0, 7, NULL)`
    ).run();

    db.prepare('DELETE FROM schema_versions WHERE version = 34').run();
    new MigrationRunner(db).runAllMigrations();

    const row = db
      .query('SELECT turn_number FROM session_summaries WHERE content_session_id = ?')
      .get('cs-legacy') as { turn_number: number | null };
    expect(row.turn_number).toBe(7);

    db.close();
  });
});

describe('turn identity decouples summaries from the attribution anchor', () => {
  it('stores one summary per turn when consecutive turns share a prompt anchor', () => {
    const store = new SessionStore(':memory:');
    const sessionDbId = seedSession(store, 'cs-run');

    // Production shape: turns 2..5 are <task-notification> placeholders, so all
    // four attribute to real prompt #1 while each keeps its own turn identity.
    const results = [2, 3, 4, 5].map(turn =>
      storeFreshSummaryForSession(store, sessionDbId, summaryPayload(`turn${turn}`), {
        promptNumber: 1,
        turnNumber: turn,
        contentSessionId: 'cs-run',
      })
    );

    expect(results.every(r => r?.action === 'inserted')).toBe(true);
    expect(new Set(results.map(r => r!.id)).size).toBe(4);

    const rows = store.db
      .query('SELECT prompt_number, turn_number FROM session_summaries WHERE content_session_id = ? ORDER BY turn_number')
      .all('cs-run') as Array<{ prompt_number: number; turn_number: number }>;

    expect(rows.map(r => r.turn_number)).toEqual([2, 3, 4, 5]);
    // Attribution is intentionally identical across all four.
    expect(rows.map(r => r.prompt_number)).toEqual([1, 1, 1, 1]);

    store.db.close();
  });

  it('still returns the existing row when the same turn is replayed', () => {
    const store = new SessionStore(':memory:');
    const sessionDbId = seedSession(store, 'cs-replay');

    const first = storeFreshSummaryForSession(store, sessionDbId, summaryPayload('a'), {
      promptNumber: 1,
      turnNumber: 9,
      contentSessionId: 'cs-replay',
    });
    // Distinct content so the 30s content-hash dedupe cannot be what catches it —
    // this must be the turn key doing the work.
    const replay = storeFreshSummaryForSession(store, sessionDbId, summaryPayload('b'), {
      promptNumber: 1,
      turnNumber: 9,
      contentSessionId: 'cs-replay',
    });

    expect(first?.action).toBe('inserted');
    expect(replay?.action).toBe('returned_existing');
    expect(replay?.id).toBe(first!.id);

    const count = store.db
      .query('SELECT COUNT(*) AS c FROM session_summaries WHERE content_session_id = ?')
      .get('cs-replay') as { c: number };
    expect(count.c).toBe(1);

    store.db.close();
  });

  it('rejects a duplicate turn at the DB level even if the dedupe check is bypassed', () => {
    const store = new SessionStore(':memory:');
    seedSession(store, 'cs-index');

    const insert = () =>
      store.db
        .prepare(
          `INSERT INTO session_summaries
             (memory_session_id, content_session_id, project, request, created_at, created_at_epoch, prompt_number, turn_number)
           VALUES ('m-cs-index', 'cs-index', 'p', 'r', '', 0, 1, 3)`
        )
        .run();

    insert();
    expect(insert).toThrow();

    store.db.close();
  });
});
