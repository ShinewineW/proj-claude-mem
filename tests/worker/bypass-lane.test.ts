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

  // Message filtering is now done at SQL level in claimNextObservation.
  // See tests/sqlite/pending-message-claim-observation.test.ts for coverage.

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
        abortController: new AbortController(),
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

  describe('G4: recovery restarts consumers for active sessions', () => {
    it('restarts consumers for active sessions after circuit breaker recovery', async () => {
      const lane = new BypassLane();
      (lane as any).state = 'TRIPPED';
      (lane as any).probeProvider = async () => true;
      // Mock consumeLoop to prevent actual execution
      (lane as any).consumeLoop = async () => {};

      // Set up mock sessionManager with 2 active sessions
      const sessions = [
        { sessionDbId: 10, dbPath: '/test/a/mem.db', abortController: new AbortController() },
        { sessionDbId: 20, dbPath: '/test/b/mem.db', abortController: new AbortController() },
      ];
      (lane as any).sessionManager = {
        getActiveSessions: () => sessions.values(),
      };

      await (lane as any).attemptRecovery();

      expect(lane.getState()).toBe('ACTIVE');
      // Both sessions should have consumers started
      expect((lane as any).activeConsumers.has(10)).toBe(true);
      expect((lane as any).activeConsumers.has(20)).toBe(true);
    });

    it('does not duplicate consumers for sessions that already have one', async () => {
      const lane = new BypassLane();
      (lane as any).state = 'TRIPPED';
      (lane as any).probeProvider = async () => true;
      (lane as any).consumeLoop = async () => {};

      const existingAc = new AbortController();
      (lane as any).activeConsumers.set(10, existingAc);

      const sessions = [
        { sessionDbId: 10, dbPath: '/test/a/mem.db', abortController: new AbortController() },
        { sessionDbId: 20, dbPath: '/test/b/mem.db', abortController: new AbortController() },
      ];
      (lane as any).sessionManager = {
        getActiveSessions: () => sessions.values(),
      };

      await (lane as any).attemptRecovery();

      // Session 10 should keep its existing controller
      expect((lane as any).activeConsumers.get(10)).toBe(existingAc);
      // Session 20 should get a new one
      expect((lane as any).activeConsumers.has(20)).toBe(true);
    });
  });

  describe('P6: combined abort signal', () => {
    it('session abort propagates to bypass consumer', async () => {
      const lane = new BypassLane();
      (lane as any).state = 'ACTIVE';

      // Mock consumeLoop to capture the signal it receives
      let capturedSignal: AbortSignal | null = null;
      (lane as any).consumeLoop = async (_session: any, signal: AbortSignal) => {
        capturedSignal = signal;
        // Wait until aborted
        await new Promise<void>(resolve => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      };

      const sessionAc = new AbortController();
      const session = {
        sessionDbId: 1,
        dbPath: '/test/mem.db',
        memorySessionId: 'mem-1',
        project: 'test',
        abortController: sessionAc,
      } as any;

      lane.startForSession(session);

      // Give the async consumeLoop a tick to start
      await new Promise(r => setTimeout(r, 10));

      // Session abort should propagate to bypass consumer
      sessionAc.abort();

      await new Promise(r => setTimeout(r, 10));
      expect(capturedSignal).not.toBeNull();
      expect(capturedSignal!.aborted).toBe(true);
    });

    it('stopForSession still works independently of session abort', async () => {
      const lane = new BypassLane();
      (lane as any).state = 'ACTIVE';

      let capturedSignal: AbortSignal | null = null;
      (lane as any).consumeLoop = async (_session: any, signal: AbortSignal) => {
        capturedSignal = signal;
        await new Promise<void>(resolve => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      };

      const sessionAc = new AbortController();
      const session = {
        sessionDbId: 2,
        dbPath: '/test/mem.db',
        memorySessionId: 'mem-2',
        project: 'test',
        abortController: sessionAc,
      } as any;

      lane.startForSession(session);
      await new Promise(r => setTimeout(r, 10));

      // stopForSession should abort via bypass's own controller
      lane.stopForSession(2);
      await new Promise(r => setTimeout(r, 10));
      expect(capturedSignal!.aborted).toBe(true);
      // Session abort controller should NOT have been touched
      expect(sessionAc.signal.aborted).toBe(false);
    });
  });
});
