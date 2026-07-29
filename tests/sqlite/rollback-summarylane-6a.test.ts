/**
 * Rollback SQL script validation for Chunk 6a (migrations 27-31).
 *
 * These tests exercise the rollback-summarylane-6a.sql script end-to-end against
 * an in-memory DB that has already run all migrations. The rollback must:
 *   1. DROP both summary turn indexes
 *   2. Restore rows destroyed by the dedup in migration 31
 *   3. Restore the pre-34 pending_messages schema without losing queued rows
 *   4. DROP content_session_id columns from observations + session_summaries
 *   5. Remove 27-31 and 34 entries from schema_versions
 *   6. NOT drop the snapshot tables (operator-owned cleanup per spec §9)
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { Database } from 'bun:sqlite';
import { MigrationRunner } from '../../src/services/sqlite/migrations/runner.js';

const ROLLBACK_SCRIPT_PATH = join(
  __dirname,
  '..',
  '..',
  'src',
  'services',
  'sqlite',
  'migrations',
  'rollback-summarylane-6a.sql',
);

function loadRollbackSql(): string {
  return readFileSync(ROLLBACK_SCRIPT_PATH, 'utf-8');
}

/**
 * Execute the rollback script against a DB, one statement at a time.
 * SQLite does not accept BEGIN/COMMIT via Database.exec() when issued as a
 * single blob in some bindings; splitting lets us keep statements atomic.
 */
