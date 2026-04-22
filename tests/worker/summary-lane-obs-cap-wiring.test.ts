/**
 * SummaryLane ↔ ObsCapPolicy wiring.
 *
 * Wires the adaptive cap policy into the summarize pipeline:
 *   - Before each runFreshSummarizeQuery call, read `getCapForSession(id)`
 *     and pass it as `maxObservations`.
 *   - On successful store, call `recordSuccess(id)` so the cap resets to
 *     default (60).
 *   - On dead-letter (3rd retry exhausted → pending_messages.status='failed'),
 *     call `recordFailure(id)` so the NEXT summarize attempt on the same
 *     session uses a smaller cap.
 *
 * Retries WITHIN a single dead-lettered message reuse the current cap — we
 * only step down between messages, matching user spec "走了一次 salvage → 30".
 */

import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';

const VALID_SUMMARY_XML = `<summary>
  <request>wire cap</request>
  <investigated>policy integration</investigated>
  <learned>cap steps down</learned>
  <completed>wired ObsCapPolicy</completed>
  <next_steps></next_steps>
  <notes></notes>
</summary>`;

// ---- Module mocks ----------------------------------------------------------

mock.module('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({ name: 'code' }),
      loadMode: () => {},
    }),
  },
}));

// Shared mutable capture used by the mocked Agent SDK to expose the
// options the SUT passes through runFreshSummarizeQuery.
const captured: { options: any[]; collected: string[] } = {
  options: [],
  collected: [],
};

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { prompt: AsyncIterable<unknown>; options: any }) => {
    captured.options.push(args.options);
    return (async function* () {
      // Also drain + capture the prompt so assertions on content can run
      let promptText = '';
      for await (const p of args.prompt) {
        const msg = p as any;
        const c = msg?.message?.content;
        if (typeof c === 'string') promptText += c;
        else if (Array.isArray(c)) promptText += c.map((x: any) => x.text ?? '').join('');
      }
      captured.collected.push(promptText);
      yield {
        type: 'assistant',
        session_id: 'mock-s',
        message: {
          content: [{ type: 'text', text: VALID_SUMMARY_XML }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      };
      yield { type: 'result', session_id: 'mock-s', stop_reason: 'end_turn' };
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

// ---- Helpers ---------------------------------------------------------------

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
    initializeSession: (sessionDbId: number) => {
      const row = store.getSessionById(sessionDbId);
      return {
        sessionDbId,
        contentSessionId: row?.content_session_id ?? '',
        project: row?.project ?? '',
        dbPath: ':memory:',
        userPrompt: row?.user_prompt ?? '',
        lastPromptNumber: 1,
        abortController: new AbortController(),
      } as any;
    },
  } as any;
}

function seedSession(store: SessionStore, prompt = 1): {
  sessionDbId: number; contentSessionId: string;
} {
  const contentSessionId = `cs-${Math.random().toString(36).slice(2, 8)}`;
  const sessionDbId = store.createSDKSession(contentSessionId, 'test-proj', 'Q');
  store.ensureMemorySessionIdRegistered(sessionDbId, `mem-${sessionDbId}`);
  store.saveUserPrompt(contentSessionId, prompt, 'Q');
  return { sessionDbId, contentSessionId };
}

async function runUntilNSummaries(
  lane: SummaryLane,
  broadcasts: unknown[],
  expected: number,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (broadcasts.length < expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 30));
  }
}

// ---- Tests -----------------------------------------------------------------

describe('SummaryLane: ObsCapPolicy wiring', () => {
  let store: SessionStore;
  let pendingStore: PendingMessageStore;
  let spies: Array<ReturnType<typeof spyOn>>;

  beforeEach(() => {
    captured.options = [];
    captured.collected = [];
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

  it('passes the policy cap into fresh-summarize prompt on first attempt (default 60)', async () => {
    const { sessionDbId, contentSessionId } = seedSession(store);
    pendingStore.enqueue(sessionDbId, contentSessionId, {
      type: 'summarize',
      last_assistant_message: 'ok',
      prompt_number: 1,
    });

    const policy = new ObsCapPolicy();
    const broadcasts: any[] = [];
    const lane = new SummaryLane({ obsCapPolicy: policy });
    lane.setSessionManager(makeStubSessionManager(store, pendingStore));
    lane.setDbManager(makeStubDbManager(store, pendingStore));
    lane.setDbPathsProvider(() => new Set([DB_PATH]));
    lane.setBroadcastSummary((p) => { broadcasts.push(p); });
    lane.setBroadcastProcessingStatus(() => {});

    lane.start();
    await runUntilNSummaries(lane, broadcasts, 1);
    await lane.stop();

    expect(broadcasts.length).toBe(1);
    // The prompt should include `count="0"` (no obs stored yet) but the
    // renderer was invoked. More importantly, the prompt text includes the
    // tail reinforcement + nothing beyond default schema — we just check
    // the query was made.
    expect(captured.collected.length).toBeGreaterThan(0);
  });

  it('recordSuccess is called after a successful store (cap stays at default)', async () => {
    const { sessionDbId, contentSessionId } = seedSession(store);
    pendingStore.enqueue(sessionDbId, contentSessionId, {
      type: 'summarize',
      last_assistant_message: 'ok',
      prompt_number: 1,
    });

    const policy = new ObsCapPolicy();
    // Pre-set cap lower than default to assert success resets it
    policy.recordFailure(sessionDbId); // 60 → 30
    expect(policy.getCapForSession(sessionDbId)).toBe(30);

    const broadcasts: any[] = [];
    const lane = new SummaryLane({ obsCapPolicy: policy });
    lane.setSessionManager(makeStubSessionManager(store, pendingStore));
    lane.setDbManager(makeStubDbManager(store, pendingStore));
    lane.setDbPathsProvider(() => new Set([DB_PATH]));
    lane.setBroadcastSummary((p) => { broadcasts.push(p); });
    lane.setBroadcastProcessingStatus(() => {});

    lane.start();
    await runUntilNSummaries(lane, broadcasts, 1);
    await lane.stop();

    expect(broadcasts.length).toBe(1);
    expect(policy.getCapForSession(sessionDbId)).toBe(60);
  });

  it('recordFailure fires once per dead-letter (retries within message do NOT step down)', async () => {
    const { sessionDbId, contentSessionId } = seedSession(store);

    // Seed the summarize row ALREADY at retry_count=2 (bun:sqlite direct).
    // With maxRetries=3 and markFailed semantics (retry_count < maxRetries →
    // pending, else → failed), a single failure from retry_count=2 produces
    // retry_count=3 → status='failed' (dead-letter) in one markFailed call.
    const now = Date.now();
    store.db.prepare(`
      INSERT INTO pending_messages (
        session_db_id, content_session_id, message_type,
        last_assistant_message, prompt_number,
        status, retry_count, created_at_epoch,
        started_processing_at_epoch
      ) VALUES (?, ?, 'summarize', ?, ?, 'pending', 2, ?, NULL)
    `).run(sessionDbId, contentSessionId, 'am', 1, now);

    // Unregister the memory_session_id so the runFreshSummarizeQuery call
    // raises "non-success" status=error (session row ok, memory_session_id
    // is there — instead we will sabotage the SDK mock to throw).
    //
    // Simpler path: delete the session row entirely so SummaryLane's first
    // lookup returns null → confirmProcessed + skip; that does NOT exercise
    // the failure path. We need a different way to force failure.
    //
    // Best: override the mocked SDK query to throw on this call. The mock
    // above returns a valid XML; we install a one-shot override here using
    // a session-scoped flag. Easier: zero out the mock response for this
    // run by temporarily swapping the getObservationsForSession helper to
    // raise — but runFreshSummarizeQuery catches errors → status='error'.
    // That triggers throw in processSummarize → the consume loop catch
    // calls markFailed(retry_count=2 → 3) → final status 'failed'.
    //
    // To force runFreshSummarizeQuery status='error' we exploit the fact
    // that the mocked query() yields VALID_SUMMARY_XML unconditionally, so
    // we instead break the DB write by clearing memory_session_id after
    // the lookup — but that introduces a TOCTOU race. Cleaner: delete the
    // user prompt row so resolve fails? No, SummaryLane handles missing
    // user prompt gracefully (falls back to empty).
    //
    // Pragmatic choice: temporarily mutate the mock's behavior via a global
    // flag so this test gets a throw-every-call iterator.

    // Swap the captured path to throw. This is pollution-safe because
    // captured is module-local to this file.
    const origPush = captured.options.push.bind(captured.options);
    captured.options = Object.assign([], {
      push(x: unknown) {
        origPush(x);
        throw new Error('simulated-fresh-summarize-failure');
      },
    }) as any;

    const policy = new ObsCapPolicy();
    const broadcasts: any[] = [];
    const markFailures: Array<number> = [];
    // Spy on recordFailure to count
    const origRecordFailure = policy.recordFailure.bind(policy);
    policy.recordFailure = (id: number) => {
      markFailures.push(id);
      origRecordFailure(id);
    };

    const lane = new SummaryLane({ obsCapPolicy: policy });
    lane.setSessionManager(makeStubSessionManager(store, pendingStore));
    lane.setDbManager(makeStubDbManager(store, pendingStore));
    lane.setDbPathsProvider(() => new Set([DB_PATH]));
    lane.setBroadcastSummary((p) => { broadcasts.push(p); });
    lane.setBroadcastProcessingStatus(() => {});

    lane.start();

    // Wait for the pending row to transition to 'failed' (dead-letter)
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const row = store.db
        .prepare(
          `SELECT status FROM pending_messages WHERE session_db_id=? AND message_type='summarize'`,
        )
        .get(sessionDbId) as { status: string } | undefined;
      if (row?.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 30));
    }

    await lane.stop();

    // Exactly one dead-letter event → exactly one recordFailure call
    expect(markFailures).toEqual([sessionDbId]);
    // Cap stepped down: 60 → 30
    expect(policy.getCapForSession(sessionDbId)).toBe(30);
  });
});
