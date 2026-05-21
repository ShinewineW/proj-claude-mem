/**
 * Migration 33: rebindMisattributedRedactedAnchors
 *
 * Scenario reproduces what migration 32 (`is_redacted` placeholders) caused
 * before this fix landed: observations / summaries arriving while a redacted
 * `<task-notification>` row occupied the latest prompt_number got attributed
 * to that placeholder instead of the preceding real user prompt.
 *
 * Migration 33 must rewrite each such row's prompt_number to the latest real
 * prompt_number ≤ current within the same session, and leave clean rows alone.
 */

import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MigrationRunner } from '../../src/services/sqlite/migrations/runner.js';
import { createSDKSession } from '../../src/services/sqlite/Sessions.js';
import { saveUserPrompt } from '../../src/services/sqlite/Prompts.js';

function buildDb(): Database {
  const db = new Database(':memory:');
  new MigrationRunner(db).runAllMigrations();
  return db;
}

/**
 * Migrations are gated on `schema_versions`, so a freshly-built DB has
 * migration 33 marked applied (as a no-op) before any rows exist. To exercise
 * the rebind logic in tests we delete that row, seed the misattributed state,
 * then re-run migrations so 33 executes against real data — the same shape
 * that production hits when an existing DB rolls forward.
 */
function arm33Rebind(db: Database): void {
  db.prepare('DELETE FROM schema_versions WHERE version = 33').run();
}

function insertObservation(
  db: Database,
  contentSessionId: string,
  memorySessionId: string,
  promptNumber: number,
  title: string,
): number {
  const result = db.prepare(`
    INSERT INTO observations
      (memory_session_id, content_session_id, project, type, title,
       prompt_number, created_at, created_at_epoch)
    VALUES (?, ?, 'test', 'change', ?, ?, ?, ?)
  `).run(memorySessionId, contentSessionId, title, promptNumber, new Date().toISOString(), Date.now());
  return result.lastInsertRowid as number;
}

function insertSummary(
  db: Database,
  contentSessionId: string,
  memorySessionId: string,
  promptNumber: number,
  request: string,
): number {
  const result = db.prepare(`
    INSERT INTO session_summaries
      (memory_session_id, content_session_id, project, request,
       prompt_number, created_at, created_at_epoch)
    VALUES (?, ?, 'test', ?, ?, ?, ?)
  `).run(memorySessionId, contentSessionId, request, promptNumber, new Date().toISOString(), Date.now());
  return result.lastInsertRowid as number;
}

function getObservationPromptNumber(db: Database, id: number): number | null {
  const row = db.prepare('SELECT prompt_number FROM observations WHERE id = ?').get(id) as { prompt_number: number | null } | undefined;
  return row?.prompt_number ?? null;
}

function getSummaryPromptNumber(db: Database, id: number): number | null {
  const row = db.prepare('SELECT prompt_number FROM session_summaries WHERE id = ?').get(id) as { prompt_number: number | null } | undefined;
  return row?.prompt_number ?? null;
}

