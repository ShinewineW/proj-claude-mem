import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { logger } from '../../../src/utils/logger.js';

// Module-level mocks - must be before production imports
mock.module('../../../src/services/worker-service.js', () => ({
  updateCursorContextForProject: () => Promise.resolve(),
}));

mock.module('../../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
}));

mock.module('../../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        prompts: {
          init: 'init prompt',
          observation: 'obs prompt',
          summary: 'summary prompt',
        },
        observation_types: [{ id: 'discovery' }, { id: 'bugfix' }, { id: 'refactor' }],
        observation_concepts: [],
      }),
    }),
  },
}));

// Import after mocks
import { processAgentResponse } from '../../../src/services/worker/agents/ResponseProcessor.js';
import type { ActiveSession } from '../../../src/services/worker-types.js';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
import type { SessionManager } from '../../../src/services/worker/SessionManager.js';

// Suppress logger output
let loggerSpies: ReturnType<typeof spyOn>[] = [];
beforeEach(() => {
  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'success').mockImplementation(() => {}),
    spyOn(logger, 'dataOut').mockImplementation(() => {}),
  ];
});
afterEach(() => loggerSpies.forEach(s => s.mockRestore()));

function makeSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    sessionDbId: 1,
    contentSessionId: 'test-content-id',
    memorySessionId: 'test-memory-id',
    project: 'test-project',
    userPrompt: 'test prompt',
    pendingMessages: [],
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    conversationHistory: [
      { role: 'user', content: 'msg1' },
      { role: 'assistant', content: 'msg2' },
    ],
    currentProvider: 'claude',
    consecutiveRestarts: 0,
    forceInit: false,
    contextResetCount: 0,
    lastGeneratorActivity: Date.now(),
    processingMessageIds: [],
    ...overrides,
  };
}

function makeMockDbManager(): DatabaseManager {
  return {
    getSessionStore: () => ({
      storeObservations: mock(() => ({
        observationIds: [1],
        summaryId: null,
        createdAtEpoch: Date.now(),
      })),
      ensureMemorySessionIdRegistered: mock(() => {}),
    }),
    getSessionById: mock(() => ({ project: 'test-project' })),
    getChromaSync: () => null,
  } as any;
}

function makeMockSessionManager(): SessionManager {
  return {
    getPendingMessageStore: () => ({
      confirmProcessed: mock(() => {}),
    }),
  } as any;
}

