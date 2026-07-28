/**
 * Property-based tests for BypassLane invariants.
 *
 * Since fast-check is not available, uses manual randomized input generation
 * with bun:test. Each property is tested over multiple random sequences to
 * achieve confidence comparable to property-based testing.
 */

import { describe, it, expect, beforeEach, mock, afterAll } from 'bun:test';

// Module-level mocks (must be before production code imports)
// __CONFINED_MOCKS__: bun's mock.module() is process-wide and mock.restore() does
// NOT undo it, so a partial stub below would leak into every test file
// loaded after this one (project-isolation suites fail that way). Capture
// the real modules first and re-register them in afterAll so the stubs
// stay confined to this file.
import * as __real0 from '../../src/shared/paths.js';
import * as __real1 from '../../src/shared/SettingsDefaultsManager.js';
const __REAL_MODULES: Array<[string, unknown]> = [
  ['../../src/shared/paths.js', { ...__real0 }],
  ['../../src/shared/SettingsDefaultsManager.js', { ...__real1 }],
];
afterAll(() => {
  for (const [spec, real] of __REAL_MODULES) mock.module(spec, () => real);
});

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

import { BypassLane, type BypassState, type BypassStatus } from '../../src/services/worker/BypassLane.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Action = 'success' | 'failure';

/** Generate a random action sequence of given length. */
function randomActions(length: number): Action[] {
  const actions: Action[] = [];
  for (let i = 0; i < length; i++) {
    actions.push(Math.random() < 0.5 ? 'success' : 'failure');
  }
  return actions;
}

/** Generate an action sequence biased towards a given action. */
function biasedActions(length: number, action: Action, bias: number): Action[] {
  const actions: Action[] = [];
  for (let i = 0; i < length; i++) {
    actions.push(Math.random() < bias ? action : (action === 'success' ? 'failure' : 'success'));
  }
  return actions;
}

/** Apply an action sequence to a BypassLane instance (must already be ACTIVE). */
function applyActions(lane: BypassLane, actions: Action[]): void {
  for (const action of actions) {
    // Stop applying if TRIPPED — matches real consumeLoop behavior (returns on TRIPPED)
    if (lane.getState() === 'TRIPPED') return;
    if (action === 'success') {
      (lane as any).recordSuccess();
    } else {
      (lane as any).recordFailure();
    }
  }
}

/** Create a fresh BypassLane in ACTIVE state with config set. */
function createActiveLane(): BypassLane {
  const lane = new BypassLane();
  (lane as any).config = { baseUrl: 'https://api.deepseek.com', apiKey: 'test', model: 'test', cooldownMs: 999999 };
  (lane as any).state = 'ACTIVE';
  (lane as any).consecutiveFailures = 0;
  return lane;
}

// Number of random trials per property
const NUM_TRIALS = 200;
const MAX_SEQUENCE_LENGTH = 50;

