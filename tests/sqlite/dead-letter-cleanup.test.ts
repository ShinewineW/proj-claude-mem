/**
 * PendingMessageStore — dead letter and orphan cleanup on startup
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { PendingMessageStore } from '../../src/services/sqlite/PendingMessageStore.js';
import { createSDKSession } from '../../src/services/sqlite/Sessions.js';
import type { Database } from 'bun:sqlite';
import type { PendingMessage } from '../../src/services/worker-types.js';

function makeObs(): PendingMessage {
  return { type: 'observation', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { content: 'ok' }, cwd: '/tmp' };
}

describe('Dead letter cleanup', () => {
  let db: Database;
  let store: PendingMessageStore;
  let sessionDbId: number;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
    store = new PendingMessageStore(db, 3);
    sessionDbId = createSDKSession(db, 'cs-1', 'test', 'prompt');
  });

  afterEach(() => { db.close(); });

  describe('cleanupDeadLetters', () => {
    it('deletes failed messages with retry_count >= 3', () => {
      const id = store.enqueue(sessionDbId, 'cs-1', makeObs());
      db.prepare('UPDATE pending_messages SET status = ?, retry_count = ?, failed_at_epoch = ? WHERE id = ?')
        .run('failed', 3, Date.now(), id);

      expect(store.cleanupDeadLetters()).toBe(1);
      expect((db.prepare('SELECT COUNT(*) as cnt FROM pending_messages').get() as any).cnt).toBe(0);
    });

    it('deletes legacy failed messages older than 24h (retry_count=0)', () => {
      const id = store.enqueue(sessionDbId, 'cs-1', makeObs());
      const old = Date.now() - 25 * 60 * 60 * 1000;
      db.prepare('UPDATE pending_messages SET status = ?, retry_count = 0, failed_at_epoch = ? WHERE id = ?')
        .run('failed', old, id);

      expect(store.cleanupDeadLetters()).toBe(1);
    });

    it('preserves recent failed messages with retry_count < 3', () => {
      const id = store.enqueue(sessionDbId, 'cs-1', makeObs());
      db.prepare('UPDATE pending_messages SET status = ?, retry_count = 1, failed_at_epoch = ? WHERE id = ?')
        .run('failed', Date.now(), id);

      expect(store.cleanupDeadLetters()).toBe(0);
      expect((db.prepare('SELECT COUNT(*) as cnt FROM pending_messages').get() as any).cnt).toBe(1);
    });

    it('does not touch pending or processing messages', () => {
      store.enqueue(sessionDbId, 'cs-1', makeObs());
      expect(store.cleanupDeadLetters()).toBe(0);
    });
  });

  describe('cleanupOrphanMessages', () => {
    it('deletes failed messages for non-existent sessions', () => {
      const id = store.enqueue(sessionDbId, 'cs-1', makeObs());
      db.prepare('UPDATE pending_messages SET status = ? WHERE id = ?').run('failed', id);
      // Delete the session to create an orphan
      db.run('PRAGMA foreign_keys = OFF');
      db.prepare('DELETE FROM sdk_sessions WHERE id = ?').run(sessionDbId);
      db.run('PRAGMA foreign_keys = ON');

      expect(store.cleanupOrphanMessages()).toBe(1);
    });

    it('preserves failed messages for existing sessions', () => {
      const id = store.enqueue(sessionDbId, 'cs-1', makeObs());
      db.prepare('UPDATE pending_messages SET status = ? WHERE id = ?').run('failed', id);

      expect(store.cleanupOrphanMessages()).toBe(0);
    });
  });
});
