/**
 * Salvage fallback on dead-letter (Phase 4).
 *
 * When fresh-summarize exhausts its 3 retries AND the dead-letter path
 * fires, synthesize a minimal summary from DB observations so the turn is
 * not completely lost. The synthesized payload is labeled (via the `notes`
 * field + a "[salvaged]" prefix on `request`) so viewers can distinguish
 * Claude-written summaries from DB-synthesized ones.
 *
 * Policy guardrails:
 *   - Salvage ONLY runs on dead-letter (not per-retry), mirroring the
 *     adaptive-cap stepdown trigger.
 *   - No Claude call — pure metadata aggregation from SessionStore.
 *   - Stored through the same `storeFreshSummaryForSession` path so turn-key
 *     dedup + FK-race hardening both apply.
 *   - If the session has 0 recent observations, skip salvage (nothing
 *     meaningful to synthesize).
 */

import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';

mock.module('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({ name: 'code' }),
      loadMode: () => {},
    }),
  },
}));

// Force runFreshSummarizeQuery to always fail by mocking the Agent SDK
// query() to throw. Shared scope so every test in this file gets failure.
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    return (async function* () {
      throw new Error('simulated-claude-unreachable');
      // eslint-disable-next-line no-unreachable
      yield {};
    })();
  },
}));

mock.module('../../src/services/worker/claude-exec.js', () => ({
  findClaudeExecutable: () => '/usr/local/bin/claude',
}));

mock.module('../../src/services/worker/ProcessRegistry.js', () => ({
  createPidCapturingSpawn: () => undefined,
  processRegistry: new Map(),
  registerProcess: () => {},
  unregisterProcess: () => {},
  getProcessBySession: () => undefined,
  getActiveCount: () => 0,
  ensureProcessExit: async () => {},
  reapOrphanedProcesses: async () => 0,
  startOrphanReaper: () => () => {},
  waitForSlot: async () => {},
  getActiveProcesses: () => [],
}));

import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { PendingMessageStore } from '../../src/services/sqlite/PendingMessageStore.js';
import { SummaryLane } from '../../src/services/worker/SummaryLane.js';
import { ObsCapPolicy } from '../../src/services/worker/obs-cap-policy.js';
import { logger } from '../../src/utils/logger.js';
import { DB_PATH } from '../../src/shared/paths.js';

function makeStubDbManager(store: SessionStore, pendingStore: PendingMessageStore) {
  return {
    getSessionStore: () => store,
    getPendingMessageStore: () => pendingStore,
    getChromaSync: () => undefined,
    getPool: () => ({ evict: () => {} }),
  } as any;
}

function makeStubSessionManager(store: SessionStore, pendingStore: PendingMessageStore) {
  return {
    getPendingMessageStore: () => pendingStore,
    initializeSession: (sessionDbId: number) => ({
      sessionDbId,
      contentSessionId: '',
      project: '',
      dbPath: ':memory:',
      userPrompt: '',
      lastPromptNumber: 1,
      abortController: new AbortController(),
    } as any),
  } as any;
}

function seedSessionWithObservations(
  store: SessionStore,
  obsCount: number,
): { sessionDbId: number; contentSessionId: string; memorySessionId: string } {
  const contentSessionId = `cs-${Math.random().toString(36).slice(2, 8)}`;
  const sessionDbId = store.createSDKSession(contentSessionId, 'test-proj', 'Investigate bug');
  const memorySessionId = `mem-${sessionDbId}`;
  store.ensureMemorySessionIdRegistered(sessionDbId, memorySessionId);
  store.saveUserPrompt(contentSessionId, 1, 'Investigate bug');
  for (let i = 0; i < obsCount; i++) {
    store.storeObservation(
      memorySessionId,
      'test-proj',
      {
        type: 'discovery',
        title: `finding-${i + 1}`,
        subtitle: null,
        facts: [`fact-${i + 1}`],
        narrative: `narrative ${i + 1}`,
        concepts: [],
        files_read: [],
        files_modified: [],
      },
      1,
    );
  }
  return { sessionDbId, contentSessionId, memorySessionId };
}

function seedDeadLetterSummarize(
  store: SessionStore,
  pendingStore: PendingMessageStore,
  sessionDbId: number,
  contentSessionId: string,
): void {
  // Pre-seeded at retry_count=2 so a single markFailed call → retry_count=3 →
  // finalStatus='failed' (dead-letter).
  const now = Date.now();
  store.db.prepare(`
    INSERT INTO pending_messages (
      session_db_id, content_session_id, message_type,
      last_assistant_message, prompt_number,
      status, retry_count, created_at_epoch,
      started_processing_at_epoch
    ) VALUES (?, ?, 'summarize', ?, ?, 'pending', 2, ?, NULL)
  `).run(sessionDbId, contentSessionId, 'mid-flight msg', 1, now);
}

