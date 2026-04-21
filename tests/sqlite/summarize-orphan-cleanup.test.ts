import { describe, it, expect } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { PendingMessageStore } from '../../src/services/sqlite/PendingMessageStore.js';
import { createSDKSession } from '../../src/services/sqlite/Sessions.js';

function setup() {
  const db = new ClaudeMemDatabase(':memory:').db;
  const pending = new PendingMessageStore(db, 3);
  return { db, pending };
}

describe('PendingMessageStore.markTrulyOrphanedSummarizesFailed', () => {
  it('preserves summarize rows for completed sessions (not orphans)', () => {
    const { db, pending } = setup();
    const sessionDbId = createSDKSession(db, 'cs', 'proj', 'p');
    db.prepare(`UPDATE sdk_sessions SET status='completed' WHERE id=?`).run(sessionDbId);
    const msgId = pending.enqueue(sessionDbId, 'cs', {
      type: 'summarize', last_assistant_message: 'x', prompt_number: 1,
    });
    db.prepare(`UPDATE pending_messages SET created_at_epoch=? WHERE id=?`).run(Date.now() - 10 * 60_000, msgId);

    const affected = pending.markTrulyOrphanedSummarizesFailed();
    expect(affected).toBe(0);

    const row = db.prepare(`SELECT status FROM pending_messages WHERE id=?`).get(msgId) as { status: string };
    expect(row.status).toBe('pending');
  });

  it('fails summarize rows where session row is missing', () => {
    const { db, pending } = setup();
    const sessionDbId = createSDKSession(db, 'cs', 'proj', 'p');
    const msgId = pending.enqueue(sessionDbId, 'cs', {
      type: 'summarize', last_assistant_message: 'x', prompt_number: 1,
    });
    db.prepare(`UPDATE pending_messages SET created_at_epoch=? WHERE id=?`).run(Date.now() - 10 * 60_000, msgId);
    db.run('PRAGMA foreign_keys = OFF');
    db.prepare(`DELETE FROM sdk_sessions WHERE id=?`).run(sessionDbId);
    db.run('PRAGMA foreign_keys = ON');

    const affected = pending.markTrulyOrphanedSummarizesFailed();
    expect(affected).toBe(1);
  });

  it('fails summarize rows where session status=failed', () => {
    const { db, pending } = setup();
    const sessionDbId = createSDKSession(db, 'cs', 'proj', 'p');
    db.prepare(`UPDATE sdk_sessions SET status='failed' WHERE id=?`).run(sessionDbId);
    const msgId = pending.enqueue(sessionDbId, 'cs', {
      type: 'summarize', last_assistant_message: 'x', prompt_number: 1,
    });
    db.prepare(`UPDATE pending_messages SET created_at_epoch=? WHERE id=?`).run(Date.now() - 10 * 60_000, msgId);

    const affected = pending.markTrulyOrphanedSummarizesFailed();
    expect(affected).toBe(1);
  });

  it('respects the staleness threshold — fresh summarize rows are never orphaned', () => {
    const { db, pending } = setup();
    const sessionDbId = createSDKSession(db, 'cs', 'proj', 'p');
    pending.enqueue(sessionDbId, 'cs', {
      type: 'summarize', last_assistant_message: 'x', prompt_number: 1,
    });
    // Row is fresh (created_at_epoch now). Now delete the session to make it orphan-by-missing-row.
    db.run('PRAGMA foreign_keys = OFF');
    db.prepare(`DELETE FROM sdk_sessions WHERE id=?`).run(sessionDbId);
    db.run('PRAGMA foreign_keys = ON');

    const affected = pending.markTrulyOrphanedSummarizesFailed();
    // Staleness threshold (default 5 min) — fresh row not old enough to orphan.
    expect(affected).toBe(0);
  });
});
