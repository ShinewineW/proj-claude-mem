/**
 * SummaryLane ↔ ObsCapPolicy wiring.
 *
 * Wires the adaptive cap policy into the summarize pipeline:
 *   - Before each runFreshSummarizeQuery call, read `getCapForSession(id)`
 *     and pass it as `maxObservations`.
 *   - On successful store, call `recordSuccess(id)` so the cap holds at the
 *     current successful level and avoids per-summary top-cap oscillation.
 *   - On every failure, call `recordFailure(id)` so retries within the same
 *     message probe progressively smaller caps instead of repeating the same
 *     oversized prompt.
 *   - When SummaryLane owns the policy instance, it refreshes
 *     CLAUDE_MEM_MAX_SUMMARY_OBSERVATIONS from settings before each summarize
 *     so config changes apply on the next run without a worker restart.
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
import {
  ObsCapPolicy,
  DEFAULT_OBS_CAP,
  DEFAULT_STEP_SEQUENCE,
} from '../../src/services/worker/obs-cap-policy.js';
import { logger } from '../../src/utils/logger.js';
import { DB_PATH } from '../../src/shared/paths.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

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

function seedObservations(
  store: SessionStore,
  sessionDbId: number,
  contentSessionId: string,
  count: number,
  prompt = 1,
): void {
  const memorySessionId = `mem-${sessionDbId}`;
  for (let i = 0; i < count; i++) {
    store.storeObservation(
      memorySessionId,
      'test-proj',
      {
        type: 'discovery',
        title: `obs-${prompt}-${i + 1}`,
        subtitle: null,
        facts: [`fact-${i + 1}`],
        narrative: `narrative ${i + 1}`,
        concepts: [],
        files_read: [],
        files_modified: [],
      },
      prompt,
      0,
      undefined,
      contentSessionId,
    );
  }
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
  let settingsSpy: ReturnType<typeof spyOn> | null;

  beforeEach(() => {
    captured.options = [];
    captured.collected = [];
    settingsSpy = null;
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
    settingsSpy?.mockRestore();
  });

  it('passes the policy cap into fresh-summarize prompt on first attempt (configured default)', async () => {
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

  it('refreshes configured max cap from settings on the next summarize without restarting SummaryLane', async () => {
    let configuredCap = '150';
    settingsSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      CLAUDE_MEM_MODEL: 'claude-sonnet-4-5',
      CLAUDE_MEM_MAX_SUMMARY_OBSERVATIONS: configuredCap,
    } as any));

    const first = seedSession(store);
    seedObservations(store, first.sessionDbId, first.contentSessionId, 200);
    pendingStore.enqueue(first.sessionDbId, first.contentSessionId, {
      type: 'summarize',
      last_assistant_message: 'first',
      prompt_number: 1,
    });

    const broadcasts: any[] = [];
    const lane = new SummaryLane();
    lane.setSessionManager(makeStubSessionManager(store, pendingStore));
    lane.setDbManager(makeStubDbManager(store, pendingStore));
    lane.setDbPathsProvider(() => new Set([DB_PATH]));
    lane.setBroadcastSummary((p) => { broadcasts.push(p); });
    lane.setBroadcastProcessingStatus(() => {});

    lane.start();
    await runUntilNSummaries(lane, broadcasts, 1, 5000);

    configuredCap = '40';
    const second = seedSession(store);
    seedObservations(store, second.sessionDbId, second.contentSessionId, 200);
    pendingStore.enqueue(second.sessionDbId, second.contentSessionId, {
      type: 'summarize',
      last_assistant_message: 'second',
      prompt_number: 1,
    });

    await runUntilNSummaries(lane, broadcasts, 2, 5000);
    await lane.stop();

    expect(broadcasts.length).toBe(2);
    expect(captured.collected[0]).toContain('<observations count="150" total_this_session="200">');
    expect(captured.collected[1]).toContain('<observations count="40" total_this_session="200">');
  });

  it('recordSuccess is called after a successful store (cap holds at reduced level)', async () => {
    const { sessionDbId, contentSessionId } = seedSession(store);
    pendingStore.enqueue(sessionDbId, contentSessionId, {
      type: 'summarize',
      last_assistant_message: 'ok',
      prompt_number: 1,
    });

    const policy = new ObsCapPolicy();
    // Pre-set cap lower than default to assert success HOLDS it (no reset).
    // sequence[1] = 150 halved = 75.
    policy.recordFailure(sessionDbId);
    expect(policy.getCapForSession(sessionDbId)).toBe(DEFAULT_STEP_SEQUENCE[1]);

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
    // Held at the reduced cap after success (no reset to DEFAULT_OBS_CAP).
    expect(policy.getCapForSession(sessionDbId)).toBe(DEFAULT_STEP_SEQUENCE[1]);
  });

  // Timeout bumped to 30s: full retry chain is 3×2s abortableSleep + claim
  // latency ≈ ~8-10s end-to-end, but bun:test's default 5s is not enough.
  it('recordFailure fires on EVERY retry (not just dead-letter) — intra-message stepdown', async () => {
    const { sessionDbId, contentSessionId } = seedSession(store);

    // Seed a fresh summarize row at retry_count=0 so it consumes the full
    // retry budget. markFailed uses `retry_count < maxRetries` (strict less),
    // so with maxRetries=3: 0→1 (pending), 1→2 (pending), 2→3 (pending),
    // 3→failed (dead-letter). 4 failure events total.
    const now = Date.now();
    store.db.prepare(`
      INSERT INTO pending_messages (
        session_db_id, content_session_id, message_type,
        last_assistant_message, prompt_number,
        status, retry_count, created_at_epoch,
        started_processing_at_epoch
      ) VALUES (?, ?, 'summarize', ?, ?, 'pending', 0, ?, NULL)
    `).run(sessionDbId, contentSessionId, 'am', 1, now);

    // Sabotage the mocked Agent SDK query so every call throws. The mock
    // we installed at module load time pushes to captured.options BEFORE
    // yielding; swap that push to throw so runFreshSummarizeQuery catches
    // it → status='error' → processSummarize throws → consume loop catch.
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

    // Wait for the pending row to fully dead-letter (either status='failed'
    // or deleted after the full retry chain).
    const deadline = Date.now() + 15000; // consume loop sleeps 2s between retries
    while (Date.now() < deadline) {
      const row = store.db
        .prepare(
          `SELECT status, retry_count FROM pending_messages WHERE session_db_id=? AND message_type='summarize'`,
        )
        .get(sessionDbId) as { status: string; retry_count: number } | undefined;
      if (!row || row.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 50));
    }

    await lane.stop();

    // 4 recordFailure calls over the life of this message. markFailed uses
    // `retry_count < maxRetries` (strict less-than), so with maxRetries=3
    // the sequence is: call 1 → retry_count=1 (pending), 2→2 (pending),
    // 3→3 (pending), 4→failed (dead-letter). See tests/CLAUDE.md and
    // rules/fixed-bugs.md § "markFailed retry semantic".
    expect(markFailures).toEqual([
      sessionDbId, sessionDbId, sessionDbId, sessionDbId,
    ]);
    // Cap stepped down 4 times along the parameterized halving sequence.
    // sequence[4] = step after 4 failures from index 0.
    expect(policy.getCapForSession(sessionDbId)).toBe(DEFAULT_STEP_SEQUENCE[4]);
  }, 30000);

  it('retry uses the newly-reduced cap (probes sequence[0], sequence[1], sequence[2] on successive attempts)', async () => {
    // This is the KEY regression pin: the cap forwarded to
    // runFreshSummarizeQuery on retry 2 must be LOWER than on retry 1.
    // Prior design sent the same cap on every retry (identical prompt ⇒
    // identical failure), wasting the retry budget. Critic flagged this
    // as Not-Ready blocker; Fix #1 makes retries probe smaller caps.
    const { sessionDbId, contentSessionId } = seedSession(store);
    const now = Date.now();
    store.db.prepare(`
      INSERT INTO pending_messages (
        session_db_id, content_session_id, message_type,
        last_assistant_message, prompt_number,
        status, retry_count, created_at_epoch,
        started_processing_at_epoch
      ) VALUES (?, ?, 'summarize', ?, ?, 'pending', 0, ?, NULL)
    `).run(sessionDbId, contentSessionId, 'am', 1, now);

    const policy = new ObsCapPolicy();
    // Capture the cap observed at each runFreshSummarizeQuery call.
    const seenCaps: number[] = [];
    const origGetCap = policy.getCapForSession.bind(policy);
    policy.getCapForSession = (id: number) => {
      const v = origGetCap(id);
      seenCaps.push(v);
      return v;
    };

    const origPush = captured.options.push.bind(captured.options);
    captured.options = Object.assign([], {
      push(x: unknown) {
        origPush(x);
        throw new Error('simulated-fresh-summarize-failure');
      },
    }) as any;

    const lane = new SummaryLane({ obsCapPolicy: policy });
    lane.setSessionManager(makeStubSessionManager(store, pendingStore));
    lane.setDbManager(makeStubDbManager(store, pendingStore));
    lane.setDbPathsProvider(() => new Set([DB_PATH]));
    lane.setBroadcastSummary(() => {});
    lane.setBroadcastProcessingStatus(() => {});

    lane.start();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const row = store.db
        .prepare(`SELECT status FROM pending_messages WHERE session_db_id=? AND message_type='summarize'`)
        .get(sessionDbId) as { status: string } | undefined;
      if (!row || row.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await lane.stop();

    // The POLICY cap observed during processSummarize on each attempt
    // (filter out telemetry-only reads). Compare DISTINCT decreasing values
    // to the first three elements of the parameterized halving sequence.
    // For default 150: [150, 75, 37]. For a custom defaultCap the sequence
    // would be different — assertion stays valid because we derive it.
    const distinctDecreasing = seenCaps.filter((v, i, arr) => i === 0 || v !== arr[i - 1]);
    expect(distinctDecreasing.slice(0, 3)).toEqual([
      DEFAULT_STEP_SEQUENCE[0],
      DEFAULT_STEP_SEQUENCE[1],
      DEFAULT_STEP_SEQUENCE[2],
    ]);
  }, 30000);
});