async function waitForDeadLetter(
  store: SessionStore,
  sessionDbId: number,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = store.db
      .prepare(
        `SELECT status FROM pending_messages WHERE session_db_id=? AND message_type='summarize'`,
      )
      .get(sessionDbId) as { status: string } | undefined;
    if (row?.status === 'failed' || row === undefined) break;
    await new Promise((r) => setTimeout(r, 30));
  }
}

describe('SummaryLane: salvage fallback on dead-letter', () => {
  let store: SessionStore;
  let pendingStore: PendingMessageStore;
  let spies: Array<ReturnType<typeof spyOn>>;

  beforeEach(() => {
    spies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
    ];
    store = new SessionStore(':memory:');
    pendingStore = new PendingMessageStore(store.db);
  });

  afterEach(async () => {
    store.close();
    for (const s of spies) s.mockRestore();
  });

  it('stores a DB-synthesized summary after dead-letter (session has observations)', async () => {
    const { sessionDbId, contentSessionId } = seedSessionWithObservations(store, 5);
    seedDeadLetterSummarize(store, pendingStore, sessionDbId, contentSessionId);

    const lane = new SummaryLane({ obsCapPolicy: new ObsCapPolicy() });
    lane.setSessionManager(makeStubSessionManager(store, pendingStore));
    lane.setDbManager(makeStubDbManager(store, pendingStore));
    lane.setDbPathsProvider(() => new Set([DB_PATH]));
    lane.setBroadcastSummary(() => {});
    lane.setBroadcastProcessingStatus(() => {});

    lane.start();
    await waitForDeadLetter(store, sessionDbId);
    await lane.stop();

    // A summary row was written despite the Claude call failing.
    const row = store.db
      .prepare(`SELECT request, investigated, notes FROM session_summaries WHERE memory_session_id=?`)
      .get(`mem-${sessionDbId}`) as
      | { request: string; investigated: string; notes: string | null }
      | undefined;

    expect(row).toBeDefined();
    expect(row!.request.length).toBeGreaterThan(0);
    // Synthesized summaries must be identifiable — viewer needs to
    // distinguish them from Claude-authored summaries.
    expect(row!.notes ?? '').toMatch(/salvage/i);
    // The investigation field should carry at least one of the 5 obs titles
    // so the summary is substantive, not just a placeholder.
    expect(row!.investigated).toMatch(/finding-/);
  });

  it('does NOT write a salvage summary when session has zero observations (nothing to synthesize)', async () => {
    const { sessionDbId, contentSessionId } = seedSessionWithObservations(store, 0);
    seedDeadLetterSummarize(store, pendingStore, sessionDbId, contentSessionId);

    const lane = new SummaryLane({ obsCapPolicy: new ObsCapPolicy() });
    lane.setSessionManager(makeStubSessionManager(store, pendingStore));
    lane.setDbManager(makeStubDbManager(store, pendingStore));
    lane.setDbPathsProvider(() => new Set([DB_PATH]));
    lane.setBroadcastSummary(() => {});
    lane.setBroadcastProcessingStatus(() => {});

    lane.start();
    await waitForDeadLetter(store, sessionDbId);
    await lane.stop();

    const row = store.db
      .prepare(`SELECT COUNT(*) as c FROM session_summaries WHERE memory_session_id=?`)
      .get(`mem-${sessionDbId}`) as { c: number };

    // No salvage row — accept loss when there's nothing meaningful to synth.
    expect(row.c).toBe(0);
  });

  it('still steps down cap on dead-letter even when salvage succeeds', async () => {
    const { sessionDbId, contentSessionId } = seedSessionWithObservations(store, 3);
    seedDeadLetterSummarize(store, pendingStore, sessionDbId, contentSessionId);

    const policy = new ObsCapPolicy();
    const lane = new SummaryLane({ obsCapPolicy: policy });
    lane.setSessionManager(makeStubSessionManager(store, pendingStore));
    lane.setDbManager(makeStubDbManager(store, pendingStore));
    lane.setDbPathsProvider(() => new Set([DB_PATH]));
    lane.setBroadcastSummary(() => {});
    lane.setBroadcastProcessingStatus(() => {});

    lane.start();
    await waitForDeadLetter(store, sessionDbId);
    await lane.stop();

    // Salvage succeeding does NOT undo the dead-letter degradation:
    // we still stepped cap down because the Claude-level attempt failed.
    // (If the next Claude call succeeds at cap=30, THAT resets to 60.)
    expect(policy.getCapForSession(sessionDbId)).toBe(30);
  });
});
