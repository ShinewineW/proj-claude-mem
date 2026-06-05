import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { logger } from '../../../src/utils/logger.js';

// Mock modules that cause import chain issues - MUST be before imports
mock.module('../../../src/services/worker-service.js', () => ({
  updateCursorContextForProject: () => Promise.resolve(),
}));
mock.module('../../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
  fetchWithTimeout: async (url: string | URL | Request, init?: RequestInit) => fetch(url, init),
}));
mock.module('../../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        prompts: { init: 'init', observation: 'obs', summary: 'summary' },
        observation_types: [{ id: 'discovery' }],
        observation_concepts: [],
      }),
      getTypeIcon: () => '📌',
      loadMode: () => {},
    }),
  },
}));

import { processAgentResponse } from '../../../src/services/worker/agents/ResponseProcessor.js';
import type { WorkerRef, StorageResult } from '../../../src/services/worker/agents/types.js';
import type { ActiveSession } from '../../../src/services/worker-types.js';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
import type { SessionManager } from '../../../src/services/worker/SessionManager.js';

describe('ResponseProcessor non-XML handling', () => {
  let loggerSpies: ReturnType<typeof spyOn>[] = [];
  let markFailed: ReturnType<typeof mock>;
  let confirmProcessed: ReturnType<typeof mock>;
  let storeObservations: ReturnType<typeof mock>;
  let mockDbManager: DatabaseManager;
  let mockSessionManager: SessionManager;

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];

    markFailed = mock(() => ({ finalStatus: 'pending', retryCount: 1 }));
    confirmProcessed = mock(() => {});
    storeObservations = mock(() => ({
      observationIds: [],
      summaryId: null,
      createdAtEpoch: 1700000000000,
    } as StorageResult));

    mockDbManager = {
      getSessionStore: () => ({
        storeObservations,
        ensureMemorySessionIdRegistered: mock(() => {}),
        getSessionById: mock(() => ({ memory_session_id: 'memory-session-456' })),
      }),
      getChromaSync: () => ({
        syncObservation: mock(() => Promise.resolve()),
        syncSummary: mock(() => Promise.resolve()),
      }),
    } as unknown as DatabaseManager;

    // STABLE pending store so markFailed/confirmProcessed are inspectable
    const stablePendingStore = { markFailed, confirmProcessed };
    mockSessionManager = {
      getPendingMessageStore: () => stablePendingStore,
    } as unknown as SessionManager;
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  function createMockSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
    return {
      sessionDbId: 1,
      contentSessionId: 'content-session-123',
      memorySessionId: 'memory-session-456',
      project: 'test-project',
      userPrompt: 'Test prompt',
      pendingMessages: [],
      abortController: new AbortController(),
      generatorPromise: null,
      lastPromptNumber: 5,
      startTime: Date.now(),
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      earliestPendingTimestamp: Date.now() - 10000,
      conversationHistory: [],
      currentProvider: 'claude',
      processingMessageIds: [],
      ...overrides,
    } as unknown as ActiveSession;
  }

  it('marks pending messages failed (not confirmed) on non-XML garbage and returns', async () => {
    const session = createMockSession({ processingMessageIds: [11, 22] });
    const garbage = 'Error: 401 Unauthorized — your API key is invalid.';

    await processAgentResponse(
      garbage, session, mockDbManager, mockSessionManager,
      undefined, 0, null, 'TestAgent'
    );

    expect(markFailed).toHaveBeenCalledTimes(2);
    expect(markFailed.mock.calls[0][0]).toBe(11);
    expect(markFailed.mock.calls[1][0]).toBe(22);
    // Must NOT confirm (which would discard the batch) and must NOT store
    expect(confirmProcessed).not.toHaveBeenCalled();
    expect(storeObservations).not.toHaveBeenCalled();
    // processingMessageIds cleared
    expect(session.processingMessageIds).toHaveLength(0);
  });

  it('does NOT markFailed on empty response (text.trim() === "")', async () => {
    const session = createMockSession({ processingMessageIds: [11] });

    await processAgentResponse(
      '   ', session, mockDbManager, mockSessionManager,
      undefined, 0, null, 'TestAgent'
    );

    expect(markFailed).not.toHaveBeenCalled();
  });

  it('does NOT markFailed on intentional skip_summary response', async () => {
    const session = createMockSession({ processingMessageIds: [11] });
    const skip = '<skip_summary reason="no substantive work" />';

    await processAgentResponse(
      skip, session, mockDbManager, mockSessionManager,
      undefined, 0, null, 'TestAgent'
    );

    expect(markFailed).not.toHaveBeenCalled();
    // skip_summary is a valid (storable) path → reaches CLAIM-CONFIRM
    expect(confirmProcessed).toHaveBeenCalledTimes(1);
  });

  it('marks pending messages failed on UNCLOSED <observation> (no parse, #1874)', async () => {
    // Model hit the output-token limit mid-tag: the opening-tag substring guard
    // says "is XML" but the parser requires a CLOSING tag, so 0 observations
    // are produced. The guard must check the PARSED result, not the substring,
    // otherwise these queued messages get confirmed (deleted) with nothing stored.
    const session = createMockSession({ processingMessageIds: [33, 44] });
    const unclosed = '<observation><type>file</type><title>foo';

    await processAgentResponse(
      unclosed, session, mockDbManager, mockSessionManager,
      undefined, 0, null, 'TestAgent'
    );

    expect(markFailed).toHaveBeenCalledTimes(2);
    expect(markFailed.mock.calls[0][0]).toBe(33);
    expect(markFailed.mock.calls[1][0]).toBe(44);
    expect(confirmProcessed).not.toHaveBeenCalled();
    expect(storeObservations).not.toHaveBeenCalled();
    expect(session.processingMessageIds).toHaveLength(0);
  });

  it('marks pending messages failed on prose containing the literal "<summary>" substring', async () => {
    // Prose mentioning the word but never producing a closing <summary> tag —
    // parses to no summary and no observations; must retry, not confirm.
    const session = createMockSession({ processingMessageIds: [55] });
    const prose = 'I would write a <summary> here but the connection dropped';

    await processAgentResponse(
      prose, session, mockDbManager, mockSessionManager,
      undefined, 0, null, 'TestAgent'
    );

    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(markFailed.mock.calls[0][0]).toBe(55);
    expect(confirmProcessed).not.toHaveBeenCalled();
    expect(storeObservations).not.toHaveBeenCalled();
  });
});