describe('Empty Observation Detection', () => {
  it('sets forceInit when observation has title=null AND narrative=null', async () => {
    const session = makeSession();
    const dbManager = makeMockDbManager();
    const sessionManager = makeMockSessionManager();

    // XML with observation that has no title and no narrative
    const emptyObsXml = '<observation><type>discovery</type></observation>';

    await processAgentResponse(
      emptyObsXml, session, dbManager, sessionManager,
      undefined, 0, null, 'SDK', undefined
    );

    expect(session.forceInit).toBe(true);
    expect(session.conversationHistory).toEqual([]);
    expect(session.previousMemorySessionId).toBe('test-memory-id');
  });

  it('does NOT set forceInit when title=null but narrative is present (parser glitch)', async () => {
    const session = makeSession();
    const dbManager = makeMockDbManager();
    const sessionManager = makeMockSessionManager();

    // title is missing but narrative exists — parser glitch, NOT context overflow
    const glitchXml = '<observation><type>discovery</type><narrative>Some valid narrative content here</narrative></observation>';

    await processAgentResponse(
      glitchXml, session, dbManager, sessionManager,
      undefined, 0, null, 'SDK', undefined
    );

    expect(session.forceInit).toBeFalsy();
    expect(session.conversationHistory.length).toBeGreaterThan(0);
  });

  it('does NOT set forceInit on zero observations (model skipped, not overflow)', async () => {
    const session = makeSession();
    const dbManager = makeMockDbManager();
    // When no observations parsed, storeObservations returns empty array
    (dbManager.getSessionStore(undefined) as any).storeObservations = mock(() => ({
      observationIds: [],
      summaryId: null,
      createdAtEpoch: Date.now(),
    }));
    const sessionManager = makeMockSessionManager();

    // No <observation> tags — model chose not to emit XML for uninteresting message.
    // Production data: all real context overflow cases produce <observation> tags with empty fields,
    // never zero tags. Zero tags = healthy model skipping, not overflow.
    const noObsText = 'Skipping - this is a routine health check.';

    await processAgentResponse(
      noObsText, session, dbManager, sessionManager,
      undefined, 0, null, 'SDK', undefined
    );

    expect(session.forceInit).toBeFalsy();
    expect(session.conversationHistory.length).toBeGreaterThan(0);
  });

  it('does NOT set forceInit when response has only summary tags (no observations stored)', async () => {
    const session = makeSession();
    const dbManager = makeMockDbManager();
    // Summary-only response produces no observations
    (dbManager.getSessionStore(undefined) as any).storeObservations = mock(() => ({
      observationIds: [],
      summaryId: 1,
      createdAtEpoch: Date.now(),
    }));
    const sessionManager = makeMockSessionManager();

    const summaryXml = '<summary><request>Fix bug</request><investigated>Checked logs</investigated><learned>Root cause found</learned><completed>Applied fix</completed><next_steps>Monitor</next_steps></summary>';

    await processAgentResponse(
      summaryXml, session, dbManager, sessionManager,
      undefined, 0, null, 'SDK', undefined
    );

    expect(session.forceInit).toBeFalsy();
  });

  it('sets forceInit on empty observation regardless of prompt origin', async () => {
    const session = makeSession();
    const dbManager = makeMockDbManager();
    const sessionManager = makeMockSessionManager();

    // Empty observation stored — detection is unconditional (no messageType dependency)
    const emptyObsXml = '<observation><type>bugfix</type></observation>';

    await processAgentResponse(
      emptyObsXml, session, dbManager, sessionManager,
      undefined, 0, null, 'SDK', undefined
    );

    expect(session.forceInit).toBe(true);
    expect(session.conversationHistory).toEqual([]);
    expect(session.previousMemorySessionId).toBe('test-memory-id');
  });

  it('does NOT set forceInit when observations have valid title+narrative', async () => {
    const session = makeSession();
    const dbManager = makeMockDbManager();
    const sessionManager = makeMockSessionManager();

    const validXml = '<observation><type>discovery</type><title>Valid title</title><narrative>Valid narrative</narrative></observation>';

    await processAgentResponse(
      validXml, session, dbManager, sessionManager,
      undefined, 0, null, 'SDK', undefined
    );

    expect(session.forceInit).toBeFalsy();
    expect(session.conversationHistory.length).toBeGreaterThan(0);
  });

  it('does NOT set forceInit when messageType is undefined (init prompt response)', async () => {
    const session = makeSession();
    const dbManager = makeMockDbManager();
    // Init prompt response may have no observations — that's fine
    (dbManager.getSessionStore(undefined) as any).storeObservations = mock(() => ({
      observationIds: [],
      summaryId: null,
      createdAtEpoch: Date.now(),
    }));
    const sessionManager = makeMockSessionManager();

    await processAgentResponse(
      'Hello, I am your memory observer.', session, dbManager, sessionManager,
      undefined, 0, null, 'SDK', undefined, undefined
    );

    expect(session.forceInit).toBeFalsy();
  });

  it('aborts session after 3 consecutive resets (circuit breaker exhaustion)', async () => {
    const session = makeSession({ contextResetCount: 3 });
    const dbManager = makeMockDbManager();
    const sessionManager = makeMockSessionManager();

    const emptyObsXml = '<observation><type>discovery</type></observation>';

    await processAgentResponse(
      emptyObsXml, session, dbManager, sessionManager,
      undefined, 0, null, 'SDK', undefined
    );

    // forceInit should NOT be set — circuit breaker engaged
    expect(session.forceInit).toBeFalsy();
    // Counter stays at 3 (not incremented)
    expect(session.contextResetCount).toBe(3);
    // CRITICAL: abort() must be called to kill the generator.
    // Without this, generator stays alive in a toxic loop producing empty OBs indefinitely.
    // (skills_workspace session-41: 25+ empty OBs because abort was missing)
    expect(session.abortController.signal.aborted).toBe(true);
  });

  it('resets contextResetCount when a valid observation is stored', async () => {
    const session = makeSession({ contextResetCount: 2 });
    const dbManager = makeMockDbManager();
    const sessionManager = makeMockSessionManager();

    const validXml = '<observation><type>discovery</type><title>Valid</title><narrative>Good</narrative></observation>';

    await processAgentResponse(
      validXml, session, dbManager, sessionManager,
      undefined, 0, null, 'SDK', undefined
    );

    expect(session.forceInit).toBeFalsy();
    expect(session.contextResetCount).toBe(0);
  });
});
