import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';

describe('SessionManager drain timeout marks messages abandoned', () => {
  let db: Database;
  let PendingMessageStore: any;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.run(`CREATE TABLE IF NOT EXISTS sdk_sessions (
      id INTEGER PRIMARY KEY,
      content_session_id TEXT,
      memory_session_id TEXT,
      project TEXT,
      status TEXT DEFAULT 'active',
      started_at_epoch INTEGER
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS pending_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_db_id INTEGER,
      content_session_id TEXT,
      message_type TEXT,
      tool_name TEXT,
      tool_input TEXT,
      tool_response TEXT,
      cwd TEXT,
      status TEXT DEFAULT 'pending',
      retry_count INTEGER DEFAULT 0,
      created_at_epoch INTEGER,
      started_processing_at_epoch INTEGER,
      failed_at_epoch INTEGER
    )`);

    const mod = await import('../../src/services/sqlite/PendingMessageStore');
    PendingMessageStore = mod.PendingMessageStore;
  });

  afterEach(() => {
    db?.close();
  });

  test('markAllSessionMessagesAbandoned marks pending summarize as failed', () => {
    db.run(`INSERT INTO sdk_sessions (id, content_session_id, status, started_at_epoch)
            VALUES (1, 'cs-1', 'active', ${Date.now()})`);
    db.run(`INSERT INTO pending_messages (session_db_id, content_session_id, message_type, status, created_at_epoch)
            VALUES (1, 'cs-1', 'summarize', 'pending', ${Date.now()})`);

    const store = new PendingMessageStore(db, 3);

    expect(store.hasPendingSummarize(1)).toBe(true);

    const { retried, failed } = store.markAllSessionMessagesAbandoned(1);

    // With retry_count=0 (default), message goes back to pending (retried)
    expect(retried).toBe(1);
    expect(failed).toBe(0);

    const row = db.prepare('SELECT status, retry_count FROM pending_messages WHERE session_db_id = 1').get() as any;
    expect(row.status).toBe('pending');
    expect(row.retry_count).toBe(1);
  });

  test('markAllSessionMessagesAbandoned does not affect other sessions', () => {
    db.run(`INSERT INTO sdk_sessions (id, content_session_id, status, started_at_epoch)
            VALUES (1, 'cs-1', 'active', ${Date.now()})`);
    db.run(`INSERT INTO sdk_sessions (id, content_session_id, status, started_at_epoch)
            VALUES (2, 'cs-2', 'active', ${Date.now()})`);
    db.run(`INSERT INTO pending_messages (session_db_id, content_session_id, message_type, status, created_at_epoch)
            VALUES (1, 'cs-1', 'summarize', 'pending', ${Date.now()})`);
    db.run(`INSERT INTO pending_messages (session_db_id, content_session_id, message_type, status, created_at_epoch)
            VALUES (2, 'cs-2', 'summarize', 'pending', ${Date.now()})`);

    const store = new PendingMessageStore(db, 3);
    store.markAllSessionMessagesAbandoned(1);

    expect(store.hasPendingSummarize(2)).toBe(true);
  });
});
