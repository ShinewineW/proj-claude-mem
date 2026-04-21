/**
 * Security hardening F3: lastAssistantMessage length cap in queueSummarize.
 *
 * A crafted hook call can pass an arbitrarily long `last_assistant_message`
 * which is then stored in pending_messages and later embedded into the
 * fresh-query prompt verbatim. Unbounded length = memory pressure on
 * (a) the DB, (b) the fresh Claude subprocess prompt, and a straightforward
 * DoS vector. Cap at a generous threshold (64KB) with tail-preserving
 * truncation so the recent assistant context — the part that actually
 * matters for summarization — is retained.
 */

import { describe, it, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { PendingMessageStore } from '../../src/services/sqlite/PendingMessageStore.js';
import { logger } from '../../src/utils/logger.js';
import {
  MAX_LAST_ASSISTANT_MESSAGE_CHARS,
  LAST_ASSISTANT_MESSAGE_TRUNCATION_MARKER,
} from '../../src/services/worker/SessionManager.js';

function setup() {
  const sessionStore = new SessionStore(':memory:');
  const pendingStore = new PendingMessageStore(sessionStore.db, 3);
  const dbManager = {
    getSessionStore: () => sessionStore,
    getPendingMessageStore: () => pendingStore,
    getSessionById: (id: number) => sessionStore.getSessionById(id),
    getChromaSync: () => undefined,
  } as unknown as DatabaseManager;

  const mgr = new SessionManager(dbManager);
  const sessionDbId = sessionStore.createSDKSession('cs', 'proj', 'hello');
  mgr.initializeSession(sessionDbId, 'hello', 1);
  return { mgr, sessionStore, pendingStore, sessionDbId };
}

describe('SessionManager.queueSummarize — lastAssistantMessage length cap', () => {
  let spies: Array<ReturnType<typeof spyOn>>;
  beforeEach(() => {
    spies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
    ];
  });
  afterEach(() => { for (const s of spies) s.mockRestore(); });

  it('exports a MAX_LAST_ASSISTANT_MESSAGE_CHARS constant of at least 16KB', () => {
    expect(typeof MAX_LAST_ASSISTANT_MESSAGE_CHARS).toBe('number');
    expect(MAX_LAST_ASSISTANT_MESSAGE_CHARS).toBeGreaterThanOrEqual(16_384);
  });

  it('does not touch messages shorter than the cap', () => {
    const { mgr, pendingStore, sessionDbId } = setup();
    const shortMsg = 'This is a perfectly normal short assistant response.';
    mgr.queueSummarize(sessionDbId, {
      lastAssistantMessage: shortMsg,
      promptNumber: 1,
      queuedAtEpoch: Date.now(),
    });
    const row = pendingStore['db'].prepare(
      `SELECT last_assistant_message FROM pending_messages WHERE message_type='summarize' ORDER BY id DESC LIMIT 1`,
    ).get() as { last_assistant_message: string };
    expect(row.last_assistant_message).toBe(shortMsg);
  });

  it('caps oversize messages and preserves the tail', () => {
    const { mgr, pendingStore, sessionDbId } = setup();
    // 2x the cap — must be truncated.
    const over = 'A'.repeat(MAX_LAST_ASSISTANT_MESSAGE_CHARS * 2);
    // Tag the tail so we can assert it's preserved.
    const tailTag = '_TAIL_SIGNATURE_';
    const oversize = over + tailTag;
    mgr.queueSummarize(sessionDbId, {
      lastAssistantMessage: oversize,
      promptNumber: 1,
      queuedAtEpoch: Date.now(),
    });
    const row = pendingStore['db'].prepare(
      `SELECT last_assistant_message FROM pending_messages WHERE message_type='summarize' ORDER BY id DESC LIMIT 1`,
    ).get() as { last_assistant_message: string };
    expect(row.last_assistant_message.length).toBeLessThanOrEqual(
      MAX_LAST_ASSISTANT_MESSAGE_CHARS + LAST_ASSISTANT_MESSAGE_TRUNCATION_MARKER.length,
    );
    // Tail preservation — most recent assistant output is what matters.
    expect(row.last_assistant_message.endsWith(tailTag)).toBe(true);
    // Truncation marker present somewhere.
    expect(row.last_assistant_message).toContain(LAST_ASSISTANT_MESSAGE_TRUNCATION_MARKER);
  });

  it('handles undefined lastAssistantMessage without error (reaper path)', () => {
    const { mgr, sessionDbId } = setup();
    expect(() => mgr.queueSummarize(sessionDbId, {
      lastAssistantMessage: undefined,
      promptNumber: 1,
      queuedAtEpoch: Date.now(),
    })).not.toThrow();
  });

  it('handles empty string without truncation', () => {
    const { mgr, pendingStore, sessionDbId } = setup();
    mgr.queueSummarize(sessionDbId, {
      lastAssistantMessage: '',
      promptNumber: 1,
      queuedAtEpoch: Date.now(),
    });
    const row = pendingStore['db'].prepare(
      `SELECT last_assistant_message FROM pending_messages WHERE message_type='summarize' ORDER BY id DESC LIMIT 1`,
    ).get() as { last_assistant_message: string | null };
    // Empty string may be stored as NULL by enqueue's fallback; either is fine.
    expect(row.last_assistant_message === '' || row.last_assistant_message === null).toBe(true);
  });
});
