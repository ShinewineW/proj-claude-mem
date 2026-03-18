/**
 * PendingMessageStore — per-message retry behavior in failure handlers
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { PendingMessageStore } from '../../src/services/sqlite/PendingMessageStore.js';
import { createSDKSession } from '../../src/services/sqlite/Sessions.js';
import type { Database } from 'bun:sqlite';
import type { PendingMessage } from '../../src/services/worker-types.js';

function makeObservation(overrides: Partial<PendingMessage> = {}): PendingMessage {
  return { type: 'observation', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { content: 'ok' }, cwd: '/tmp', ...overrides };
}

describe('PendingMessageStore — retry behavior', () => {
  let db: Database;
  let store: PendingMessageStore;
  let sessionDbId: number;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
    store = new PendingMessageStore(db, 3);
    sessionDbId = createSDKSession(db, 'cs-1', 'test-project', 'prompt');
  });

  afterEach(() => { db.close(); });

  // Helper: enqueue + force status/retry_count
  function enqueueWithState(status: string, retryCount: number): number {
    const id = store.enqueue(sessionDbId, 'cs-1', makeObservation());
    db.prepare('UPDATE pending_messages SET status = ?, retry_count = ? WHERE id = ?').run(status, retryCount, id);
    return id;
  }

  describe('markSessionMessagesFailed (processing messages)', () => {
    it('retries messages with retry_count < 3', () => {
      const id = enqueueWithState('processing', 0);
      const result = store.markSessionMessagesFailed(sessionDbId);
      expect(result.retried).toBe(1);
      expect(result.failed).toBe(0);
      const msg = db.prepare('SELECT status, retry_count FROM pending_messages WHERE id = ?').get(id) as any;
      expect(msg.status).toBe('pending');
      expect(msg.retry_count).toBe(1);
    });

    it('permanently fails messages at retry_count >= 3', () => {
      const id = enqueueWithState('processing', 3);
      const result = store.markSessionMessagesFailed(sessionDbId);
      expect(result.retried).toBe(0);
      expect(result.failed).toBe(1);
      const msg = db.prepare('SELECT status, failed_at_epoch FROM pending_messages WHERE id = ?').get(id) as any;
      expect(msg.status).toBe('failed');
      expect(msg.failed_at_epoch).toBeGreaterThan(0);
    });

    it('handles mixed retry counts', () => {
      enqueueWithState('processing', 0);
      enqueueWithState('processing', 2);
      enqueueWithState('processing', 3);
      const result = store.markSessionMessagesFailed(sessionDbId);
      expect(result.retried).toBe(2);
      expect(result.failed).toBe(1);
    });

    it('only affects processing messages for this session', () => {
      enqueueWithState('pending', 0);  // pending — not touched
      enqueueWithState('processing', 0);  // processing — retried
      const other = createSDKSession(db, 'cs-2', 'test', 'p');
      const otherId = store.enqueue(other, 'cs-2', makeObservation());
      db.prepare('UPDATE pending_messages SET status = ? WHERE id = ?').run('processing', otherId);

      const result = store.markSessionMessagesFailed(sessionDbId);
      expect(result.retried).toBe(1);  // only our session
      const otherMsg = db.prepare('SELECT status FROM pending_messages WHERE id = ?').get(otherId) as any;
      expect(otherMsg.status).toBe('processing');  // untouched
    });
  });

  describe('markAllSessionMessagesAbandoned (pending + processing)', () => {
    it('retries both pending and processing messages with retry_count < 3', () => {
      enqueueWithState('pending', 1);
      enqueueWithState('processing', 0);
      const result = store.markAllSessionMessagesAbandoned(sessionDbId);
      expect(result.retried).toBe(2);
      expect(result.failed).toBe(0);
    });

    it('permanently fails messages at retry_count >= 3', () => {
      enqueueWithState('pending', 3);
      enqueueWithState('processing', 3);
      const result = store.markAllSessionMessagesAbandoned(sessionDbId);
      expect(result.retried).toBe(0);
      expect(result.failed).toBe(2);
    });

    it('does not touch already-failed messages', () => {
      enqueueWithState('failed', 0);
      const result = store.markAllSessionMessagesAbandoned(sessionDbId);
      expect(result.retried).toBe(0);
      expect(result.failed).toBe(0);
    });
  });

  describe('markFailed — pre-existing bug fix', () => {
    it('uses failed_at_epoch (not completed_at_epoch) for terminal failure', () => {
      const id = enqueueWithState('processing', 3);
      store.markFailed(id);
      const msg = db.prepare('SELECT failed_at_epoch, completed_at_epoch FROM pending_messages WHERE id = ?').get(id) as any;
      expect(msg.failed_at_epoch).toBeGreaterThan(0);
      expect(msg.completed_at_epoch).toBeNull();
    });
  });
});
