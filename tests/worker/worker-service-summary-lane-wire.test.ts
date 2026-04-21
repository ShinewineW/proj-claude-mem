import { describe, it, expect } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { PendingMessageStore } from '../../src/services/sqlite/PendingMessageStore.js';
import { createSDKSession } from '../../src/services/sqlite/Sessions.js';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('worker-service abandon-site triage', () => {
  it('ghost session cleanup preserves summarize rows (observation-only abandon)', () => {
    const db = new ClaudeMemDatabase(':memory:').db;
    const pending = new PendingMessageStore(db, 3);
    const sessionDbId = createSDKSession(db, 'cs', 'proj', 'p');
    const obsId = pending.enqueue(sessionDbId, 'cs', {
      type: 'observation', tool_name: 'Bash', tool_input: '{}', tool_response: '{}', prompt_number: 1, cwd: '/tmp',
    });
    const sumId = pending.enqueue(sessionDbId, 'cs', {
      type: 'summarize', last_assistant_message: 'x', prompt_number: 1,
    });

    const r = pending.markSessionObservationMessagesAbandoned(sessionDbId);
    expect(r.failed).toBe(1);

    const obs = db.prepare(`SELECT status FROM pending_messages WHERE id=?`).get(obsId) as { status: string };
    const sum = db.prepare(`SELECT status FROM pending_messages WHERE id=?`).get(sumId) as { status: string };
    expect(obs.status).toBe('failed');
    expect(sum.status).toBe('pending');
  });

  it('processPendingQueues orphan collection is observation-only (static check)', () => {
    // Source-level check: worker-service.ts must call getSessionsWithPendingObservations
    // (not the all-types variant) when collecting orphans for startup recovery.
    const srcPath = join(import.meta.dir, '..', '..', 'src', 'services', 'worker-service.ts');
    const src = readFileSync(srcPath, 'utf-8');
    expect(src).toContain('getSessionsWithPendingObservations()');
  });

  it('processPendingQueues orphan collection: sessions with only summarize backlog are skipped', () => {
    const db = new ClaudeMemDatabase(':memory:').db;
    const pending = new PendingMessageStore(db, 3);
    const sessionDbId = createSDKSession(db, 'cs', 'proj', 'p');
    pending.enqueue(sessionDbId, 'cs', {
      type: 'summarize', last_assistant_message: 'x', prompt_number: 1,
    });
    // No observation rows.
    const ids = pending.getSessionsWithPendingObservations();
    expect(ids).not.toContain(sessionDbId);
  });
});
