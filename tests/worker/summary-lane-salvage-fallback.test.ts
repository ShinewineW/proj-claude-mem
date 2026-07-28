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

import { describe, it, expect, mock, beforeEach, afterEach, spyOn, afterAll } from 'bun:test';

// __CONFINED_MOCKS__: bun's mock.module() is process-wide and mock.restore() does
// NOT undo it, so a partial stub below would leak into every test file
// loaded after this one (project-isolation suites fail that way). Capture
// the real modules first and re-register them in afterAll so the stubs
// stay confined to this file.
import * as __real0 from '../../src/services/worker/ProcessRegistry.js';
const __REAL_MODULES: Array<[string, unknown]> = [
  ['../../src/services/worker/ProcessRegistry.js', { ...__real0 }],
];
afterAll(() => {
  for (const [spec, real] of __REAL_MODULES) mock.module(spec, () => real);
});

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
import { ObsCapPolicy, DEFAULT_STEP_SEQUENCE } from '../../src/services/worker/obs-cap-policy.js';
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
      0,
      undefined,
      contentSessionId,  // required for prompt-scoped salvage lookup
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

  it('salvage uses PROMPT-SCOPED obs window — no cross-turn contamination', async () => {
    // Critic-flagged Fix #2: salvage previously used
    // getRecentObservationsForSession(memory_session_id, 20) which has no
    // prompt_number filter and no queuedAtEpoch upper bound. If a new turn
    // (prompt N+1) lands during the dead-letter retry window (~2 min),
    // its observations would leak into the salvage for prompt N.
    //
    // This test seeds:
    //   - prompt=1 obs written BEFORE the summarize's created_at_epoch
    //     (these are the ones the salvage must use)
    //   - prompt=2 obs written AFTER the summarize's created_at_epoch
    //     (these represent a later turn that started during dead-letter
    //     and must NOT leak into salvage for prompt=1)
    const contentSessionId = `cs-${Math.random().toString(36).slice(2, 8)}`;
    const sessionDbId = store.createSDKSession(contentSessionId, 'test-proj', 'Q1');
    const memorySessionId = `mem-${sessionDbId}`;
    store.ensureMemorySessionIdRegistered(sessionDbId, memorySessionId);
    store.saveUserPrompt(contentSessionId, 1, 'Q1');
    store.saveUserPrompt(contentSessionId, 2, 'Q2');

    // Pre-summarize observations for prompt 1 (MUST appear in salvage)
    for (let i = 0; i < 5; i++) {
      store.storeObservation(
        memorySessionId,
        'test-proj',
        {
          type: 'discovery',
          title: `prompt1-obs-${i}`,
          subtitle: null,
          facts: [`p1-fact-${i}`],
          narrative: `prompt1 narrative ${i}`,
          concepts: [],
          files_read: [],
          files_modified: [],
        },
        1,
        0,
        undefined,
        contentSessionId,
      );
    }

    const summarizeCreatedAt = Date.now();
    // Seed dead-letter-in-one summarize for prompt 1 at epoch=summarizeCreatedAt
    store.db.prepare(`
      INSERT INTO pending_messages (
        session_db_id, content_session_id, message_type,
        last_assistant_message, prompt_number,
        status, retry_count, created_at_epoch,
        started_processing_at_epoch
      ) VALUES (?, ?, 'summarize', ?, ?, 'pending', 2, ?, NULL)
    `).run(sessionDbId, contentSessionId, 'A1', 1, summarizeCreatedAt);

    // NOW inject prompt-2 observations AFTER the summarize's created_at.
    // These represent a later turn starting during the dead-letter retry
    // window. They MUST NOT appear in salvage for prompt 1.
    // bun:sqlite auto-fills created_at_epoch with Date.now() when we call
    // storeObservation, which is > summarizeCreatedAt by definition.
    await new Promise((r) => setTimeout(r, 5));
    for (let i = 0; i < 5; i++) {
      store.storeObservation(
        memorySessionId,
        'test-proj',
        {
          type: 'discovery',
          title: `prompt2-LEAK-${i}`,
          subtitle: null,
          facts: [`p2-leak-fact-${i}`],
          narrative: `prompt2 narrative ${i} — MUST NOT LEAK`,
          concepts: [],
          files_read: [],
          files_modified: [],
        },
        2,                  // higher prompt_number AND later epoch
        0,
        undefined,
        contentSessionId,   // same content_session_id as prompt 1
      );
    }

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

    const row = store.db
      .prepare(`SELECT investigated, request FROM session_summaries WHERE memory_session_id=? AND prompt_number=1`)
      .get(memorySessionId) as { investigated: string; request: string } | undefined;

    expect(row).toBeDefined();
    // Prompt 1 obs MUST appear
    expect(row!.investigated).toMatch(/prompt1-obs-/);
    // Prompt 2 obs MUST NOT leak into prompt 1's salvage summary
    expect(row!.investigated).not.toMatch(/prompt2-LEAK-/);
    expect(row!.request).not.toMatch(/prompt2-LEAK-/);
  }, 15000);

  it('still steps down cap on every failure (intra-retry + dead-letter) even when salvage succeeds', async () => {
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

    // Salvage succeeding does NOT undo the cap degradation.
    // Seed is retry_count=2 → markFailed uses strict less-than:
    //   call 1: 2<3 TRUE → retry_count=3, pending, recordFailure(#1)
    //   (consume loop re-claims after 2s sleep)
    //   call 2: 3<3 FALSE → failed, recordFailure(#2), salvage runs
    // Two stepdowns: sequence[0]=150 → sequence[1]=75 → sequence[2]=37.
    expect(policy.getCapForSession(sessionDbId)).toBe(DEFAULT_STEP_SEQUENCE[2]);
  }, 15000);
});
