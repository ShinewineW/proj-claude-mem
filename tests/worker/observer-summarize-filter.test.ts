import { describe, it, expect } from 'bun:test';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { PendingMessageStore } from '../../src/services/sqlite/PendingMessageStore.js';
import { SessionQueueProcessor } from '../../src/services/queue/SessionQueueProcessor.js';
import { createSDKSession } from '../../src/services/sqlite/Sessions.js';

function setup() {
  const db = new ClaudeMemDatabase(':memory:').db;
  const pending = new PendingMessageStore(db, 3);
  const sessionDbId = createSDKSession(db, 'cs', 'proj', 'p');
  const events = new EventEmitter();
  const processor = new SessionQueueProcessor(pending, events);
  return { db, pending, sessionDbId, processor, events };
}

describe('Observer claim chain is observation-only', () => {
  it('processor iterator skips summarize rows and yields observations', async () => {
    const { pending, sessionDbId, processor } = setup();
    pending.enqueue(sessionDbId, 'cs', {
      type: 'summarize', last_assistant_message: 'x', prompt_number: 1,
    });
    pending.enqueue(sessionDbId, 'cs', {
      type: 'observation', tool_name: 'Bash', tool_input: '{}', tool_response: '{}', prompt_number: 1, cwd: '/tmp',
    });

    const ac = new AbortController();
    const iter = processor.createIterator({ sessionDbId, signal: ac.signal });
    const first = await iter.next();
    ac.abort();
    expect(first.done).toBe(false);
    expect(first.value?.type).toBe('observation');
  });

  it('stale observation processing rows get reset on each claim loop', () => {
    const { db, pending, sessionDbId } = setup();
    const id = pending.enqueue(sessionDbId, 'cs', {
      type: 'observation', tool_name: 'Bash', tool_input: '{}', tool_response: '{}', prompt_number: 1, cwd: '/tmp',
    });
    db.prepare(`UPDATE pending_messages SET status='processing', started_processing_at_epoch=? WHERE id=?`)
      .run(Date.now() - 70_000, id);

    pending.resetStaleObservationProcessing(sessionDbId);
    const row = db.prepare(`SELECT status FROM pending_messages WHERE id=?`).get(id) as { status: string };
    expect(row.status).toBe('pending');
  });
});

describe('SDKAgent no longer has summarize type branch', () => {
  const sdkAgentSource = (() => {
    const p = join(import.meta.dir, '..', '..', 'src', 'services', 'worker', 'SDKAgent.ts');
    return readFileSync(p, 'utf-8');
  })();

  it('createMessageGenerator source does not reference message.type === "summarize"', () => {
    expect(sdkAgentSource).not.toMatch(/message\.type\s*===\s*['"]summarize['"]/);
  });

  it('source does not contain "Dropping legacy summarize" log string', () => {
    expect(sdkAgentSource).not.toContain('Dropping legacy summarize');
  });
});