// ---------------------------------------------------------------------------
// Property 1: Counter monotonicity
// totalClaimed >= totalSucceeded + totalFailed (always)
// ---------------------------------------------------------------------------
describe('Property 1: Counter monotonicity', () => {
  it('totalClaimed >= totalSucceeded + totalFailed after random action sequences', () => {
    for (let trial = 0; trial < NUM_TRIALS; trial++) {
      const lane = createActiveLane();
      const seqLen = Math.floor(Math.random() * MAX_SEQUENCE_LENGTH) + 1;
      const actions = randomActions(seqLen);

      // Simulate claimed count: each action represents a claimed + processed message
      for (const action of actions) {
        if (lane.getState() === 'TRIPPED') break;
        (lane as any).counters.claimed++;
        if (action === 'success') {
          (lane as any).recordSuccess();
        } else {
          (lane as any).recordFailure();
        }
      }

      const status = lane.getStatus();
      expect(status.totalClaimed).toBeGreaterThanOrEqual(
        status.totalSucceeded + status.totalFailed
      );

      lane.shutdown();
    }
  });

  it('holds when claimed equals succeeded + failed (no in-flight)', () => {
    for (let trial = 0; trial < NUM_TRIALS; trial++) {
      const lane = createActiveLane();
      const seqLen = Math.floor(Math.random() * MAX_SEQUENCE_LENGTH) + 1;
      const actions = randomActions(seqLen);

      let applied = 0;
      for (const action of actions) {
        if (lane.getState() === 'TRIPPED') break;
        (lane as any).counters.claimed++;
        if (action === 'success') {
          (lane as any).recordSuccess();
        } else {
          (lane as any).recordFailure();
        }
        applied++;
      }

      const status = lane.getStatus();
      // When every claimed message has a result, equality holds
      expect(status.totalClaimed).toBe(status.totalSucceeded + status.totalFailed);

      lane.shutdown();
    }
  });

  it('claimed can exceed succeeded + failed when messages are in-flight', () => {
    const lane = createActiveLane();
    // Claim 5 messages but only record 3 outcomes
    (lane as any).counters.claimed = 5;
    (lane as any).recordSuccess();
    (lane as any).recordSuccess();
    (lane as any).recordFailure();

    const status = lane.getStatus();
    expect(status.totalClaimed).toBe(5);
    expect(status.totalSucceeded + status.totalFailed).toBe(3);
    expect(status.totalClaimed).toBeGreaterThanOrEqual(status.totalSucceeded + status.totalFailed);

    lane.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Property 2: State machine validity
// Only valid transitions: DISABLED->ACTIVE, ACTIVE->TRIPPED, TRIPPED->ACTIVE,
// and shutdown can go to DISABLED from any state.
// ---------------------------------------------------------------------------
describe('Property 2: State machine validity', () => {
  const VALID_TRANSITIONS: Record<BypassState, Set<BypassState>> = {
    DISABLED: new Set(['ACTIVE', 'DISABLED']),     // init probe success, shutdown
    ACTIVE: new Set(['TRIPPED', 'DISABLED', 'ACTIVE']),  // circuit breaker, shutdown, self (no-op)
    TRIPPED: new Set(['ACTIVE', 'DISABLED', 'TRIPPED']), // recovery, shutdown, self (repeated failure)
  };

  it('all random action sequences produce only valid state transitions', () => {
    for (let trial = 0; trial < NUM_TRIALS; trial++) {
      const lane = createActiveLane();
      const seqLen = Math.floor(Math.random() * MAX_SEQUENCE_LENGTH) + 1;
      const actions = randomActions(seqLen);

      let prevState: BypassState = 'ACTIVE';

      for (const action of actions) {
        const before = lane.getState();
        if (before === 'TRIPPED') break;

        if (action === 'success') {
          (lane as any).recordSuccess();
        } else {
          (lane as any).recordFailure();
        }

        const after = lane.getState();
        if (before !== after) {
          expect(VALID_TRANSITIONS[before].has(after)).toBe(true);
        }
        prevState = after;
      }

      lane.shutdown();
    }
  });

  it('DISABLED -> ACTIVE only via transitionToActive', async () => {
    const lane = new BypassLane();
    expect(lane.getState()).toBe('DISABLED');

    // recordSuccess/recordFailure should not change state from DISABLED
    (lane as any).recordSuccess();
    expect(lane.getState()).toBe('DISABLED');
    (lane as any).recordFailure();
    expect(lane.getState()).toBe('DISABLED');

    // transitionToActive should change it
    (lane as any).config = { baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'm', cooldownMs: 1000 };
    (lane as any).sessionManager = { getActiveSessions: () => [].values() };
    (lane as any).transitionToActive('init');
    expect(lane.getState()).toBe('ACTIVE');

    lane.shutdown();
  });

  it('ACTIVE -> TRIPPED only via recordFailure when consecutiveFailures >= maxFailures', () => {
    const lane = createActiveLane();

    // 1 failure: still ACTIVE
    (lane as any).recordFailure();
    expect(lane.getState()).toBe('ACTIVE');

    // 2 failures: still ACTIVE
    (lane as any).recordFailure();
    expect(lane.getState()).toBe('ACTIVE');

    // 3 failures: TRIPPED
    (lane as any).recordFailure();
    expect(lane.getState()).toBe('TRIPPED');

    lane.shutdown();
  });

  it('TRIPPED -> ACTIVE only via transitionToActive(recovery)', async () => {
    const lane = createActiveLane();
    // Trip it
    (lane as any).recordFailure();
    (lane as any).recordFailure();
    (lane as any).recordFailure();
    expect(lane.getState()).toBe('TRIPPED');

    // recordSuccess should NOT change state from TRIPPED
    (lane as any).recordSuccess();
    expect(lane.getState()).toBe('TRIPPED');

    // transitionToActive changes it
    (lane as any).sessionManager = { getActiveSessions: () => [].values() };
    (lane as any).transitionToActive('recovery');
    expect(lane.getState()).toBe('ACTIVE');

    lane.shutdown();
  });

  it('shutdown always transitions to DISABLED from any state', () => {
    for (const initialState of ['DISABLED', 'ACTIVE', 'TRIPPED'] as BypassState[]) {
      const lane = new BypassLane();
      (lane as any).state = initialState;
      lane.shutdown();
      expect(lane.getState()).toBe('DISABLED');
    }
  });
});

// ---------------------------------------------------------------------------
// Property 3: Circuit breaker threshold
// TRIPPED only occurs after exactly maxFailures (3) consecutive failures
// ---------------------------------------------------------------------------
describe('Property 3: Circuit breaker threshold', () => {
  it('never trips with fewer than 3 consecutive failures', () => {
    for (let trial = 0; trial < NUM_TRIALS; trial++) {
      const lane = createActiveLane();
      const seqLen = Math.floor(Math.random() * MAX_SEQUENCE_LENGTH) + 1;
      const actions = randomActions(seqLen);

      let consecutiveFailures = 0;
      let tripped = false;

      for (const action of actions) {
        if (lane.getState() === 'TRIPPED') {
          tripped = true;
          break;
        }
        if (action === 'success') {
          (lane as any).recordSuccess();
          consecutiveFailures = 0;
        } else {
          consecutiveFailures++;
          (lane as any).recordFailure();
          if (consecutiveFailures >= 3 && lane.getState() === 'TRIPPED') {
            tripped = true;
            break;
          }
        }
      }

      // If tripped, verify it happened at exactly 3 consecutive failures
      if (tripped) {
        expect(consecutiveFailures).toBeGreaterThanOrEqual(3);
      }

      lane.shutdown();
    }
  });

  it('always trips on exactly the 3rd consecutive failure', () => {
    for (let trial = 0; trial < 50; trial++) {
      const lane = createActiveLane();

      // Random number of successes first
      const prefixSuccesses = Math.floor(Math.random() * 10);
      for (let i = 0; i < prefixSuccesses; i++) {
        (lane as any).recordSuccess();
      }
      expect(lane.getState()).toBe('ACTIVE');

      // Exactly 2 failures: not tripped
      (lane as any).recordFailure();
      (lane as any).recordFailure();
      expect(lane.getState()).toBe('ACTIVE');

      // 3rd failure: tripped
      (lane as any).recordFailure();
      expect(lane.getState()).toBe('TRIPPED');

      lane.shutdown();
    }
  });

  it('a success between failures resets the counter, preventing trip', () => {
    for (let trial = 0; trial < NUM_TRIALS; trial++) {
      const lane = createActiveLane();

      // Pattern: F, F, S, F, F — should never trip (max 2 consecutive)
      (lane as any).recordFailure();
      (lane as any).recordFailure();
      (lane as any).recordSuccess();
      (lane as any).recordFailure();
      (lane as any).recordFailure();

      expect(lane.getState()).toBe('ACTIVE');
      expect((lane as any).consecutiveFailures).toBe(2);

      lane.shutdown();
    }
  });

  it('maxFailures value is exactly 3', () => {
    const lane = new BypassLane();
    expect((lane as any).maxFailures).toBe(3);
    lane.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Property 4: Counter reset semantics
// consecutiveFailures resets to 0 on recordSuccess OR transitionToActive,
// never on recordFailure
// ---------------------------------------------------------------------------
describe('Property 4: Counter reset semantics', () => {
  it('recordSuccess always resets consecutiveFailures to 0', () => {
    for (let trial = 0; trial < NUM_TRIALS; trial++) {
      const lane = createActiveLane();

      // Random failures (0 to 2, not enough to trip)
      const numFailures = Math.floor(Math.random() * 3);
      for (let i = 0; i < numFailures; i++) {
        (lane as any).recordFailure();
      }

      expect((lane as any).consecutiveFailures).toBe(numFailures);

      // recordSuccess resets
      (lane as any).recordSuccess();
      expect((lane as any).consecutiveFailures).toBe(0);

      lane.shutdown();
    }
  });

  it('transitionToActive always resets consecutiveFailures to 0', () => {
    for (const source of ['init', 'recovery'] as const) {
      for (let trial = 0; trial < 50; trial++) {
        const lane = new BypassLane();
        (lane as any).config = { baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'm', cooldownMs: 999999 };
        (lane as any).sessionManager = { getActiveSessions: () => [].values() };

        // Set random consecutive failure count
        const failures = Math.floor(Math.random() * 10);
        (lane as any).consecutiveFailures = failures;
        (lane as any).state = source === 'init' ? 'DISABLED' : 'TRIPPED';

        (lane as any).transitionToActive(source);
        expect((lane as any).consecutiveFailures).toBe(0);
        expect(lane.getState()).toBe('ACTIVE');

        lane.shutdown();
      }
    }
  });

  it('recordFailure never decreases consecutiveFailures', () => {
    for (let trial = 0; trial < NUM_TRIALS; trial++) {
      const lane = createActiveLane();
      const seqLen = Math.floor(Math.random() * 3) + 1; // 1-3 failures (won't always trip)

      let prevCount = 0;
      for (let i = 0; i < seqLen; i++) {
        if (lane.getState() === 'TRIPPED') break;
        (lane as any).recordFailure();
        const currentCount = (lane as any).consecutiveFailures;
        expect(currentCount).toBeGreaterThan(prevCount);
        prevCount = currentCount;
      }

      lane.shutdown();
    }
  });

  it('recordFailure strictly increments consecutiveFailures by 1', () => {
    const lane = createActiveLane();
    for (let i = 1; i <= 3; i++) {
      if (lane.getState() === 'TRIPPED') break;
      (lane as any).recordFailure();
      expect((lane as any).consecutiveFailures).toBe(i);
    }
    lane.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Property 5: Probe result completeness
// probeProvider always returns {ok: boolean, failureReason?: string} — never null/undefined
// ---------------------------------------------------------------------------
describe('Property 5: Probe result completeness', () => {
  const originalFetch = globalThis.fetch;

  it('returns well-formed ProbeResult for all fetch outcomes', async () => {
    type FetchBehavior = { name: string; impl: () => Promise<Response> };
    const fetchBehaviors: FetchBehavior[] = [
      { name: 'success', impl: async () => new Response('OK', { status: 200 }) },
      { name: '400', impl: async () => new Response('Bad Request', { status: 400 }) },
      { name: '401', impl: async () => new Response('Unauthorized', { status: 401 }) },
      { name: '403', impl: async () => new Response('Forbidden', { status: 403 }) },
      { name: '404', impl: async () => new Response('Not Found', { status: 404 }) },
      { name: '429', impl: async () => new Response('Rate Limited', { status: 429 }) },
      { name: '500', impl: async () => new Response('Server Error', { status: 500 }) },
      { name: '503', impl: async () => new Response('Unavailable', { status: 503 }) },
      { name: 'network error', impl: async () => { throw new Error('ECONNREFUSED'); } },
      { name: 'timeout (AbortError)', impl: async () => { throw new DOMException('aborted', 'AbortError'); } },
      { name: 'timeout (TimeoutError)', impl: async () => { throw new DOMException('timeout', 'TimeoutError'); } },
      { name: 'generic error', impl: async () => { throw new Error('Something went wrong'); } },
      { name: 'non-Error throw', impl: async () => { throw 'string error'; } },
    ];

    for (const behavior of fetchBehaviors) {
      const lane = new BypassLane();
      (lane as any).config = {
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'test-key',
        model: 'test-model',
        cooldownMs: 1000,
      };

      globalThis.fetch = mock(behavior.impl) as any;
      try {
        const result = await (lane as any).probeProvider();

        // Property: result is never null or undefined
        expect(result).not.toBeNull();
        expect(result).not.toBeUndefined();

        // Property: ok is always a boolean
        expect(typeof result.ok).toBe('boolean');

        // Property: failureReason is string or undefined (never null, number, etc.)
        if (result.failureReason !== undefined) {
          expect(typeof result.failureReason).toBe('string');
        }

        // Property: ok === true implies no failureReason
        if (result.ok) {
          expect(result.failureReason).toBeUndefined();
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });

  it('returns ProbeResult with no config', async () => {
    const lane = new BypassLane();
    (lane as any).config = null;

    const result = await (lane as any).probeProvider();

    expect(result).not.toBeNull();
    expect(result).not.toBeUndefined();
    expect(typeof result.ok).toBe('boolean');
    expect(result.ok).toBe(false);
    expect(typeof result.failureReason).toBe('string');
  });

  it('failureReason never contains the configured API key (error-body echo)', async () => {
    const secret = 'sk-secret-key-abcdef1234567890';
    const lane = new BypassLane();
    (lane as any).config = {
      baseUrl: 'https://api.deepseek.com',
      apiKey: secret,
      model: 'test-model',
      cooldownMs: 1000,
    };

    // The endpoint echoes the key back in the error body; redactSecret() must strip it
    // before it reaches failureReason. A vacuously-passing test (probe early-returns,
    // never fetches) would NOT exercise redaction — so use a real baseUrl + 401 body.
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ error: { message: `bad key ${secret}` } }), { status: 401 }),
    ) as any;

    try {
      const result = await (lane as any).probeProvider();
      expect(result.ok).toBe(false);
      expect(result.failureReason).toBeDefined();
      expect(result.failureReason).not.toContain(secret);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Property 6: getStatus snapshot consistency
// All fields in BypassStatus are internally consistent
// ---------------------------------------------------------------------------
describe('Property 6: getStatus snapshot consistency', () => {
  it('totalTrips > 0 implies lastTripAt is not null', () => {
    for (let trial = 0; trial < NUM_TRIALS; trial++) {
      const lane = createActiveLane();
      const seqLen = Math.floor(Math.random() * MAX_SEQUENCE_LENGTH) + 1;
      const actions = randomActions(seqLen);

      for (const action of actions) {
        if (lane.getState() === 'TRIPPED') break;
        if (action === 'success') {
          (lane as any).counters.claimed++;
          (lane as any).recordSuccess();
        } else {
          (lane as any).counters.claimed++;
          (lane as any).recordFailure();
        }
      }

      const status = lane.getStatus();
      if (status.totalTrips > 0) {
        expect(status.lastTripAt).not.toBeNull();
      }

      lane.shutdown();
    }
  });

  it('totalSucceeded > 0 implies lastSuccessAt is not null', () => {
    for (let trial = 0; trial < NUM_TRIALS; trial++) {
      const lane = createActiveLane();
      const actions = randomActions(Math.floor(Math.random() * 20) + 1);

      for (const action of actions) {
        if (lane.getState() === 'TRIPPED') break;
        if (action === 'success') {
          (lane as any).recordSuccess();
        } else {
          (lane as any).recordFailure();
        }
      }

      const status = lane.getStatus();
      if (status.totalSucceeded > 0) {
        expect(status.lastSuccessAt).not.toBeNull();
      }
      if (status.lastSuccessAt === null) {
        expect(status.totalSucceeded).toBe(0);
      }

      lane.shutdown();
    }
  });

  it('totalFailed > 0 implies lastFailureAt is not null', () => {
    for (let trial = 0; trial < NUM_TRIALS; trial++) {
      const lane = createActiveLane();
      const actions = randomActions(Math.floor(Math.random() * 20) + 1);

      for (const action of actions) {
        if (lane.getState() === 'TRIPPED') break;
        if (action === 'success') {
          (lane as any).recordSuccess();
        } else {
          (lane as any).recordFailure();
        }
      }

      const status = lane.getStatus();
      if (status.totalFailed > 0) {
        expect(status.lastFailureAt).not.toBeNull();
      }
      if (status.lastFailureAt === null) {
        expect(status.totalFailed).toBe(0);
      }

      lane.shutdown();
    }
  });

  it('state=ACTIVE implies consecutiveFailures < maxFailures (3)', () => {
    for (let trial = 0; trial < NUM_TRIALS; trial++) {
      const lane = createActiveLane();
      const actions = randomActions(Math.floor(Math.random() * 20) + 1);

      for (const action of actions) {
        if (lane.getState() === 'TRIPPED') break;
        if (action === 'success') {
          (lane as any).recordSuccess();
        } else {
          (lane as any).recordFailure();
        }
      }

      const status = lane.getStatus();
      if (status.state === 'ACTIVE') {
        expect(status.consecutiveFailures).toBeLessThan(3);
      }

      lane.shutdown();
    }
  });

  it('state=TRIPPED implies consecutiveFailures >= maxFailures (3)', () => {
    for (let trial = 0; trial < NUM_TRIALS; trial++) {
      const lane = createActiveLane();
      const actions = biasedActions(
        Math.floor(Math.random() * 20) + 3,
        'failure',
        0.7,
      );

      for (const action of actions) {
        if (lane.getState() === 'TRIPPED') break;
        if (action === 'success') {
          (lane as any).recordSuccess();
        } else {
          (lane as any).recordFailure();
        }
      }

      const status = lane.getStatus();
      if (status.state === 'TRIPPED') {
        expect(status.consecutiveFailures).toBeGreaterThanOrEqual(3);
      }

      lane.shutdown();
    }
  });

  it('activeConsumers count is non-negative', () => {
    const lane = new BypassLane();
    const status = lane.getStatus();
    expect(status.activeConsumers).toBeGreaterThanOrEqual(0);
    lane.shutdown();
  });

  it('all counter fields are non-negative', () => {
    for (let trial = 0; trial < NUM_TRIALS; trial++) {
      const lane = createActiveLane();
      const actions = randomActions(Math.floor(Math.random() * 20) + 1);

      for (const action of actions) {
        if (lane.getState() === 'TRIPPED') break;
        (lane as any).counters.claimed++;
        if (action === 'success') {
          (lane as any).recordSuccess();
        } else {
          (lane as any).recordFailure();
        }
      }

      const status = lane.getStatus();
      expect(status.totalClaimed).toBeGreaterThanOrEqual(0);
      expect(status.totalSucceeded).toBeGreaterThanOrEqual(0);
      expect(status.totalFailed).toBeGreaterThanOrEqual(0);
      expect(status.totalTrips).toBeGreaterThanOrEqual(0);
      expect(status.consecutiveFailures).toBeGreaterThanOrEqual(0);
      expect(status.activeConsumers).toBeGreaterThanOrEqual(0);

      lane.shutdown();
    }
  });

  it('config fields are consistent: endpoint and model are both null or both non-null', () => {
    // Without config
    const lane1 = new BypassLane();
    const s1 = lane1.getStatus();
    expect(s1.endpoint === null && s1.model === null).toBe(true);

    // With config
    const lane2 = createActiveLane();
    const s2 = lane2.getStatus();
    expect(s2.endpoint !== null && s2.model !== null).toBe(true);

    lane1.shutdown();
    lane2.shutdown();
  });

  it('timestamp ordering: lastSuccessAt and lastFailureAt are valid ISO strings when present', () => {
    const lane = createActiveLane();
    (lane as any).recordSuccess();
    (lane as any).recordFailure();

    const status = lane.getStatus();
    if (status.lastSuccessAt) {
      expect(new Date(status.lastSuccessAt).toISOString()).toBe(status.lastSuccessAt);
    }
    if (status.lastFailureAt) {
      expect(new Date(status.lastFailureAt).toISOString()).toBe(status.lastFailureAt);
    }
    if (status.lastTripAt) {
      expect(new Date(status.lastTripAt).toISOString()).toBe(status.lastTripAt);
    }
    if (status.lastProbeAt) {
      expect(new Date(status.lastProbeAt).toISOString()).toBe(status.lastProbeAt);
    }

    lane.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Property 7: getQueueStats SQL correctness
// pendingCount + processingCount >= 0, and sum matches getPendingCount
// ---------------------------------------------------------------------------
describe('Property 7: getQueueStats SQL correctness', () => {
  // These tests use in-memory SQLite to verify the SQL queries directly

  it('getQueueStats counts are always non-negative', async () => {
    // Dynamic import to avoid mock interference with DB modules
    const { default: BunDatabase } = await import('bun:sqlite');

    for (let trial = 0; trial < 20; trial++) {
      const db = new BunDatabase(':memory:');
      db.exec('PRAGMA journal_mode = WAL');

      // Create minimal schema
      db.exec(`
        CREATE TABLE IF NOT EXISTS sdk_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content_session_id TEXT NOT NULL,
          memory_session_id TEXT,
          project TEXT DEFAULT '',
          user_prompt TEXT DEFAULT '',
          started_at TEXT DEFAULT (datetime('now')),
          started_at_epoch INTEGER DEFAULT (strftime('%s','now') * 1000),
          completed_at TEXT,
          completed_at_epoch INTEGER,
          status TEXT DEFAULT 'active',
          prompt_counter INTEGER DEFAULT 0
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS pending_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_db_id INTEGER NOT NULL,
          content_session_id TEXT NOT NULL,
          message_type TEXT NOT NULL,
          tool_name TEXT,
          tool_input TEXT,
          tool_response TEXT,
          cwd TEXT,
          last_assistant_message TEXT,
          prompt_number INTEGER,
          status TEXT NOT NULL DEFAULT 'pending',
          retry_count INTEGER DEFAULT 0,
          created_at_epoch INTEGER NOT NULL,
          started_processing_at_epoch INTEGER,
          completed_at_epoch INTEGER,
          failed_at_epoch INTEGER,
          FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id)
        )
      `);

      // Insert a session
      db.exec(`INSERT INTO sdk_sessions (content_session_id, project) VALUES ('cs-1', 'test')`);
      const sessionDbId = 1;

      // Random number of messages with random statuses
      const numMessages = Math.floor(Math.random() * 20);
      const statuses = ['pending', 'processing', 'failed'];
      for (let i = 0; i < numMessages; i++) {
        const status = statuses[Math.floor(Math.random() * statuses.length)];
        db.exec(`
          INSERT INTO pending_messages (session_db_id, content_session_id, message_type, status, created_at_epoch)
          VALUES (${sessionDbId}, 'cs-1', 'observation', '${status}', ${Date.now()})
        `);
      }

      // Execute the same SQL as getQueueStats
      const rows = db.prepare(`
        SELECT status, COUNT(*) as count FROM pending_messages
        WHERE session_db_id = ? AND status IN ('pending', 'processing')
        GROUP BY status
      `).all(sessionDbId) as { status: string; count: number }[];

      let pendingCount = 0;
      let processingCount = 0;
      for (const row of rows) {
        if (row.status === 'pending') pendingCount = row.count;
        else if (row.status === 'processing') processingCount = row.count;
      }

      expect(pendingCount).toBeGreaterThanOrEqual(0);
      expect(processingCount).toBeGreaterThanOrEqual(0);

      // Verify sum matches getPendingCount SQL
      const totalResult = db.prepare(`
        SELECT COUNT(*) as count FROM pending_messages
        WHERE session_db_id = ? AND status IN ('pending', 'processing')
      `).get(sessionDbId) as { count: number };

      expect(pendingCount + processingCount).toBe(totalResult.count);

      db.close();
    }
  });

  it('getQueueStats returns zero for session with no messages', async () => {
    const { default: BunDatabase } = await import('bun:sqlite');
    const db = new BunDatabase(':memory:');

    db.exec(`
      CREATE TABLE pending_messages (
        id INTEGER PRIMARY KEY,
        session_db_id INTEGER NOT NULL,
        content_session_id TEXT NOT NULL,
        message_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at_epoch INTEGER NOT NULL
      )
    `);

    const rows = db.prepare(`
      SELECT status, COUNT(*) as count FROM pending_messages
      WHERE session_db_id = ? AND status IN ('pending', 'processing')
      GROUP BY status
    `).all(999) as { status: string; count: number }[];

    let pendingCount = 0;
    let processingCount = 0;
    for (const row of rows) {
      if (row.status === 'pending') pendingCount = row.count;
      else if (row.status === 'processing') processingCount = row.count;
    }

    expect(pendingCount).toBe(0);
    expect(processingCount).toBe(0);
    expect(pendingCount + processingCount).toBe(0);

    db.close();
  });

  it('getQueueStats excludes failed and processed messages', async () => {
    const { default: BunDatabase } = await import('bun:sqlite');
    const db = new BunDatabase(':memory:');

    db.exec(`
      CREATE TABLE sdk_sessions (
        id INTEGER PRIMARY KEY,
        content_session_id TEXT NOT NULL,
        project TEXT DEFAULT ''
      )
    `);
    db.exec(`
      CREATE TABLE pending_messages (
        id INTEGER PRIMARY KEY,
        session_db_id INTEGER NOT NULL,
        content_session_id TEXT NOT NULL,
        message_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id)
      )
    `);

    db.exec(`INSERT INTO sdk_sessions (content_session_id, project) VALUES ('cs-1', 'test')`);
    const now = Date.now();

    // 2 pending, 3 processing, 4 failed, 1 processed
    for (let i = 0; i < 2; i++) db.exec(`INSERT INTO pending_messages (session_db_id, content_session_id, message_type, status, created_at_epoch) VALUES (1, 'cs-1', 'observation', 'pending', ${now})`);
    for (let i = 0; i < 3; i++) db.exec(`INSERT INTO pending_messages (session_db_id, content_session_id, message_type, status, created_at_epoch) VALUES (1, 'cs-1', 'observation', 'processing', ${now})`);
    for (let i = 0; i < 4; i++) db.exec(`INSERT INTO pending_messages (session_db_id, content_session_id, message_type, status, created_at_epoch) VALUES (1, 'cs-1', 'observation', 'failed', ${now})`);
    for (let i = 0; i < 1; i++) db.exec(`INSERT INTO pending_messages (session_db_id, content_session_id, message_type, status, created_at_epoch) VALUES (1, 'cs-1', 'observation', 'processed', ${now})`);

    const rows = db.prepare(`
      SELECT status, COUNT(*) as count FROM pending_messages
      WHERE session_db_id = ? AND status IN ('pending', 'processing')
      GROUP BY status
    `).all(1) as { status: string; count: number }[];

    let pendingCount = 0;
    let processingCount = 0;
    for (const row of rows) {
      if (row.status === 'pending') pendingCount = row.count;
      else if (row.status === 'processing') processingCount = row.count;
    }

    expect(pendingCount).toBe(2);
    expect(processingCount).toBe(3);

    // getPendingCount includes both pending and processing
    const totalResult = db.prepare(`
      SELECT COUNT(*) as count FROM pending_messages
      WHERE session_db_id = ? AND status IN ('pending', 'processing')
    `).get(1) as { count: number };

    expect(pendingCount + processingCount).toBe(totalResult.count);
    expect(totalResult.count).toBe(5); // Only 2+3, not 4 failed or 1 processed

    db.close();
  });
});
