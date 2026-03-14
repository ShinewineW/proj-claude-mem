import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { PendingMessageStore } from '../../src/services/sqlite/PendingMessageStore';

describe('proactive summarize before reap', () => {
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

  test('queuing summarize creates pending message that blocks reap', () => {
    db.run(`INSERT INTO sdk_sessions (id, content_session_id, status, started_at_epoch)
            VALUES (1, 'cs-1', 'active', ${Date.now()})`);
    expect(store.getPendingCount(1)).toBe(0);
    store.enqueue(1, 'cs-1', { type: 'summarize', last_assistant_message: undefined });
    expect(store.getPendingCount(1)).toBe(1);
    expect(store.hasPendingSummarize(1)).toBe(true);
  });

  test('proactiveSummarizeQueued flag prevents double-queuing', () => {
    const session = { proactiveSummarizeQueued: false };
    expect(session.proactiveSummarizeQueued).toBe(false);
    session.proactiveSummarizeQueued = true;
    expect(session.proactiveSummarizeQueued).toBe(true);
  });

  test('idle detection uses lastGeneratorActivity not startTime', () => {
    const MAX_IDLE = 15 * 60 * 1000;
    const now = Date.now();
    const session = {
      startTime: now - 20 * 60 * 1000,
      lastGeneratorActivity: now - 5 * 60 * 1000
    };
    const idleMs = now - session.lastGeneratorActivity;
    expect(idleMs).toBeLessThan(MAX_IDLE);

    const staleSession = {
      startTime: now - 20 * 60 * 1000,
      lastGeneratorActivity: now - 20 * 60 * 1000
    };
    const staleIdleMs = now - staleSession.lastGeneratorActivity;
    expect(staleIdleMs).toBeGreaterThan(MAX_IDLE);
  });
});
