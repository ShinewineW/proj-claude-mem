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

describe('PendingMessageStore.getPendingObservationCountUpToPrompt', () => {
  it('counts same-turn observations (prompt_number <= target)', () => {
    const { pending, sessionDbId } = setupStore();
    pending.enqueue(sessionDbId, 'test-content-session-id', {
      type: 'observation', tool_name: 'Read', tool_input: '{}', tool_response: '{}', prompt_number: 1, cwd: '/tmp',
    });
    pending.enqueue(sessionDbId, 'test-content-session-id', {
      type: 'observation', tool_name: 'Bash', tool_input: '{}', tool_response: '{}', prompt_number: 1, cwd: '/tmp',
    });
    expect(pending.getPendingObservationCountUpToPrompt(sessionDbId, 1, Date.now())).toBe(2);
  });

  it('excludes future-turn observations (prompt_number > target)', () => {
    const { pending, sessionDbId } = setupStore();
    pending.enqueue(sessionDbId, 'test-content-session-id', {
      type: 'observation', tool_name: 'Read', tool_input: '{}', tool_response: '{}', prompt_number: 1, cwd: '/tmp',
    });
    pending.enqueue(sessionDbId, 'test-content-session-id', {
      type: 'observation', tool_name: 'Bash', tool_input: '{}', tool_response: '{}', prompt_number: 2, cwd: '/tmp',
    });
    expect(pending.getPendingObservationCountUpToPrompt(sessionDbId, 1, Date.now())).toBe(1);
  });

  it('legacy NULL prompt_number rows only included if created_at_epoch <= queuedAtEpoch', () => {
    const { db, pending, sessionDbId } = setupStore();
    const earlyId = pending.enqueue(sessionDbId, 'test-content-session-id', {
      type: 'observation', tool_name: 'Read', tool_input: '{}', tool_response: '{}', prompt_number: 1, cwd: '/tmp',
    });
    db.prepare(`UPDATE pending_messages SET prompt_number=NULL WHERE id=?`).run(earlyId);
    const earlyEpoch = Date.now() - 10_000;
    db.prepare(`UPDATE pending_messages SET created_at_epoch=? WHERE id=?`).run(earlyEpoch, earlyId);

    expect(pending.getPendingObservationCountUpToPrompt(sessionDbId, 1, earlyEpoch + 1000)).toBe(1);
    expect(pending.getPendingObservationCountUpToPrompt(sessionDbId, 1, earlyEpoch - 1000)).toBe(0);
  });

  it('does not count summarize rows', () => {
    const { pending, sessionDbId } = setupStore();
    pending.enqueue(sessionDbId, 'test-content-session-id', {
      type: 'summarize', last_assistant_message: 'x', prompt_number: 1,
    });
    expect(pending.getPendingObservationCountUpToPrompt(sessionDbId, 1, Date.now())).toBe(0);
  });
});

describe('PendingMessageStore.markFailed return shape', () => {
  it('returns {finalStatus: "pending", retryCount: 1} on first failure when maxRetries=3', () => {
    const { pending, sessionDbId } = setupStore();
    const id = pending.enqueue(sessionDbId, 'test-content-session-id', {
      type: 'summarize', last_assistant_message: 'x', prompt_number: 1,
    });
    pending.claimNextSummarize();
    const result = pending.markFailed(id);
    expect(result).toEqual({ finalStatus: 'pending', retryCount: 1 });
  });

  it('returns {finalStatus: "failed", retryCount: 3} when max retries exhausted', () => {
    // maxRetries=3 means retry_count<3 → pending. After 3 incrementing calls
    // retry_count=3, the 4th markFailed enters the `else` branch and dead-letters.
    const { pending, sessionDbId } = setupStore();
    const id = pending.enqueue(sessionDbId, 'test-content-session-id', {
      type: 'summarize', last_assistant_message: 'x', prompt_number: 1,
    });
    pending.claimNextSummarize();
    expect(pending.markFailed(id)).toEqual({ finalStatus: 'pending', retryCount: 1 });
    pending.claimNextSummarize();
    expect(pending.markFailed(id)).toEqual({ finalStatus: 'pending', retryCount: 2 });
    pending.claimNextSummarize();
    expect(pending.markFailed(id)).toEqual({ finalStatus: 'pending', retryCount: 3 });
    pending.claimNextSummarize();
    const finalResult = pending.markFailed(id);
    expect(finalResult.finalStatus).toBe('failed');
    expect(finalResult.retryCount).toBe(3);
  });

  it('returns {finalStatus: "failed", retryCount: 0} when message id does not exist', () => {
    const { pending } = setupStore();
    const result = pending.markFailed(999_999);
    expect(result).toEqual({ finalStatus: 'failed', retryCount: 0 });
  });
});

