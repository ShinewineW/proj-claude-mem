/**
 * PendingMessageStore — hasPendingSummarize() and markOrphanedSummarizesFailed() tests
 *
 * Uses ClaudeMemDatabase(':memory:') for in-memory schema setup (auto-runs all migrations).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { PendingMessageStore } from '../../src/services/sqlite/PendingMessageStore.js';
import { createSDKSession } from '../../src/services/sqlite/Sessions.js';
import type { Database } from 'bun:sqlite';
import type { PendingMessage } from '../../src/services/worker-types.js';

function makeSummarizeMessage(overrides: Partial<PendingMessage> = {}): PendingMessage {
  return {
    type: 'summarize',
    cwd: '/tmp/test',
    ...overrides,
  };
}

function makeObservationMessage(overrides: Partial<PendingMessage> = {}): PendingMessage {
  return {
    type: 'observation',
    tool_name: 'Write',
    tool_input: { file_path: '/tmp/test.ts' },
    tool_response: { content: 'ok' },
    cwd: '/tmp/test',
    ...overrides,
  };
}

describe('PendingMessageStore — Summarize Query Methods', () => {
  let db: Database;
  let store: PendingMessageStore;
  let sessionDbId1: number;
  let sessionDbId2: number;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
    store = new PendingMessageStore(db);

    // Create two sessions for testing
    sessionDbId1 = createSDKSession(db, 'content-1', 'test-project', 'prompt 1');
    sessionDbId2 = createSDKSession(db, 'content-2', 'test-project', 'prompt 2');
  });

  afterEach(() => {
    db.close();
  });

  describe('hasPendingSummarize()', () => {
    it('should return false when no messages exist', () => {
      expect(store.hasPendingSummarize(sessionDbId1)).toBe(false);
    });

    it('should return true when a pending summarize exists', () => {
      store.enqueue(sessionDbId1, 'content-1', makeSummarizeMessage());
      expect(store.hasPendingSummarize(sessionDbId1)).toBe(true);
    });

    it('should return false when summarize is already claimed (processing)', () => {
      store.enqueue(sessionDbId1, 'content-1', makeSummarizeMessage());
      // Claim to move to 'processing' — generator owns it now
      store.claimNextMessage(sessionDbId1);
      expect(store.hasPendingSummarize(sessionDbId1)).toBe(false);
    });

    it('should return false when only observation messages exist', () => {
      store.enqueue(sessionDbId1, 'content-1', makeObservationMessage());
      expect(store.hasPendingSummarize(sessionDbId1)).toBe(false);
    });

    it('should return false after summarize is confirmed processed', () => {
      const msgId = store.enqueue(sessionDbId1, 'content-1', makeSummarizeMessage());
      store.claimNextMessage(sessionDbId1);
      store.confirmProcessed(msgId);
      expect(store.hasPendingSummarize(sessionDbId1)).toBe(false);
    });

    it('should not see summarizes from other sessions', () => {
      store.enqueue(sessionDbId2, 'content-2', makeSummarizeMessage());
      expect(store.hasPendingSummarize(sessionDbId1)).toBe(false);
      expect(store.hasPendingSummarize(sessionDbId2)).toBe(true);
    });
  });

  describe('markOrphanedSummarizesFailed()', () => {
    it('should return 0 when no messages exist', () => {
      const count = store.markOrphanedSummarizesFailed([]);
      expect(count).toBe(0);
    });

    it('should mark stale orphaned summarizes as failed when no active sessions', () => {
      // Insert a summarize with old timestamp by directly setting created_at_epoch
      store.enqueue(sessionDbId1, 'content-1', makeSummarizeMessage());
      // Backdate the message to make it stale (10 minutes ago)
      const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
      db.run('UPDATE pending_messages SET created_at_epoch = ?', [tenMinutesAgo]);

      const count = store.markOrphanedSummarizesFailed([]);
      expect(count).toBe(1);

      // Verify it's actually failed
      expect(store.hasPendingSummarize(sessionDbId1)).toBe(false);
    });

    it('should not mark recent summarizes as failed (within threshold)', () => {
      // Message was just created — within the 5-minute default threshold
      store.enqueue(sessionDbId1, 'content-1', makeSummarizeMessage());

      const count = store.markOrphanedSummarizesFailed([]);
      expect(count).toBe(0);

      // Still pending
      expect(store.hasPendingSummarize(sessionDbId1)).toBe(true);
    });

    it('should not mark summarizes for active sessions as failed', () => {
      store.enqueue(sessionDbId1, 'content-1', makeSummarizeMessage());
      // Backdate to make it stale
      const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
      db.run('UPDATE pending_messages SET created_at_epoch = ?', [tenMinutesAgo]);

      // sessionDbId1 is still active
      const count = store.markOrphanedSummarizesFailed([sessionDbId1]);
      expect(count).toBe(0);

      // Still pending
      expect(store.hasPendingSummarize(sessionDbId1)).toBe(true);
    });

    it('should mark stale summarizes for inactive sessions only', () => {
      // Enqueue for both sessions
      store.enqueue(sessionDbId1, 'content-1', makeSummarizeMessage());
      store.enqueue(sessionDbId2, 'content-2', makeSummarizeMessage());
      // Backdate both
      const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
      db.run('UPDATE pending_messages SET created_at_epoch = ?', [tenMinutesAgo]);

      // Only sessionDbId1 is active
      const count = store.markOrphanedSummarizesFailed([sessionDbId1]);
      expect(count).toBe(1);

      // session 1 still has its summarize, session 2 does not
      expect(store.hasPendingSummarize(sessionDbId1)).toBe(true);
      expect(store.hasPendingSummarize(sessionDbId2)).toBe(false);
    });

    it('should not mark observation messages as failed', () => {
      store.enqueue(sessionDbId1, 'content-1', makeObservationMessage());
      // Backdate
      const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
      db.run('UPDATE pending_messages SET created_at_epoch = ?', [tenMinutesAgo]);

      const count = store.markOrphanedSummarizesFailed([]);
      expect(count).toBe(0);
    });

    it('should respect custom staleThresholdMs', () => {
      store.enqueue(sessionDbId1, 'content-1', makeSummarizeMessage());
      // Backdate to 2 minutes ago
      const twoMinutesAgo = Date.now() - 2 * 60 * 1000;
      db.run('UPDATE pending_messages SET created_at_epoch = ?', [twoMinutesAgo]);

      // With 1-minute threshold, it should be stale
      const count1 = store.markOrphanedSummarizesFailed([], 1 * 60 * 1000);
      expect(count1).toBe(1);
    });

    it('should handle processing summarizes as orphans too', () => {
      store.enqueue(sessionDbId1, 'content-1', makeSummarizeMessage());
      // Claim to move to 'processing'
      store.claimNextMessage(sessionDbId1);
      // Backdate
      const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
      db.run('UPDATE pending_messages SET created_at_epoch = ?', [tenMinutesAgo]);

      const count = store.markOrphanedSummarizesFailed([]);
      expect(count).toBe(1);
      expect(store.hasPendingSummarize(sessionDbId1)).toBe(false);
    });

    it('should set failed_at_epoch on marked messages', () => {
      store.enqueue(sessionDbId1, 'content-1', makeSummarizeMessage());
      const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
      db.run('UPDATE pending_messages SET created_at_epoch = ?', [tenMinutesAgo]);

      const before = Date.now();
      store.markOrphanedSummarizesFailed([]);
      const after = Date.now();

      const row = db.prepare('SELECT failed_at_epoch, status FROM pending_messages WHERE session_db_id = ?')
        .get(sessionDbId1) as { failed_at_epoch: number; status: string };
      expect(row.status).toBe('failed');
      expect(row.failed_at_epoch).toBeGreaterThanOrEqual(before);
      expect(row.failed_at_epoch).toBeLessThanOrEqual(after);
    });
  });
});