describe('migration 33: rebindMisattributedRedactedAnchors', () => {
  it('rewrites observation prompt_number from a redacted placeholder back to the prior real prompt', () => {
    const db = buildDb();
    const sess = 'c-rebind-obs';
    createSDKSession(db, sess, 'test', 'first');
    db.prepare('UPDATE sdk_sessions SET memory_session_id = ? WHERE content_session_id = ?').run('m-rebind-obs', sess);

    // Real prompt at pn=1, then a redacted placeholder at pn=2.
    saveUserPrompt(db, sess, 1, '点云数据在哪里？');
    saveUserPrompt(db, sess, 2, '', true);

    // Observation arrived during pn=1's tool use but the old COUNT-based
    // resolver tagged it pn=2 because the redacted row had landed in between.
    const obsId = insertObservation(db, sess, 'm-rebind-obs', 2, 'PCD render started');
    expect(getObservationPromptNumber(db, obsId)).toBe(2);

    // Roll back migration 33 to simulate a pre-fix DB, then re-run migrations.
    arm33Rebind(db);
    new MigrationRunner(db).runAllMigrations();

    expect(getObservationPromptNumber(db, obsId)).toBe(1);
    db.close();
  });

  it('rewrites summary prompt_number from a redacted placeholder back to the prior real prompt', () => {
    const db = buildDb();
    const sess = 'c-rebind-sum';
    createSDKSession(db, sess, 'test', 'first');
    db.prepare('UPDATE sdk_sessions SET memory_session_id = ? WHERE content_session_id = ?').run('m-rebind-sum', sess);

    saveUserPrompt(db, sess, 1, 'do the thing');
    saveUserPrompt(db, sess, 2, '', true);

    const sumId = insertSummary(db, sess, 'm-rebind-sum', 2, 'thing was done');

    arm33Rebind(db);
    new MigrationRunner(db).runAllMigrations();

    expect(getSummaryPromptNumber(db, sumId)).toBe(1);
    db.close();
  });

  it('leaves observations on real prompts untouched', () => {
    const db = buildDb();
    const sess = 'c-clean';
    createSDKSession(db, sess, 'test', 'first');
    db.prepare('UPDATE sdk_sessions SET memory_session_id = ? WHERE content_session_id = ?').run('m-clean', sess);

    saveUserPrompt(db, sess, 1, 'real one');
    saveUserPrompt(db, sess, 2, 'real two');
    const obsId = insertObservation(db, sess, 'm-clean', 2, 'work for two');

    arm33Rebind(db);
    new MigrationRunner(db).runAllMigrations();

    expect(getObservationPromptNumber(db, obsId)).toBe(2);
    db.close();
  });

  it('leaves rows with no preceding real prompt untouched (no legitimate rebind target)', () => {
    const db = buildDb();
    const sess = 'c-orphan';
    createSDKSession(db, sess, 'test', 'first');
    db.prepare('UPDATE sdk_sessions SET memory_session_id = ? WHERE content_session_id = ?').run('m-orphan', sess);

    // Session opens with a redacted system event — no real prompt precedes it.
    saveUserPrompt(db, sess, 1, '', true);
    const obsId = insertObservation(db, sess, 'm-orphan', 1, 'orphan obs');

    arm33Rebind(db);
    new MigrationRunner(db).runAllMigrations();

    // Migration must NOT null this out or fabricate an anchor; leave as-is so
    // operators can inspect and triage manually.
    expect(getObservationPromptNumber(db, obsId)).toBe(1);
    db.close();
  });

  it('picks the latest preceding real prompt across multiple redacted placeholders', () => {
    const db = buildDb();
    const sess = 'c-multi';
    createSDKSession(db, sess, 'test', 'first');
    db.prepare('UPDATE sdk_sessions SET memory_session_id = ? WHERE content_session_id = ?').run('m-multi', sess);

    saveUserPrompt(db, sess, 1, 'real one');
    saveUserPrompt(db, sess, 2, '', true);
    saveUserPrompt(db, sess, 3, 'real two');
    saveUserPrompt(db, sess, 4, '', true);
    saveUserPrompt(db, sess, 5, '', true);
    const obsId = insertObservation(db, sess, 'm-multi', 5, 'work that belonged to real two');

    arm33Rebind(db);
    new MigrationRunner(db).runAllMigrations();

    // pn=5 is redacted; latest real prompt ≤ 5 is pn=3.
    expect(getObservationPromptNumber(db, obsId)).toBe(3);
    db.close();
  });

  it('skips summary rebind when target slot already holds another summary (unique-on-turn collision)', () => {
    const db = buildDb();
    const sess = 'c-collide';
    createSDKSession(db, sess, 'test', 'first');
    db.prepare('UPDATE sdk_sessions SET memory_session_id = ? WHERE content_session_id = ?').run('m-collide', sess);

    saveUserPrompt(db, sess, 1, 'real one');
    saveUserPrompt(db, sess, 2, '', true);

    // Real summary for pn=1 already exists, AND a misattributed summary sits at
    // the redacted pn=2 (different chunk of work that happened post-event).
    const realSumId = insertSummary(db, sess, 'm-collide', 1, 'phase A done');
    const misattributedSumId = insertSummary(db, sess, 'm-collide', 2, 'phase B done');

    arm33Rebind(db);
    new MigrationRunner(db).runAllMigrations(); // must NOT throw on unique-index collision

    // Real summary stays put.
    expect(getSummaryPromptNumber(db, realSumId)).toBe(1);
    // Misattributed one stays on the redacted pn so its content survives;
    // viewer filters the placeholder row out independently.
    expect(getSummaryPromptNumber(db, misattributedSumId)).toBe(2);
    db.close();
  });

  it('is idempotent — second run is a no-op', () => {
    const db = buildDb();
    const sess = 'c-idem';
    createSDKSession(db, sess, 'test', 'first');
    db.prepare('UPDATE sdk_sessions SET memory_session_id = ? WHERE content_session_id = ?').run('m-idem', sess);

    saveUserPrompt(db, sess, 1, 'real');
    saveUserPrompt(db, sess, 2, '', true);
    const obsId = insertObservation(db, sess, 'm-idem', 2, 'will rebind');

    arm33Rebind(db);
    new MigrationRunner(db).runAllMigrations(); // first pass — rebinds
    expect(getObservationPromptNumber(db, obsId)).toBe(1);

    new MigrationRunner(db).runAllMigrations(); // second pass — nothing to do
    expect(getObservationPromptNumber(db, obsId)).toBe(1);
    db.close();
  });
});
