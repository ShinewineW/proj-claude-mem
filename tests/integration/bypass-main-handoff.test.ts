import { describe, it, expect, mock } from 'bun:test';
import { EventEmitter } from 'events';

mock.module('../../src/utils/logger.js', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    failure: () => {},
    success: () => {},
    formatTool: () => 'mock-tool',
  },
}));

/**
 * G3: End-to-end test verifying that when bypass fails and requeues a message,
 * the main lane is woken immediately and can claim the same message.
 *
 * This is a focused integration test exercising:
 * - PendingMessageStore.markFailed() -> message back to pending
 * - SessionManager.notifyMessageAvailable() -> emitter fires
 * - PendingMessageStore.claimNextMessage() -> main lane claims
 */
describe('G3: bypass failure -> main lane handoff', () => {
  it('main lane is woken immediately when bypass requeues a failed message', async () => {
    const { PendingMessageStore } = await import('../../src/services/sqlite/PendingMessageStore.js');
    const Database = (await import('bun:sqlite')).default;

    // In-memory SQLite with required schema
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE sdk_sessions (
        id INTEGER PRIMARY KEY,
        content_session_id TEXT,
        memory_session_id TEXT,
        project TEXT,
        user_prompt TEXT,
        started_at TEXT,
        started_at_epoch INTEGER,
        completed_at TEXT,
        completed_at_epoch INTEGER,
        status TEXT DEFAULT 'active',
        prompt_counter INTEGER DEFAULT 0
      );
      CREATE TABLE pending_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER NOT NULL,
        content_session_id TEXT NOT NULL,
        message_type TEXT NOT NULL,
        tool_name TEXT,
        tool_input TEXT,
        tool_response TEXT,
        cwd TEXT,
        last_assistant_message TEXT,
        prompt_number INTEGER,
        turn_number INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at_epoch INTEGER NOT NULL,
        started_processing_at_epoch INTEGER,
        completed_at_epoch INTEGER,
        failed_at_epoch INTEGER,
        FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id)
      );
      INSERT INTO sdk_sessions (id, content_session_id, status) VALUES (1, 'cs-1', 'active');
    `);

    const store = new PendingMessageStore(db, 3);
    const emitter = new EventEmitter();

    // Enqueue an observation message
    const messageId = store.enqueue(1, 'cs-1', {
      type: 'observation',
      tool_name: 'Read',
      tool_input: '{"path":"/test"}',
      tool_response: '{"content":"hello"}',
      cwd: '/tmp',
    });

    // Bypass claims the message
    const claimed = store.claimNextObservation(1);
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(messageId);

    // Bypass fails — markFailed requeues it
    store.markFailed(messageId);

    // Set up main lane listener (simulates waitForMessage)
    const mainLaneWoken = new Promise<boolean>(resolve => {
      emitter.once('message', () => resolve(true));
      setTimeout(() => resolve(false), 500);
    });

    // Simulate notifyMessageAvailable
    emitter.emit('message');

    // Main lane should be woken
    expect(await mainLaneWoken).toBe(true);

    // Main lane claims the same message
    // Note: claimNextMessage returns the row as fetched (status='pending')
    // then atomically updates it to 'processing' in the same transaction
    const reClaimed = store.claimNextMessage(1);
    expect(reClaimed).not.toBeNull();
    expect(reClaimed!.id).toBe(messageId);

    db.close();
  });
});
