import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';

// Module-level mocks
mock.module('../../src/shared/paths.js', () => ({
  DATA_DIR: '/tmp/test-claude-mem',
  DB_PATH: '/tmp/test-claude-mem/claude-mem.db',
  USER_SETTINGS_PATH: '/tmp/test-settings.json',
  ensureDir: () => {},
  ensureAllDataDirs: () => {},
  resolveProjectDbPath: () => '/tmp/test-project/.claude/mem.db',
  resolveProjectRoot: () => '/tmp/test-project',
}));

mock.module('../../src/utils/logger.js', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    failure: () => {},
    success: () => {},
    formatTool: () => 'mock-tool',
  },
}));

mock.module('../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    loadFromFile: () => ({
      CLAUDE_MEM_PROVIDER: 'opencode',
      CLAUDE_MEM_OPENCODE_API_KEY: 'test-key',
      CLAUDE_MEM_OPENCODE_MODEL: 'deepseek-v4-flash',
      CLAUDE_MEM_BYPASS_COOLDOWN_MS: '5000',
      CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: 'false',
      CLAUDE_MEM_CHROMA_ENABLED: 'false',
    }),
  },
}));

mock.module('../../src/shared/EnvManager.js', () => ({
  getCredential: () => 'test-key',
}));

mock.module('../../src/services/worker/ProcessRegistry.js', () => ({
  getProcessBySession: () => undefined,
  ensureProcessExit: async () => {},
}));

mock.module('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        observation_types: [{ id: 'discovery' }, { id: 'bugfix' }],
      }),
      getTypeIcon: (type: string) => ({ discovery: '🔵', bugfix: '🔴', feature: '🟣', change: '✅', refactor: '🔄', decision: '⚖️' }[type] || '📌'),
      loadMode: () => {},
    }),
  },
}));

import { BypassLane } from '../../src/services/worker/BypassLane.js';
import type { ConversationMessage } from '../../src/services/worker-types.js';

describe('truncateHistory', () => {
  const lane = new BypassLane();

  it('returns empty array for empty input', () => {
    const result = (lane as any).truncateHistory([]);
    expect(result).toEqual([]);
  });

  it('returns all messages when within both limits', () => {
    const messages: ConversationMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];
    const result = (lane as any).truncateHistory(messages);
    expect(result).toEqual(messages);
  });

  it('truncates to max message count (keeps most recent)', () => {
    const messages: ConversationMessage[] = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `message ${i}`,
    }));
    const result = (lane as any).truncateHistory(messages);
    // Default max is 20 messages
    expect(result.length).toBe(20);
    // Should keep the LAST 20 (most recent)
    expect(result[0].content).toBe('message 10');
    expect(result[19].content).toBe('message 29');
  });

  it('truncates by token estimate (keeps most recent within budget)', () => {
    const bigContent = 'x'.repeat(120000); // 120k chars ≈ 30000 tokens
    const messages: ConversationMessage[] = Array.from({ length: 5 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: bigContent,
    }));
    const result = (lane as any).truncateHistory(messages);
    // 5 messages × 30000 tokens = 150000 > 100000 limit
    // Should keep 3 messages (3 × 30000 = 90000 < 100000)
    expect(result.length).toBeLessThanOrEqual(3);
    // Most recent kept
    expect(result[result.length - 1]).toEqual(messages[4]);
  });

  it('preserves message order after truncation', () => {
    const messages: ConversationMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
      { role: 'assistant', content: 'fourth' },
    ];
    const result = (lane as any).truncateHistory(messages);
    expect(result.map((m: ConversationMessage) => m.content)).toEqual(['first', 'second', 'third', 'fourth']);
  });
});

