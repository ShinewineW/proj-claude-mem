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
      CLAUDE_MEM_PROVIDER: 'openai',
      CLAUDE_MEM_OPENAI_BASE_URL: 'https://api.deepseek.com',
      CLAUDE_MEM_OPENAI_API_KEY: 'test-openai-key',
      CLAUDE_MEM_OPENAI_MODEL: 'deepseek-v4-flash',
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
    if (key === 'OPENAI_API_KEY') return 'test-openai-key';
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
      (lane as any).probeProvider = async () => ({ ok: true });
      await lane.initialize();
      expect(lane.getState()).toBe('ACTIVE');
      expect(lane.isActive()).toBe(true);
    });

    it('stays DISABLED if probe fails during initialization', async () => {
      const lane = new BypassLane();
      (lane as any).probeProvider = async () => ({ ok: false, failureReason: 'test failure' });
      await lane.initialize();
      expect(lane.getState()).toBe('DISABLED');
      expect(lane.isActive()).toBe(false);
      lane.shutdown(); // Cleanup cooldown timer scheduled by init failure retry
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
      (lane as any).probeProvider = async () => ({ ok: true });

      await (lane as any).attemptRecovery();
      expect(lane.getState()).toBe('ACTIVE');
      expect((lane as any).consecutiveFailures).toBe(0);
    });

    it('stays TRIPPED on failed probe', async () => {
      const lane = new BypassLane();
      (lane as any).state = 'TRIPPED';
      (lane as any).probeProvider = async () => ({ ok: false, failureReason: 'test failure' });
      // Prevent real cooldown timer from scheduling
      (lane as any).scheduleCooldownProbe = () => {};

      await (lane as any).attemptRecovery();
      expect(lane.getState()).toBe('TRIPPED');
    });
  });

  // Message filtering is now done at SQL level in claimNextObservation.
  // See tests/sqlite/pending-message-claim-observation.test.ts for coverage.

  describe('lifecycle', () => {
    it('stopForSession aborts consumer but leaves map cleanup to .finally()', () => {
      const lane = new BypassLane();
      (lane as any).state = 'ACTIVE';
      const ac = new AbortController();
      (lane as any).activeConsumers.set(1, ac);

      lane.stopForSession(1);
      expect(ac.signal.aborted).toBe(true);
      // Map entry persists until .finally() runs — prevents race with startForSession
      expect((lane as any).activeConsumers.has(1)).toBe(true);
    });

    it('startForSession replaces aborted consumer without waiting for .finally()', () => {
      const lane = new BypassLane();
      (lane as any).state = 'ACTIVE';
      // Simulate old consumer that was stopped (aborted but still in map)
      const oldAc = new AbortController();
      oldAc.abort();
      (lane as any).activeConsumers.set(1, oldAc);

      // startForSession should see the aborted controller and replace it
      const mockSession = { sessionDbId: 1, abortController: new AbortController(), dbPath: '/test' } as any;
      // Mock dependencies to prevent actual consumeLoop execution
      (lane as any).sessionManager = { getPendingMessageStore: () => ({}) };
      (lane as any).dbManager = {};
      lane.startForSession(mockSession);

      // New controller should be in the map, different from the old aborted one
      const newAc = (lane as any).activeConsumers.get(1);
      expect(newAc).not.toBe(oldAc);
      expect(newAc.signal.aborted).toBe(false);
      // Cleanup
      newAc.abort();
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
    it('resolves openai config from settings', () => {
      const lane = new BypassLane();
      const config = (lane as any).resolveConfig();
      expect(config).not.toBeNull();
      expect(config.baseUrl).toBe('https://api.deepseek.com');
      expect(config.apiKey).toBe('test-openai-key');
      expect(config.model).toBe('deepseek-v4-flash');
      expect(config.cooldownMs).toBe(5000);
    });
  });

  describe('G4: recovery restarts consumers for active sessions', () => {
    it('restarts consumers for active sessions after circuit breaker recovery', async () => {
      const lane = new BypassLane();
      (lane as any).state = 'TRIPPED';
      (lane as any).probeProvider = async () => ({ ok: true });
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
      (lane as any).probeProvider = async () => ({ ok: true });
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

describe('F1: empty observation defense', () => {
  it('throws when parseObservations returns empty array', async () => {
    const lane = new BypassLane();
    (lane as any).state = 'ACTIVE';
    (lane as any).config = { baseUrl: 'https://api.deepseek.com', apiKey: 'test', model: 'test', cooldownMs: 5000 };

    // Mock dependencies
    const mockMarkFailed = mock(() => {});
    const mockConfirmProcessed = mock(() => {});
    const mockGetPendingMessageStore = () => ({
      claimNextObservation: mock(() => null),
      markFailed: mockMarkFailed,
      confirmProcessed: mockConfirmProcessed,
    });
    (lane as any).sessionManager = { getPendingMessageStore: mockGetPendingMessageStore };
    (lane as any).dbManager = {
      getSessionStore: () => ({ storeObservations: mock(() => ({ observationIds: [] })) }),
      getChromaSync: () => null,
    };

    // Mock callRestApi to return non-empty content with no <observation> tags
    (lane as any).callRestApi = async () => 'Some response without observation tags';

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

    // processObservation should throw
    await expect(
      (lane as any).processObservation(message, session, 'mem-1', AbortSignal.timeout(5000))
    ).rejects.toThrow('No observations parsed from bypass response');
  });

  it('trips circuit breaker after 3 consecutive empty-observation failures', () => {
    const lane = new BypassLane();
    (lane as any).state = 'ACTIVE';
    (lane as any).consecutiveFailures = 0;

    // Simulate 3 consecutive failures (what consumeLoop catch block does)
    (lane as any).recordFailure();
    expect(lane.getState()).toBe('ACTIVE');
    (lane as any).recordFailure();
    expect(lane.getState()).toBe('ACTIVE');
    (lane as any).recordFailure();
    expect(lane.getState()).toBe('TRIPPED');
  });

  it('consumeLoop calls markFailed + recordFailure when processObservation throws', async () => {
    const lane = new BypassLane();
    (lane as any).state = 'ACTIVE';
    (lane as any).config = { baseUrl: 'https://api.deepseek.com', apiKey: 'test', model: 'test', cooldownMs: 5000 };

    const mockMarkFailed = mock(() => {});
    let claimCount = 0;
    const mockClaimNextObservation = mock(() => {
      claimCount++;
      if (claimCount === 1) {
        return {
          id: 99, session_db_id: 1, content_session_id: 'cs-1',
          message_type: 'observation', tool_name: 'Read', tool_input: '{}',
          tool_response: '{}', cwd: '/test', prompt_number: 1,
          status: 'processing', retry_count: 0, created_at_epoch: Date.now(),
          last_assistant_message: null, started_processing_at_epoch: Date.now(),
          completed_at_epoch: null,
        };
      }
      return null; // No more messages
    });

    (lane as any).sessionManager = {
      getPendingMessageStore: () => ({
        claimNextObservation: mockClaimNextObservation,
        markFailed: mockMarkFailed,
        confirmProcessed: mock(() => {}),
      }),
      notifyMessageAvailable: mock(() => {}),
    };
    (lane as any).dbManager = {
      getSessionStore: () => ({ storeObservations: mock(() => ({ observationIds: [] })) }),
      getChromaSync: () => null,
    };

    // Mock callRestApi to return content without <observation> tags → triggers F1 throw
    (lane as any).callRestApi = async () => 'Response with no observation tags';

    const ac = new AbortController();
    const session = {
      sessionDbId: 1, contentSessionId: 'cs-1', memorySessionId: 'mem-1',
      project: 'test', dbPath: '/test/mem.db', abortController: ac,
    } as any;

    // Run consumeLoop — it processes one message, throws, calls markFailed, then
    // claimNextObservation returns null → abortableSleep → we abort to exit
    setTimeout(() => ac.abort(), 200);
    await (lane as any).consumeLoop(session, ac.signal);

    // Verify the full path: processObservation throw → catch → markFailed
    expect(mockMarkFailed).toHaveBeenCalledTimes(1);
    expect(mockMarkFailed).toHaveBeenCalledWith(99);
    // recordFailure should have incremented consecutiveFailures
    expect((lane as any).consecutiveFailures).toBe(1);
  });
});

describe('F2: stopForSession idempotency', () => {
  it('calling stopForSession twice does not throw', () => {
    const lane = new BypassLane();
    (lane as any).state = 'ACTIVE';
    const ac = new AbortController();
    (lane as any).activeConsumers.set(1, ac);

    lane.stopForSession(1);
    expect(ac.signal.aborted).toBe(true);

    // Second call — should be no-op, not throw
    lane.stopForSession(1);
    expect(ac.signal.aborted).toBe(true);
  });

  it('stopForSession after consumer .finally() cleanup is no-op', () => {
    const lane = new BypassLane();
    // Simulate .finally() already cleaned up the map entry
    expect((lane as any).activeConsumers.has(1)).toBe(false);

    // Should not throw
    lane.stopForSession(1);
  });
});

describe('§1: unified state transition', () => {
  it('G1: initial activation backfills already-running sessions', async () => {
    const lane = new BypassLane();
    (lane as any).probeProvider = async () => ({ ok: true });

    // Mock session manager with 3 active sessions
    const sessions = new Map([
      [1, { sessionDbId: 1, dbPath: '/tmp/test.db', abortController: new AbortController() }],
      [2, { sessionDbId: 2, dbPath: '/tmp/test.db', abortController: new AbortController() }],
      [3, { sessionDbId: 3, dbPath: '/tmp/test.db', abortController: new AbortController() }],
    ]);
    (lane as any).sessionManager = {
      getActiveSessions: () => sessions.values(),
      getPendingMessageStore: () => ({ claimNextObservation: () => null }),
    };

    // Start sessions while DISABLED — should all no-op
    for (const session of sessions.values()) {
      lane.startForSession(session as any);
    }
    expect((lane as any).activeConsumers.size).toBe(0);

    // Mock consumeLoop to prevent actual execution
    (lane as any).consumeLoop = async () => {};

    // Initialize — should backfill all 3
    (lane as any).resolveConfig = () => ({ baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'm', cooldownMs: 1000 });
    await lane.initialize();

    expect(lane.getState()).toBe('ACTIVE');
    expect((lane as any).activeConsumers.size).toBe(3);
  });

  it('G2: initial probe failure schedules cooldown recovery', async () => {
    const lane = new BypassLane();
    let probeCallCount = 0;
    (lane as any).probeProvider = async () => {
      probeCallCount++;
      return probeCallCount === 1
        ? { ok: false, failureReason: 'HTTP 503' }
        : { ok: true };
    };
    (lane as any).sessionManager = {
      getActiveSessions: () => [].values(),
      getPendingMessageStore: () => ({ claimNextObservation: () => null }),
    };
    (lane as any).consumeLoop = async () => {};
    (lane as any).resolveConfig = () => ({ baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'm', cooldownMs: 100 });

    await lane.initialize();
    // State should be DISABLED (not TRIPPED — never was active)
    expect(lane.getState()).toBe('DISABLED');
    // But cooldown timer should be scheduled
    expect((lane as any).cooldownTimer).not.toBeNull();

    // Wait for cooldown to fire
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(lane.getState()).toBe('ACTIVE');
    expect(probeCallCount).toBe(2);

    // Cleanup
    lane.shutdown();
  });
});

describe('§3 partial: counters and getStatus', () => {
  it('G6: getStatus returns correct counter values', async () => {
    const lane = new BypassLane();
    (lane as any).config = { baseUrl: 'https://api.deepseek.com', apiKey: 'test', model: 'test-model', cooldownMs: 1000 };
    (lane as any).state = 'ACTIVE';

    // Simulate 2 successes and 1 failure
    (lane as any).recordSuccess();
    (lane as any).recordSuccess();
    (lane as any).recordFailure();

    const status = lane.getStatus();
    expect(status.state).toBe('ACTIVE');
    expect(status.endpoint).toBe('api.deepseek.com');
    expect(status.model).toBe('test-model');
    expect(status.totalSucceeded).toBe(2);
    expect(status.totalFailed).toBe(1);
    expect(status.consecutiveFailures).toBe(1);
    expect(status.lastSuccessAt).not.toBeNull();
    expect(status.lastFailureAt).not.toBeNull();
  });

  it('getStatus returns null fields when bypass is disabled', () => {
    const lane = new BypassLane();
    const status = lane.getStatus();
    expect(status.state).toBe('DISABLED');
    expect(status.endpoint).toBeNull();
    expect(status.model).toBeNull();
    expect(status.totalClaimed).toBe(0);
    expect(status.totalTrips).toBe(0);
  });

  it('totalTrips increments on circuit breaker trip', () => {
    const lane = new BypassLane();
    (lane as any).config = { baseUrl: 'https://api.deepseek.com', apiKey: 'test', model: 'test', cooldownMs: 1000 };
    (lane as any).state = 'ACTIVE';

    // Trip circuit breaker
    (lane as any).recordFailure();
    (lane as any).recordFailure();
    (lane as any).recordFailure(); // 3rd failure trips

    const status = lane.getStatus();
    expect(status.totalTrips).toBe(1);
    expect(status.lastTripAt).not.toBeNull();

    // Cleanup cooldown timer
    lane.shutdown();
  });
});

describe('§4: ProbeResult structured return', () => {
  it('returns ok:true on successful probe', async () => {
    const lane = new BypassLane();
    (lane as any).config = { baseUrl: 'https://api.deepseek.com', apiKey: 'test', model: 'test', cooldownMs: 1000 };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => new Response('OK', { status: 200 })) as any;
    try {
      const result = await (lane as any).probeProvider();
      expect(result).toEqual({ ok: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns failureReason with HTTP status on non-ok response', async () => {
    const lane = new BypassLane();
    (lane as any).config = { baseUrl: 'https://api.deepseek.com', apiKey: 'test', model: 'test', cooldownMs: 1000 };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => new Response('', { status: 429, statusText: 'Too Many Requests' })) as any;
    try {
      const result = await (lane as any).probeProvider();
      expect(result.ok).toBe(false);
      expect(result.failureReason).toBe('HTTP 429 Too Many Requests');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns sanitized failureReason on network error', async () => {
    const lane = new BypassLane();
    (lane as any).config = { baseUrl: 'https://api.deepseek.com', apiKey: 'test', model: 'test', cooldownMs: 1000 };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => { throw new Error('fetch failed: ECONNREFUSED'); }) as any;
    try {
      const result = await (lane as any).probeProvider();
      expect(result.ok).toBe(false);
      expect(result.failureReason).toContain('ECONNREFUSED');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('redacts the configured API key from error messages', async () => {
    const lane = new BypassLane();
    (lane as any).config = { baseUrl: 'https://api.deepseek.com', apiKey: 'secret-key-123', model: 'deepseek-v4-flash', cooldownMs: 1000 };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      throw new Error('request to https://api.example.com?key=secret-key-123 failed');
    }) as any;
    try {
      const result = await (lane as any).probeProvider();
      expect(result.ok).toBe(false);
      expect(result.failureReason).not.toContain('secret-key-123');
      expect(result.failureReason).toContain('key=***');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns timeout reason on AbortError', async () => {
    const lane = new BypassLane();
    (lane as any).config = { baseUrl: 'https://api.deepseek.com', apiKey: 'test', model: 'test', cooldownMs: 1000 };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      const err = new DOMException('The operation was aborted', 'AbortError');
      throw err;
    }) as any;
    try {
      const result = await (lane as any).probeProvider();
      expect(result.ok).toBe(false);
      expect(result.failureReason).toBe('timeout (15s)');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns timeout reason on TimeoutError (real AbortSignal.timeout)', async () => {
    const lane = new BypassLane();
    (lane as any).config = { baseUrl: 'https://api.deepseek.com', apiKey: 'test', model: 'test', cooldownMs: 1000 };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      const err = new DOMException('The operation timed out.', 'TimeoutError');
      throw err;
    }) as any;
    try {
      const result = await (lane as any).probeProvider();
      expect(result.ok).toBe(false);
      expect(result.failureReason).toBe('timeout (15s)');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns no-config reason when config is null', async () => {
    const lane = new BypassLane();
    (lane as any).config = null;
    const result = await (lane as any).probeProvider();
    expect(result).toEqual({ ok: false, failureReason: 'no config' });
  });
});