function executeRollbackSql(db: Database, sql: string): void {
  // Strip line comments (-- ...) and empty lines; keep /* ... */ out of scope.
  const cleaned = sql
    .split('\n')
    .map(line => {
      const idx = line.indexOf('--');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');

  // Split on semicolon boundaries. Preserves statements intact since our SQL
  // never contains embedded semicolons inside string literals.
  const statements = cleaned
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  for (const stmt of statements) {
    db.run(stmt);
  }
}

function restorePre34Schema(db: Database): void {
  db.run('DROP INDEX IF EXISTS idx_session_summaries_turnnum_unique');
  db.run('ALTER TABLE session_summaries DROP COLUMN turn_number');
  db.run('ALTER TABLE pending_messages DROP COLUMN turn_number');
  db.run(`
    CREATE UNIQUE INDEX idx_session_summaries_turn_unique
    ON session_summaries(content_session_id, prompt_number)
    WHERE content_session_id IS NOT NULL AND prompt_number IS NOT NULL
  `);
  db.prepare('DELETE FROM schema_versions WHERE version = 34').run();
}

describe('rollback-summarylane-6a.sql', () => {
  it('script file exists at the expected path', () => {
    expect(existsSync(ROLLBACK_SCRIPT_PATH)).toBe(true);
  });

  it('removes content_session_id column from observations', () => {
    const db = new Database(':memory:');
    new MigrationRunner(db).runAllMigrations();
    // Sanity — post-migration observations has content_session_id
    const before = db.prepare(`PRAGMA table_info(observations)`).all() as { name: string }[];
    expect(before.some(c => c.name === 'content_session_id')).toBe(true);

    executeRollbackSql(db, loadRollbackSql());

    const after = db.prepare(`PRAGMA table_info(observations)`).all() as { name: string }[];
    expect(after.some(c => c.name === 'content_session_id')).toBe(false);
  });

  it('removes content_session_id column from session_summaries', () => {
    const db = new Database(':memory:');
    new MigrationRunner(db).runAllMigrations();

    executeRollbackSql(db, loadRollbackSql());

    const cols = db.prepare(`PRAGMA table_info(session_summaries)`).all() as { name: string }[];
    expect(cols.some(c => c.name === 'content_session_id')).toBe(false);
  });

  it('removes turn_number from both migration-34 tables', () => {
    const db = new Database(':memory:');
    new MigrationRunner(db).runAllMigrations();

    executeRollbackSql(db, loadRollbackSql());

    const summaryCols = db.prepare(
      `PRAGMA table_info(session_summaries)`,
    ).all() as { name: string }[];
    const pendingCols = db.prepare(
      `PRAGMA table_info(pending_messages)`,
    ).all() as { name: string }[];
    expect(summaryCols.some(c => c.name === 'turn_number')).toBe(false);
    expect(pendingCols.some(c => c.name === 'turn_number')).toBe(false);
  });

  it('also succeeds on a pre-34 database', () => {
    const db = new Database(':memory:');
    new MigrationRunner(db).runAllMigrations();
    restorePre34Schema(db);

    expect(() => executeRollbackSql(db, loadRollbackSql())).not.toThrow();

    const summaryCols = db.prepare(
      `PRAGMA table_info(session_summaries)`,
    ).all() as { name: string }[];
    const pendingCols = db.prepare(
      `PRAGMA table_info(pending_messages)`,
    ).all() as { name: string }[];
    expect(summaryCols.some(c => c.name === 'content_session_id')).toBe(false);
    expect(pendingCols.some(c => c.name === 'turn_number')).toBe(false);
  });

  it('drops both turn indexes (migration 31 and the migration-34 replacement)', () => {
    const db = new Database(':memory:');
    new MigrationRunner(db).runAllMigrations();
    // Sanity: after migration 34 the live index is the turn_number one; the
    // migration-31 index was dropped when 34 superseded it.
    const indexesBefore = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='session_summaries'`,
    ).all() as { name: string }[];
    expect(indexesBefore.some(i => i.name === 'idx_session_summaries_turnnum_unique')).toBe(true);

    executeRollbackSql(db, loadRollbackSql());

    const indexesAfter = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='session_summaries'`,
    ).all() as { name: string }[];
    expect(indexesAfter.some(i => i.name === 'idx_session_summaries_turn_unique')).toBe(false);
    expect(indexesAfter.some(i => i.name === 'idx_session_summaries_turnnum_unique')).toBe(false);
  });

  it('removes schema_versions entries 27-31 and 34', () => {
    const db = new Database(':memory:');
    new MigrationRunner(db).runAllMigrations();

    executeRollbackSql(db, loadRollbackSql());

    const rows = db.prepare(
      `SELECT version FROM schema_versions WHERE version IN (27, 28, 29, 30, 31, 34)`,
    ).all() as { version: number }[];
    expect(rows.length).toBe(0);
  });

  it('restores rows destroyed by migration 31 dedup from the snapshot', () => {
    const db = new Database(':memory:');
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    // Seed two duplicate (content_session_id, prompt_number) summaries that
    // would be deduped if migration 31 ran against them. Because the test DB
    // is in-memory, we seed AFTER runAll() and then simulate the dedup by
    // hand so the snapshot contains the row we later want restored.
    const nowIso = new Date().toISOString();
    const nowEpoch = Date.now();
    db.prepare(`
      INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, user_prompt, status,
         started_at, started_at_epoch)
      VALUES ('cs-a', 'mem-a', 'proj', 'p', 'active', ?, ?)
    `).run(nowIso, nowEpoch);
    const newerId = (db.prepare(`
      INSERT INTO session_summaries
        (memory_session_id, content_session_id, project, request, investigated, learned, completed,
         next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch, content_hash)
      VALUES ('mem-a', 'cs-a', 'proj', 'r2', 'i2', 'l2', 'c2', 'n2', null, 1, 0, ?, ?, 'h2')
    `).run(new Date().toISOString(), Date.now()).lastInsertRowid) as number;

    // Pretend there was an older duplicate that migration 31 deleted — we
    // simulate by inserting it only into the snapshot table (the state a
    // real dedup would produce).
    const olderId = newerId + 1000; // arbitrary id not in the live table
    db.prepare(`
      INSERT INTO session_summaries_premigration_summarylane
        (id, memory_session_id, project, request, investigated, learned, completed,
         next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch, content_hash)
      VALUES (?, 'mem-a', 'proj', 'r-old', 'i-old', 'l-old', 'c-old', 'n-old', null, 1, 0, ?, ?, 'h-old')
    `).run(olderId, new Date().toISOString(), Date.now() - 10_000);

    executeRollbackSql(db, loadRollbackSql());

    // The older row (present only in the snapshot) should have been
    // restored into session_summaries; the newer row already lived there
    // and must still exist.
    const restored = db.prepare(
      `SELECT id, request FROM session_summaries WHERE id IN (?, ?)`,
    ).all(newerId, olderId) as { id: number; request: string }[];
    const ids = restored.map(r => r.id);
    expect(ids).toContain(newerId);
    expect(ids).toContain(olderId);
  });

  it('preserves queued messages while removing turn_number', () => {
    const db = new Database(':memory:');
    new MigrationRunner(db).runAllMigrations();
    db.prepare(`
      INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, user_prompt, status,
         started_at, started_at_epoch)
      VALUES ('cs-pending', 'mem-pending', 'proj', 'p', 'active', '', 0)
    `).run();
    const session = db.prepare(
      `SELECT id FROM sdk_sessions WHERE content_session_id = 'cs-pending'`,
    ).get() as { id: number };
    db.prepare(`
      INSERT INTO pending_messages
        (session_db_id, content_session_id, message_type, prompt_number,
         turn_number, status, retry_count, created_at_epoch)
      VALUES (?, 'cs-pending', 'summarize', 4, 7, 'pending', 1, 1234)
    `).run(session.id);

    executeRollbackSql(db, loadRollbackSql());

    const row = db.prepare(`
      SELECT content_session_id, message_type, prompt_number, status,
             retry_count, created_at_epoch
      FROM pending_messages
      WHERE session_db_id = ?
    `).get(session.id);
    expect(row).toEqual({
      content_session_id: 'cs-pending',
      message_type: 'summarize',
      prompt_number: 4,
      status: 'pending',
      retry_count: 1,
      created_at_epoch: 1234,
    });
  });

  it('retains the snapshot tables after rollback (operator-owned cleanup)', () => {
    const db = new Database(':memory:');
    new MigrationRunner(db).runAllMigrations();

    executeRollbackSql(db, loadRollbackSql());

    const obsSnap = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='observations_premigration_summarylane'`,
    ).get() as { name: string } | undefined;
    const sumSnap = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='session_summaries_premigration_summarylane'`,
    ).get() as { name: string } | undefined;
    expect(obsSnap?.name).toBe('observations_premigration_summarylane');
    expect(sumSnap?.name).toBe('session_summaries_premigration_summarylane');
  });
});
