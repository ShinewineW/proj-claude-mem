/**
 * PendingMessageStore.claimNextObservation — bypass-lane-specific claim
 * P1a: Only claims observation messages, no self-healing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { PendingMessageStore } from '../../src/services/sqlite/PendingMessageStore.js';
import { createSDKSession } from '../../src/services/sqlite/Sessions.js';
import type { Database } from 'bun:sqlite';
import type { PendingMessage } from '../../src/services/worker-types.js';

function makeMessage(type: 'observation' | 'summarize', overrides: Partial<PendingMessage> = {}): PendingMessage {
  return { type, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { content: 'ok' }, cwd: '/tmp', ...overrides };
}

describe('PendingMessageStore.claimNextObservation', () => {
  let db: Database;
  let store: PendingMessageStore;
  let sessionDbId: number;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
    store = new PendingMessageStore(db, 3);
    sessionDbId = createSDKSession(db, 'cs-1', 'test-project', 'prompt');
  });

  afterEach(() => { db.close(); });

  it('claims observation messages and marks as processing', () => {
    const id = store.enqueue(sessionDbId, 'cs-1', makeMessage('observation'));
    const msg = store.claimNextObservation(sessionDbId);
    expect(msg).not.toBeNull();
    expect(msg!.message_type).toBe('observation');
    // Verify DB state is updated to processing
    const dbMsg = db.prepare('SELECT status FROM pending_messages WHERE id = ?').get(id) as any;
    expect(dbMsg.status).toBe('processing');
  });

  it('never claims summarize messages', () => {
    store.enqueue(sessionDbId, 'cs-1', makeMessage('summarize'));
    const msg = store.claimNextObservation(sessionDbId);
    expect(msg).toBeNull();
  });

  it('skips summarize and claims observation when both queued', () => {
    store.enqueue(sessionDbId, 'cs-1', makeMessage('summarize'));
    const obsId = store.enqueue(sessionDbId, 'cs-1', makeMessage('observation'));
    const msg = store.claimNextObservation(sessionDbId);
    expect(msg).not.toBeNull();
    expect(msg!.id).toBe(obsId);
    expect(msg!.message_type).toBe('observation');
  });

  it('does NOT reset stale processing messages (no self-healing)', () => {
    // Enqueue and force to stale processing state (>60s old)
    const id = store.enqueue(sessionDbId, 'cs-1', makeMessage('observation'));
    const staleEpoch = Date.now() - 120_000; // 2 minutes ago
    db.prepare('UPDATE pending_messages SET status = ?, started_processing_at_epoch = ? WHERE id = ?')
      .run('processing', staleEpoch, id);

    // Enqueue a fresh observation
    store.enqueue(sessionDbId, 'cs-1', makeMessage('observation'));

    // claimNextObservation should NOT reset the stale message
    const claimed = store.claimNextObservation(sessionDbId);
    expect(claimed).not.toBeNull();

    // Stale message should still be 'processing' (not reset to 'pending')
    const staleMsg = db.prepare('SELECT status FROM pending_messages WHERE id = ?').get(id) as any;
    expect(staleMsg.status).toBe('processing');
  });

  it('returns null on empty queue', () => {
    const msg = store.claimNextObservation(sessionDbId);
    expect(msg).toBeNull();
  });

  it('only claims for the specified session', () => {
    const otherSession = createSDKSession(db, 'cs-2', 'other', 'prompt');
    store.enqueue(otherSession, 'cs-2', makeMessage('observation'));
    const msg = store.claimNextObservation(sessionDbId);
    expect(msg).toBeNull();
  });
});