describe('PendingMessageStore.resetStaleObservationProcessing', () => {
  it('resets observation rows stale >60s back to pending', () => {
    const { db, pending, sessionDbId } = setupStore();
    const id = pending.enqueue(sessionDbId, 'test-content-session-id', {
      type: 'observation', tool_name: 'Bash', tool_input: '{}', tool_response: '{}', prompt_number: 1, cwd: '/tmp',
    });
    const oldEpoch = Date.now() - 70_000;
    db.prepare(`UPDATE pending_messages SET status='processing', started_processing_at_epoch=? WHERE id=?`)
      .run(oldEpoch, id);

    pending.resetStaleObservationProcessing(sessionDbId);

    const row = db.prepare(`SELECT status FROM pending_messages WHERE id=?`).get(id) as { status: string };
    expect(row.status).toBe('pending');
  });

  it('does not reset summarize rows (strict type scope)', () => {
    const { db, pending, sessionDbId } = setupStore();
    const id = pending.enqueue(sessionDbId, 'test-content-session-id', {
      type: 'summarize', last_assistant_message: 'x', prompt_number: 1,
    });
    const oldEpoch = Date.now() - 70_000;
    db.prepare(`UPDATE pending_messages SET status='processing', started_processing_at_epoch=? WHERE id=?`)
      .run(oldEpoch, id);

    pending.resetStaleObservationProcessing(sessionDbId);

    const row = db.prepare(`SELECT status FROM pending_messages WHERE id=?`).get(id) as { status: string };
    expect(row.status).toBe('processing');
  });

  it('does not reset rows from other sessions', () => {
    const { db, pending } = setupStore();
    const otherSession = createSDKSession(db, 'cs-other', 'proj-other', 'p');
    const id = pending.enqueue(otherSession, 'cs-other', {
      type: 'observation', tool_name: 'Bash', tool_input: '{}', tool_response: '{}', prompt_number: 1, cwd: '/tmp',
    });
    db.prepare(`UPDATE pending_messages SET status='processing', started_processing_at_epoch=? WHERE id=?`)
      .run(Date.now() - 70_000, id);

    pending.resetStaleObservationProcessing(999);

    const row = db.prepare(`SELECT status FROM pending_messages WHERE id=?`).get(id) as { status: string };
    expect(row.status).toBe('processing');
  });
});

describe('PendingMessageStore observation-only helpers', () => {
  it('markSessionObservationMessagesAbandoned only fails observation rows', () => {
    const { db, pending, sessionDbId } = setupStore();
    const obsId = pending.enqueue(sessionDbId, 'test-content-session-id', {
      type: 'observation', tool_name: 'Bash', tool_input: '{}', tool_response: '{}', prompt_number: 1, cwd: '/tmp',
    });
    const sumId = pending.enqueue(sessionDbId, 'test-content-session-id', {
      type: 'summarize', last_assistant_message: 'x', prompt_number: 1,
    });

    const result = pending.markSessionObservationMessagesAbandoned(sessionDbId);
    expect(result.failed).toBe(1);

    const obs = db.prepare(`SELECT status FROM pending_messages WHERE id=?`).get(obsId) as { status: string };
    const sum = db.prepare(`SELECT status FROM pending_messages WHERE id=?`).get(sumId) as { status: string };
    expect(obs.status).toBe('failed');
    expect(sum.status).toBe('pending');
  });

  it('getSessionsWithPendingObservations returns only sessions with observation work', () => {
    const { db, pending, sessionDbId } = setupStore();
    const otherSession = createSDKSession(db, 'cs-other', 'proj-other', 'p');
    pending.enqueue(sessionDbId, 'test-content-session-id', {
      type: 'observation', tool_name: 'Bash', tool_input: '{}', tool_response: '{}', prompt_number: 1, cwd: '/tmp',
    });
    pending.enqueue(otherSession, 'cs-other', {
      type: 'summarize', last_assistant_message: 'x', prompt_number: 1,
    });

    const ids = pending.getSessionsWithPendingObservations();
    expect(ids).toContain(sessionDbId);
    expect(ids).not.toContain(otherSession);
  });
});
