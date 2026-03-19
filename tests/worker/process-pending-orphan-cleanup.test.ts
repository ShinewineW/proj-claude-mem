import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { PendingMessageStore } from '../../src/services/sqlite/PendingMessageStore';

describe('processPendingQueues orphan cleanup', () => {
  let db: Database;
  let store: PendingMessageStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run(`CREATE TABLE sdk_sessions (
      id INTEGER PRIMARY KEY, content_session_id TEXT,
      memory_session_id TEXT, project TEXT, user_prompt TEXT,
      status TEXT DEFAULT 'active', started_at_epoch INTEGER
    )`);
    db.run(`CREATE TABLE pending_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_db_id INTEGER REFERENCES sdk_sessions(id),
      content_session_id TEXT, message_type TEXT,
      tool_name TEXT, tool_input TEXT, tool_response TEXT,
      cwd TEXT, last_assistant_message TEXT, prompt_number INTEGER,
      status TEXT DEFAULT 'pending', retry_count INTEGER DEFAULT 0,
      created_at_epoch INTEGER, started_processing_at_epoch INTEGER,
      completed_at_epoch INTEGER, failed_at_epoch INTEGER
    )`);
    store = new PendingMessageStore(db, 3);
  });

  test('markAllSessionMessagesAbandoned marks orphaned messages as failed', () => {
    db.run(`INSERT INTO sdk_sessions (id, content_session_id, status, started_at_epoch)
            VALUES (99, 'cs-orphan', 'active', ${Date.now()})`);
    db.run(`INSERT INTO pending_messages (session_db_id, content_session_id, message_type, status, created_at_epoch)
            VALUES (99, 'cs-orphan', 'observation', 'pending', ${Date.now()})`);
    db.run(`INSERT INTO pending_messages (session_db_id, content_session_id, message_type, status, created_at_epoch)
            VALUES (99, 'cs-orphan', 'observation', 'processing', ${Date.now()})`);

    expect(store.getPendingCount(99)).toBe(2);
    const { retried, failed } = store.markAllSessionMessagesAbandoned(99);

    expect(retried + failed).toBe(2);
    // P2: unconditional fail — all messages marked failed regardless of retry_count
    expect(retried).toBe(0);
    expect(failed).toBe(2);
  });

  test('markAllSessionMessagesAbandoned is idempotent on already-failed messages', () => {
    db.run(`INSERT INTO sdk_sessions (id, content_session_id, status, started_at_epoch)
            VALUES (100, 'cs-done', 'active', ${Date.now()})`);
    db.run(`INSERT INTO pending_messages (session_db_id, content_session_id, message_type, status, created_at_epoch)
            VALUES (100, 'cs-done', 'observation', 'failed', ${Date.now()})`);

    const { retried, failed } = store.markAllSessionMessagesAbandoned(100);
    expect(retried + failed).toBe(0);
  });
});
