/**
 * SDKAgent.runFreshSummarize orchestration tests.
 *
 * runFreshSummarizeQuery (the core) has 14 unit tests in fresh-summarize.test.ts.
 * storeFreshSummaryForSession has 6 tests in fresh-summarize-fk-race.test.ts.
 * This file covers the OUTER orchestration in SDKAgent.runFreshSummarize —
 * specifically the early-return paths that guard against calling the SDK
 * when the session row is missing or its memory_session_id is null.
 *
 * These paths cannot be triggered through the existing fresh-summarize.test.ts
 * (which exercises the query function directly) nor through the FK-race tests
 * (which assume a valid session row). A bug here would cause a crash before
 * the in-flight counter is decremented in SessionManager.queueSummarize's
 * .finally() — the exact regression the fresh-query refactor was meant to
 * eliminate.
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { logger } from '../../src/utils/logger.js';

// ModeManager mock returns a mode with SENTINEL placeholders so tests can
// assert that SDKAgent.runFreshSummarize threads the mode through to
// buildFreshSummaryPrompt. If the wiring is missing, these sentinels will be
// absent from capturedPrompts.
const MODE_REQUEST_SENTINEL = '[SDKAGENT_INTEGRATION_REQUEST_PLACEHOLDER]';
const MODE_SUMMARY_INSTR_SENTINEL = 'SDKAGENT_INTEGRATION_SUMMARY_INSTRUCTION';
mock.module('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        description: 'test',
        version: '1.0.0',
        observation_types: [{ id: 'discovery' }, { id: 'feature' }],
        observation_concepts: [],
        prompts: {
          system_identity: '',
          spatial_awareness: '',
          observer_role: '',
          recording_focus: '',
          skip_guidance: '',
          type_guidance: '',
          concept_guidance: '',
          field_guidance: '',
          output_format_header: '',
          format_examples: '',
          footer: '',
          xml_title_placeholder: '',
          xml_subtitle_placeholder: '',
          xml_fact_placeholder: '',
          xml_narrative_placeholder: '',
          xml_concept_placeholder: '',
          xml_file_placeholder: '',
          xml_summary_request_placeholder: MODE_REQUEST_SENTINEL,
          xml_summary_investigated_placeholder: '[SDKAGENT_INTEGRATION_INVESTIGATED_PLACEHOLDER]',
          xml_summary_learned_placeholder: '[SDKAGENT_INTEGRATION_LEARNED_PLACEHOLDER]',
          xml_summary_completed_placeholder: '[SDKAGENT_INTEGRATION_COMPLETED_PLACEHOLDER]',
          xml_summary_next_steps_placeholder: '[SDKAGENT_INTEGRATION_NEXT_STEPS_PLACEHOLDER]',
          xml_summary_notes_placeholder: '[SDKAGENT_INTEGRATION_NOTES_PLACEHOLDER]',
          header_memory_start: '',
          header_memory_continued: '',
          header_summary_checkpoint: '',
          continuation_greeting: '',
          continuation_instruction: '',
          summary_instruction: MODE_SUMMARY_INSTR_SENTINEL,
          summary_context_label: '',
          summary_format_instruction: '',
          summary_footer: '',
        },
      }),
      loadMode: () => {},
    }),
  },
}));

// Capture prompt text passed into the Agent SDK's query() — this is the
// boundary where we can observe which userPrompt SDKAgent.runFreshSummarize
// actually passed through buildFreshSummaryPrompt. The mock yields nothing,
// so runFreshSummarizeQuery resolves with status='no_text' without network.
// SDKAgent is the only src runtime user of this module (worker-types imports
// types only), so the pollution scope is SDKAgent-exercising tests.
const capturedPrompts: string[] = [];
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    return (async function* () {
      for await (const msg of prompt) {
        const m = msg as { message?: { content?: unknown } } | null;
        const content = m?.message?.content;
        if (typeof content === 'string') capturedPrompts.push(content);
      }
    })();
  },
}));

import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { PendingMessageStore } from '../../src/services/sqlite/PendingMessageStore.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import { SDKAgent } from '../../src/services/worker/SDKAgent.js';

describe('SDKAgent.runFreshSummarize — early-return orchestration', () => {
  let store: SessionStore;
  let pendingStore: PendingMessageStore;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  let sdkAgent: SDKAgent;
  let spies: Array<ReturnType<typeof spyOn>>;

  function makeStubDbManager(
    s: SessionStore,
    p: PendingMessageStore,
  ): DatabaseManager {
    return {
      getSessionStore: () => s,
      getPendingMessageStore: () => p,
      getSessionById: (id: number) => s.getSessionById(id),
      getChromaSync: () => undefined,
    } as unknown as DatabaseManager;
  }

  beforeEach(() => {
    spies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
    ];
    store = new SessionStore(':memory:');
    pendingStore = new PendingMessageStore(store.db);
    dbManager = makeStubDbManager(store, pendingStore);
    sessionManager = new SessionManager(dbManager);
    sdkAgent = new SDKAgent(dbManager, sessionManager);
    capturedPrompts.length = 0;
  });

  afterEach(() => {
    store.close();
    for (const s of spies) s.mockRestore();
  });

  it('returns silently when sessionRow does not exist (nonexistent sessionDbId)', async () => {
    // No session seeded — sessionDbId 9999 returns undefined from getSessionById.
    // runFreshSummarize must not throw and must not attempt to spawn Claude.
    //
    // A crash here would propagate up to queueSummarize's .finally() only
    // if the .catch handler fires, which it does — but the behavioral
    // contract is that the method is a silent no-op for invalid sessions.
    const result = await sdkAgent.runFreshSummarize(9999, 'any text', undefined);
    expect(result).toBeUndefined();
  });

  it('returns silently when sessionRow exists but memory_session_id is null', async () => {
    // Create session WITHOUT registering memory_session_id. This mirrors the
    // first-hook window where a session is created from observation route
    // (cwd-derived project) but no SDK response has captured a real
    // memory_session_id yet. Calling summarize in that window should just
    // no-op — there is nothing to key the summary against.
    const sessionDbId = store.createSDKSession('cs-null', 'test-project', 'do thing');
    // Intentionally NOT calling ensureMemorySessionIdRegistered.

    const sessionRow = store.getSessionById(sessionDbId);
    expect(sessionRow?.memory_session_id).toBeFalsy();

    const result = await sdkAgent.runFreshSummarize(sessionDbId, 'any text', undefined);
    expect(result).toBeUndefined();

    // No summary was stored — verify DB is empty.
    const summaryCount = store.db
      .prepare(`SELECT COUNT(*) AS c FROM session_summaries`)
      .get() as { c: number };
    expect(summaryCount.c).toBe(0);
  });

  it('does not throw when called on a session whose row was deleted mid-flight', async () => {
    // Simulates the "session row went away while handler was queued"
    // scenario — different from the FK-race (which is about memory_session_id
    // being UPDATED). Here the row is DELETED. getSessionById returns
    // undefined → same early-return branch as test 1, but triggered through
    // a realistic deletion path.
    const sessionDbId = store.createSDKSession('cs-del', 'test-project', 'do thing');
    store.ensureMemorySessionIdRegistered(sessionDbId, 'mem-del');

    // Delete the session row.
    store.db.prepare(`DELETE FROM sdk_sessions WHERE id = ?`).run(sessionDbId);

    const result = await sdkAgent.runFreshSummarize(sessionDbId, 'text', undefined);
    expect(result).toBeUndefined();
  });

  // Regression: prior to this fix, runFreshSummarize passed sessionRow.user_prompt
  // (the row is INSERTed once at session creation and never UPDATEd per turn) as
  // the summary's <user_request>. Every summary produced in a multi-turn session
  // therefore had the same "title" — the session's first prompt. Evidence:
  // ClaudeMem-ProjIso mem.db session 160 had 7 summaries (prompt_number 3-9) all
  // displaying "检查远端的更新，远端应该更新了很多内容" as their request, despite
  // each turn being about unrelated work. See fixed-bugs.md § "Summary request
  // field derived from stale session-row user_prompt".
  it('uses in-memory session.userPrompt (current turn) instead of stale sessionRow.user_prompt', async () => {
    const sessionDbId = store.createSDKSession(
      'cs-turn',
      'test-project',
      'FIRST prompt that created the session',
    );
    store.ensureMemorySessionIdRegistered(sessionDbId, 'mem-turn');

    // Seed one observation so runFreshSummarize doesn't early-return on
    // missing memory_session_id and so the prompt has a concrete <observations>
    // block to render.
    store.storeObservation(
      'mem-turn',
      'test-project',
      {
        type: 'discovery',
        title: 'noop',
        subtitle: null,
        narrative: 'noop narrative',
        text: null,
        facts: [],
        concepts: [],
        files_read: [],
        files_modified: [],
      },
      null,
      0,
    );

    // Place an in-memory session with a DIFFERENT (current-turn) userPrompt —
    // this is what SessionManager.initializeSession does on each new prompt
    // cycle (see SessionManager.ts line ~202: session.userPrompt = currentUserPrompt).
    sessionManager.initializeSession(
      sessionDbId,
      'CURRENT-TURN prompt that is totally different',
      7,
      undefined,
    );

    await sdkAgent.runFreshSummarize(sessionDbId, 'assistant reply text', undefined);

    // Exactly one prompt is yielded per fresh summarize (single-turn query).
    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0]!;

    // The fix: the prompt's <user_request> block must reflect the current turn,
    // not the session's first prompt stored in sdk_sessions.user_prompt.
    expect(prompt).toContain('CURRENT-TURN prompt that is totally different');
    expect(prompt).not.toContain('FIRST prompt that created the session');
  });

  // Mode threading: SDKAgent.runFreshSummarize must load the active mode via
  // ModeManager and pass it through to runFreshSummarizeQuery so the fresh
  // prompt uses mode.prompts.xml_summary_*_placeholder. Without this wire,
  // the prompt falls back to the hardcoded "short original request phrase"
  // instructions and the model echoes the user prompt instead of
  // synthesizing a work-subject title (Apr-8-era behavior lost in the
  // 2026-04-19 fresh-query refactor).
  it('threads mode.prompts.xml_summary_*_placeholder through to the built prompt', async () => {
    const sessionDbId = store.createSDKSession('cs-mode', 'test-project', 'session-first-prompt');
    store.ensureMemorySessionIdRegistered(sessionDbId, 'mem-mode');
    store.storeObservation(
      'mem-mode',
      'test-project',
      {
        type: 'discovery',
        title: 'noop',
        subtitle: null,
        narrative: 'noop',
        text: null,
        facts: [],
        concepts: [],
        files_read: [],
        files_modified: [],
      },
      null,
      0,
    );
    sessionManager.initializeSession(sessionDbId, 'current-turn prompt', 2, undefined);

    await sdkAgent.runFreshSummarize(sessionDbId, 'assistant reply', undefined);

    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0]!;
    // Mode sentinels must appear — proves SDKAgent pulled mode and passed it.
    expect(prompt).toContain(MODE_REQUEST_SENTINEL);
    expect(prompt).toContain(MODE_SUMMARY_INSTR_SENTINEL);
    // Hardcoded fallback strings must be gone.
    expect(prompt).not.toContain('short original request phrase');
  });

  // Fallback pin: when the in-memory session was evicted (worker restart → pending
  // replay), runFreshSummarize should still produce a prompt rather than an empty
  // <user_request>. The stale DB value is worse than useless for display, but at
  // least it's non-empty context for the model to ground off of.
  it('falls back to sessionRow.user_prompt when no in-memory session exists', async () => {
    const sessionDbId = store.createSDKSession(
      'cs-nomem',
      'test-project',
      'DB-only prompt (session was evicted from memory)',
    );
    store.ensureMemorySessionIdRegistered(sessionDbId, 'mem-nomem');
    store.storeObservation(
      'mem-nomem',
      'test-project',
      {
        type: 'discovery',
        title: 'noop',
        subtitle: null,
        narrative: 'noop',
        text: null,
        facts: [],
        concepts: [],
        files_read: [],
        files_modified: [],
      },
      null,
      0,
    );
    // Intentionally do NOT call sessionManager.initializeSession — the session
    // exists in DB but not in the in-memory map.

    await sdkAgent.runFreshSummarize(sessionDbId, 'assistant reply', undefined);

    expect(capturedPrompts).toHaveLength(1);
    expect(capturedPrompts[0]!).toContain('DB-only prompt (session was evicted from memory)');
  });
});
