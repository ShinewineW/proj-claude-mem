import { describe, it, expect } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { PendingMessageStore } from '../../src/services/sqlite/PendingMessageStore.js';
import { createSDKSession } from '../../src/services/sqlite/Sessions.js';

function setupStore(): { db: Database; pending: PendingMessageStore; sessionDbId: number } {
  const db = new ClaudeMemDatabase(':memory:').db;
  const pending = new PendingMessageStore(db, 3);
  const sessionDbId = createSDKSession(db, 'test-content-session-id', 'test-project', 'hello');
  return { db, pending, sessionDbId };
}

describe('PendingMessageStore.claimNextSummarize', () => {
  it('claims a pending summarize row and marks it processing', () => {
    const { pending, sessionDbId } = setupStore();
    const id = pending.enqueue(sessionDbId, 'test-content-session-id', {
      type: 'summarize',
      last_assistant_message: 'hello world',
      prompt_number: 1,
    });
    expect(id).toBeGreaterThan(0);

    const claimed = pending.claimNextSummarize();
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(id);
    expect(claimed!.message_type).toBe('summarize');
    expect(claimed!.status).toBe('processing');
  });

  it('returns null when no summarize rows are pending', () => {
    const { pending } = setupStore();
    expect(pending.claimNextSummarize()).toBeNull();
  });

  it('never returns observation rows', () => {
    const { pending, sessionDbId } = setupStore();
    pending.enqueue(sessionDbId, 'test-content-session-id', {
      type: 'observation',
      tool_name: 'Bash',
      tool_input: '{}',
      tool_response: '{}',
      prompt_number: 1,
      cwd: '/tmp',
    });
    expect(pending.claimNextSummarize()).toBeNull();
  });

  it('recovers processing rows stale > 60s (stale cutoff reset)', async () => {
    const { db, pending, sessionDbId } = setupStore();
    const id = pending.enqueue(sessionDbId, 'test-content-session-id', {
      type: 'summarize',
      last_assistant_message: 'stale',
      prompt_number: 1,
    });
    const oldEpoch = Date.now() - 70_000;
    db.prepare(`
      UPDATE pending_messages
      SET status='processing', started_processing_at_epoch=?
      WHERE id=?
    `).run(oldEpoch, id);

    const claimed = pending.claimNextSummarize();
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(id);
    expect(claimed!.status).toBe('processing');
  });

  it('claims FIFO by id ASC across sessions (global ordering)', () => {
    const { db, pending } = setupStore();
    const sessionA = createSDKSession(db, 'cs-a', 'proj-a', 'prompt-a');
    const sessionB = createSDKSession(db, 'cs-b', 'proj-b', 'prompt-b');
    const idA = pending.enqueue(sessionA, 'cs-a', {
      type: 'summarize',
      last_assistant_message: 'A',
      prompt_number: 1,
    });
    const idB = pending.enqueue(sessionB, 'cs-b', {
      type: 'summarize',
      last_assistant_message: 'B',
      prompt_number: 1,
    });
    expect(pending.claimNextSummarize()!.id).toBe(idA);
    expect(pending.claimNextSummarize()!.id).toBe(idB);
  });
});
