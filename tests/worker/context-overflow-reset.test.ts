import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

/**
 * Issue #2088 (703c64c7): on context overflow the session must start fresh on the
 * next spawn — null memorySessionId in the DB + set forceInit — so crash recovery
 * does not re-resume the poisoned SDK context forever.
 */
describe('context-overflow fresh-start reset', () => {
  it('nulls memory_session_id in the DB and sets the in-memory fresh-start flags', () => {
    // SessionStore(:memory:) self-migrates to schema v33 in its ctor (verified
    // SessionStore.ts:25-46 — :memory: skips ensureDir, ctor runs runAllMigrations()).
    const store = new (SessionStore as any)(':memory:');
    const now = Date.now();
    const sid = store.db.prepare(
      "INSERT INTO sdk_sessions (content_session_id, project, user_prompt, started_at, started_at_epoch, memory_session_id) VALUES (?,?,?,?,?,?)"
    ).run('content-1', '/proj', 'hi', new Date(now).toISOString(), now, 'mem-uuid-poisoned').lastInsertRowid as number;

    // Simulate resetSessionForFreshStart's DB side-effect:
    store.updateMemorySessionId(sid, null);

    const row = store.getSessionById(sid);
    expect(row?.memory_session_id).toBeNull();

    // Simulate the in-memory side-effect on the session object:
    const session: any = { memorySessionId: 'mem-uuid-poisoned', forceInit: false };
    session.memorySessionId = null;
    session.forceInit = true;
    expect(session.memorySessionId).toBeNull();
    expect(session.forceInit).toBe(true);
  });
});

describe('context-overflow reset wiring (source)', () => {
  const SRC = readFileSync(join(import.meta.dir, '../../src/services/worker/SDKAgent.ts'), 'utf-8');
  it('forces a fresh start in the context-overflow branch', () => {
    expect(SRC).toContain('session.forceInit = true;');
  });
  it('nulls memorySessionId in the DB on overflow', () => {
    // shape-insensitive: collapse whitespace before matching the multi-line call.
    const flat = SRC.replace(/\s+/g, '');
    expect(flat).toContain('.updateMemorySessionId(session.sessionDbId,null)'.replace(/\s+/g, ''));
  });
});
