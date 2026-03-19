import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';

// Module-level mocks (must be before production code imports)
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
      CLAUDE_MEM_PROVIDER: 'gemini',
      CLAUDE_MEM_GEMINI_API_KEY: 'test-gemini-key',
      CLAUDE_MEM_GEMINI_MODEL: 'gemini-2.5-flash',
      CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: 'false',
      CLAUDE_MEM_OPENROUTER_API_KEY: '',
      CLAUDE_MEM_OPENROUTER_MODEL: 'xiaomi/mimo-v2-flash:free',
      CLAUDE_MEM_BYPASS_COOLDOWN_MS: '5000',
      CLAUDE_MEM_CHROMA_ENABLED: 'false',
    }),
    get: (key: string) => {
      if (key === 'CLAUDE_MEM_DATA_DIR') return '/tmp/test-claude-mem';
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
  getCredential: (key: string) => {
    if (key === 'GEMINI_API_KEY') return 'test-gemini-key';
    return '';
  },
}));

mock.module('../../src/services/worker/ProcessRegistry.js', () => ({
  getProcessBySession: () => undefined,
  ensureProcessExit: async () => {},
}));

import { BypassLane, type BypassState } from '../../src/services/worker/BypassLane.js';
import type { PersistentPendingMessage } from '../../src/services/sqlite/PendingMessageStore.js';

describe('BypassLane', () => {
  describe('state machine', () => {
    it('starts in DISABLED state', () => {
      const lane = new BypassLane();
      expect(lane.getState()).toBe('DISABLED');
      expect(lane.isActive()).toBe(false);
    });

    it('transitions to ACTIVE after successful probe', async () => {
      const lane = new BypassLane();
      // Mock probe to succeed
      (lane as any).probeProvider = async () => true;
      await lane.initialize();
      expect(lane.getState()).toBe('ACTIVE');
      expect(lane.isActive()).toBe(true);
    });

    it('stays DISABLED if probe fails during initialization', async () => {
      const lane = new BypassLane();
      (lane as any).probeProvider = async () => false;
      await lane.initialize();
      expect(lane.getState()).toBe('DISABLED');
      expect(lane.isActive()).toBe(false);
    });
  });

  describe('circuit breaker', () => {
    it('trips after 3 consecutive failures', () => {
      const lane = new BypassLane();
      (lane as any).state = 'ACTIVE';
      (lane as any).consecutiveFailures = 0;

      (lane as any).recordFailure();
      expect(lane.getState()).toBe('ACTIVE');
      (lane as any).recordFailure();
      expect(lane.getState()).toBe('ACTIVE');
      (lane as any).recordFailure();
      expect(lane.getState()).toBe('TRIPPED');
      expect(lane.isActive()).toBe(false);
    });

    it('resets failure count on success', () => {
      const lane = new BypassLane();
      (lane as any).state = 'ACTIVE';
      (lane as any).consecutiveFailures = 2;

      (lane as any).recordSuccess();
      expect((lane as any).consecutiveFailures).toBe(0);
      expect(lane.getState()).toBe('ACTIVE');
    });

    it('transitions from TRIPPED to ACTIVE on successful probe', async () => {
      const lane = new BypassLane();
      (lane as any).state = 'TRIPPED';
      (lane as any).probeProvider = async () => true;

      await (lane as any).attemptRecovery();
      expect(lane.getState()).toBe('ACTIVE');
      expect((lane as any).consecutiveFailures).toBe(0);
    });

    it('stays TRIPPED on failed probe', async () => {
      const lane = new BypassLane();
      (lane as any).state = 'TRIPPED';
      (lane as any).probeProvider = async () => false;
      // Prevent real cooldown timer from scheduling
      (lane as any).scheduleCooldownProbe = () => {};

      await (lane as any).attemptRecovery();
      expect(lane.getState()).toBe('TRIPPED');
    });
  });

  describe('message filtering', () => {
    it('skips summarize messages', () => {
      const lane = new BypassLane();
      const shouldProcess = (lane as any).shouldProcessMessage({
        message_type: 'summarize',
      } as PersistentPendingMessage);
      expect(shouldProcess).toBe(false);
    });

    it('processes observation messages', () => {
      const lane = new BypassLane();
      const shouldProcess = (lane as any).shouldProcessMessage({
        message_type: 'observation',
      } as PersistentPendingMessage);
      expect(shouldProcess).toBe(true);
    });
  });

  describe('lifecycle', () => {
    it('stopForSession aborts and removes consumer', () => {
      const lane = new BypassLane();
      (lane as any).state = 'ACTIVE';
      const ac = new AbortController();
      (lane as any).activeConsumers.set(1, ac);

      lane.stopForSession(1);
      expect(ac.signal.aborted).toBe(true);
      expect((lane as any).activeConsumers.has(1)).toBe(false);
    });

    it('shutdown clears all consumers and cooldown timer', () => {
      const lane = new BypassLane();
      (lane as any).state = 'ACTIVE';
      const ac1 = new AbortController();
      const ac2 = new AbortController();
      (lane as any).activeConsumers.set(1, ac1);
      (lane as any).activeConsumers.set(2, ac2);
      (lane as any).cooldownTimer = setTimeout(() => {}, 60000);

      lane.shutdown();
      expect(ac1.signal.aborted).toBe(true);
      expect(ac2.signal.aborted).toBe(true);
      expect((lane as any).activeConsumers.size).toBe(0);
      expect((lane as any).cooldownTimer).toBeNull();
      expect(lane.getState()).toBe('DISABLED');
    });

    it('startForSession is no-op when DISABLED', () => {
      const lane = new BypassLane();
      (lane as any).state = 'DISABLED';
      const session = { sessionDbId: 1, dbPath: '/test/mem.db' } as any;
      lane.startForSession(session);
      expect((lane as any).activeConsumers.size).toBe(0);
    });

    it('startForSession is no-op when TRIPPED', () => {
      const lane = new BypassLane();
      (lane as any).state = 'TRIPPED';
      const session = { sessionDbId: 1, dbPath: '/test/mem.db' } as any;
      lane.startForSession(session);
      expect((lane as any).activeConsumers.size).toBe(0);
    });

    it('startForSession does not duplicate consumers', () => {
      const lane = new BypassLane();
      (lane as any).state = 'ACTIVE';
      // Mock consumeLoop to prevent actual execution
      (lane as any).consumeLoop = async () => {};
      const session = {
        sessionDbId: 1,
        dbPath: '/test/mem.db',
        memorySessionId: 'mem-1',
        project: 'test',
      } as any;

      lane.startForSession(session);
      const firstAc = (lane as any).activeConsumers.get(1);
      lane.startForSession(session); // Idempotent
      expect((lane as any).activeConsumers.get(1)).toBe(firstAc);
    });

    it('stopForSession is no-op for unknown session', () => {
      const lane = new BypassLane();
      lane.stopForSession(999); // Should not throw
      expect((lane as any).activeConsumers.size).toBe(0);
    });
  });

  describe('config resolution', () => {
    it('resolves gemini config from settings', () => {
      const lane = new BypassLane();
      const config = (lane as any).resolveConfig();
      expect(config).not.toBeNull();
      expect(config.provider).toBe('gemini');
      expect(config.apiKey).toBe('test-gemini-key');
      expect(config.model).toBe('gemini-2.5-flash');
      expect(config.cooldownMs).toBe(5000);
    });
  });
});
