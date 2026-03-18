/**
 * SessionStore.markSessionFailed — writes status='failed' for abandoned sessions
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

describe('SessionStore.markSessionFailed', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => { store.db.close(); });

  it('writes status=failed for active sessions', () => {
    // Create an active session
    store.db.run(`INSERT INTO sdk_sessions (id, content_session_id, project, status, started_at, started_at_epoch)
      VALUES (1, 'cs-1', 'test', 'active', datetime('now'), ${Date.now()})`);

    store.markSessionFailed(1);

    const row = store.db.prepare('SELECT status, completed_at_epoch FROM sdk_sessions WHERE id = 1').get() as any;
    expect(row.status).toBe('failed');
    expect(row.completed_at_epoch).toBeGreaterThan(0);
  });

  it('does not overwrite non-active status', () => {
    store.db.run(`INSERT INTO sdk_sessions (id, content_session_id, project, status, started_at, started_at_epoch)
      VALUES (1, 'cs-1', 'test', 'completed', datetime('now'), ${Date.now()})`);

    store.markSessionFailed(1);

    const row = store.db.prepare('SELECT status FROM sdk_sessions WHERE id = 1').get() as any;
    expect(row.status).toBe('completed');
  });
});