describe('processObservation history integration', () => {
  it('reads conversationHistory and writes back after success', async () => {
    const lane = new BypassLane();
    (lane as any).probeProvider = async () => true;
    await lane.initialize();

    const mockConfirmProcessed = mock(() => {});
    const mockStoreObservations = mock(() => ({
      observationIds: [1],
      summaryId: null,
      createdAtEpoch: Date.now(),
    }));

    (lane as any).sessionManager = {
      getPendingMessageStore: () => ({
        confirmProcessed: mockConfirmProcessed,
      }),
    };
    // db mock: storeBypassObservationsForSession opens a transaction and
    // re-reads sdk_sessions.memory_session_id inside it before calling
    // storeObservations. Provide a minimal fake matching that shape.
    const fakeSessionStore: any = {
      storeObservations: mockStoreObservations,
      getObservationsForSession: () => [],
      db: {
        transaction: (fn: () => unknown) => fn,
        prepare: () => ({
          get: () => ({
            memory_session_id: 'test-memory',
            project: 'test-project',
            content_session_id: 'test-content',
          }),
        }),
      },
    };
    (lane as any).dbManager = {
      getSessionStore: () => fakeSessionStore,
      getChromaSync: () => null,
    };

    // Mock callRestApi to return valid XML and capture history arg
    let capturedHistory: any = null;
    (lane as any).callRestApi = async (_prompt: string, _sys: string, _signal: any, history: any) => {
      capturedHistory = history;
      return '<observation><type>discovery</type><title>Test</title><narrative>Found something</narrative></observation>';
    };

    const session = {
      sessionDbId: 1,
      contentSessionId: 'test-content',
      memorySessionId: 'test-memory',
      project: 'test-project',
      dbPath: '/tmp/test.db',
      conversationHistory: [
        { role: 'user', content: 'prior message 1' },
        { role: 'assistant', content: 'prior response 1' },
      ],
      abortController: new AbortController(),
    } as any;

    const message = {
      id: 1,
      tool_name: 'Read',
      tool_input: '{}',
      tool_response: '{}',
      created_at_epoch: Date.now(),
      prompt_number: 1,
      cwd: '/tmp',
    } as any;

    await (lane as any).processObservation(message, session, 'test-memory', AbortSignal.timeout(10000));

    // Verify history was passed to callRestApi
    expect(capturedHistory).toBeDefined();
    expect(capturedHistory.length).toBe(2); // prior messages

    // Verify write-back: 2 prior + 2 new (user prompt + assistant response)
    expect(session.conversationHistory.length).toBe(4);
    expect(session.conversationHistory[2].role).toBe('user');
    expect(session.conversationHistory[3].role).toBe('assistant');
    expect(session.conversationHistory[3].content).toContain('<observation>');
  });

  it('does NOT consume previousMemorySessionId (SDKAgent-only, avoids race)', async () => {
    const lane = new BypassLane();
    (lane as any).probeProvider = async () => true;
    await lane.initialize();

    (lane as any).sessionManager = {
      getPendingMessageStore: () => ({ confirmProcessed: mock(() => {}) }),
    };
    const fakeSessionStore2: any = {
      storeObservations: mock(() => ({ observationIds: [1], summaryId: null, createdAtEpoch: Date.now() })),
      db: {
        transaction: (fn: () => unknown) => fn,
        prepare: () => ({
          get: () => ({
            memory_session_id: 'new-memory',
            project: 'test',
            content_session_id: 'test',
          }),
        }),
      },
    };
    (lane as any).dbManager = {
      getSessionStore: () => fakeSessionStore2,
      getChromaSync: () => null,
    };

    let capturedSystemPrompt = '';
    (lane as any).callRestApi = async (_p: string, sys: string, _s: any, _h: any) => {
      capturedSystemPrompt = sys;
      return '<observation><type>discovery</type><title>New</title><narrative>After reset</narrative></observation>';
    };

    const session = {
      sessionDbId: 1,
      contentSessionId: 'test',
      memorySessionId: 'new-memory',
      previousMemorySessionId: 'old-memory',
      project: 'test',
      dbPath: '/tmp/test.db',
      conversationHistory: [],
      abortController: new AbortController(),
    } as any;

    const message = { id: 1, tool_name: 'Read', tool_input: '{}', tool_response: '{}', created_at_epoch: Date.now(), prompt_number: 1 } as any;

    await (lane as any).processObservation(message, session, 'new-memory', AbortSignal.timeout(10000));

    // Bypass should NOT inject summary or consume previousMemorySessionId
    expect(capturedSystemPrompt).not.toContain('<session_history_summary>');
    // previousMemorySessionId should be untouched — SDKAgent handles it
    expect(session.previousMemorySessionId).toBe('old-memory');
  });
});
