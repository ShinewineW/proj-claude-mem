/**
 * BypassLane ghost-observation filter parity with the main channel.
 * Upstream: thedotmack/claude-mem@e39821298 (#1625) — adapted: filter inlined in
 * BypassLane (fork keeps ResponseProcessor's unfiltered context-overflow path).
 */
import { describe, it, expect, mock } from 'bun:test';

// Mock modules BEFORE any production imports (bun:test requirement)
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
      CLAUDE_MEM_PROVIDER: 'openai',
      CLAUDE_MEM_OPENAI_BASE_URL: 'https://api.deepseek.com',
      CLAUDE_MEM_OPENAI_API_KEY: 'test-key',
      CLAUDE_MEM_OPENAI_MODEL: 'deepseek-v4-flash',
      CLAUDE_MEM_BYPASS_COOLDOWN_MS: '5000',
      CLAUDE_MEM_CHROMA_ENABLED: 'false',
    }),
    get: (key: string) => {
      if (key === 'CLAUDE_MEM_BYPASS_COOLDOWN_MS') return '5000';
      return '';
    },
    getInt: (key: string) => {
      if (key === 'CLAUDE_MEM_BYPASS_COOLDOWN_MS') return 5000;
      return 0;
    },
  },
}));

mock.module('../../src/shared/EnvManager.js', () => ({
  getCredential: () => '',
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
        observation_types: [{ id: 'discovery' }],
      }),
    }),
  },
}));

import { BypassLane } from '../../src/services/worker/BypassLane.js';

function makeLane() {
  const lane = new BypassLane();
  (lane as any).state = 'ACTIVE';
  (lane as any).config = { baseUrl: 'https://api.deepseek.com', apiKey: 'test', model: 'test', cooldownMs: 5000 };
  const storeSpy = mock(() => ({ observationIds: [1] }));
  (lane as any).sessionManager = {
    getPendingMessageStore: () => ({
      claimNextObservation: mock(() => null),
      markFailed: mock(() => {}),
      confirmProcessed: mock(() => {}),
    }),
  };
  (lane as any).dbManager = {
    getSessionStore: () => ({ storeObservations: storeSpy }),
    getChromaSync: () => null,
  };
  return { lane, storeSpy };
}

const message = {
  id: 1, session_db_id: 1, content_session_id: 'cs-1',
  message_type: 'observation', tool_name: 'Read', tool_input: '{}',
  tool_response: '{}', cwd: '/test', prompt_number: 1,
  status: 'processing', retry_count: 0, created_at_epoch: Date.now(),
  last_assistant_message: null, started_processing_at_epoch: Date.now(),
  completed_at_epoch: null,
};
const session = {
  sessionDbId: 1, contentSessionId: 'cs-1', memorySessionId: 'mem-1',
  project: 'test', dbPath: '/test/mem.db', abortController: new AbortController(),
} as any;

describe('BypassLane ghost-observation filter', () => {
  it('throws (treats as empty) when only ghost observations are returned', async () => {
    const { lane, storeSpy } = makeLane();
    // Bare observation: type only, no title/narrative/facts/concepts/files → ghost.
    (lane as any).callRestApi = async () =>
      '<observation><type>discovery</type></observation>';

    await expect(
      (lane as any).processObservation(message, session, 'mem-1', AbortSignal.timeout(5000))
    ).rejects.toThrow('No observations parsed from bypass response');
    expect(storeSpy).not.toHaveBeenCalled();
  });
});
