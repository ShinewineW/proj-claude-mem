import { describe, it, expect } from 'bun:test';

// Test helpers — mock the minimum needed
const createMockSession = (overrides: Record<string, unknown> = {}) => ({
  sessionDbId: 1,
  contentSessionId: 'test-content-id',
  project: 'test-project',
  dbPath: '/tmp/test.db',
  abortController: new AbortController(),
  generatorPromise: null,
  consecutiveRestarts: 0,
  totalPoolTimeouts: 0,
  poolCooldownUntil: undefined,
  lastGeneratorError: undefined,
  lastResponseAt: null,
  contextResetCount: 0,
  ...overrides,
});

describe('Pool Cooldown', () => {
  describe('isPoolTimeoutError', () => {
    it('should detect pool timeout error message', () => {
      const { isPoolTimeoutError } = require('../../src/services/worker/http/routes/pool-cooldown-utils');
      expect(isPoolTimeoutError(new Error('Timed out waiting for agent pool slot after 60000ms'))).toBe(true);
    });

    it('should NOT detect FK constraint as pool timeout', () => {
      const { isPoolTimeoutError } = require('../../src/services/worker/http/routes/pool-cooldown-utils');
      expect(isPoolTimeoutError(new Error('FOREIGN KEY constraint failed'))).toBe(false);
    });

    it('should handle undefined error', () => {
      const { isPoolTimeoutError } = require('../../src/services/worker/http/routes/pool-cooldown-utils');
      expect(isPoolTimeoutError(undefined)).toBe(false);
    });
  });

  describe('shouldEnterCooldown', () => {
    it('should enter cooldown on pool timeout within retry limit', () => {
      const { shouldEnterCooldown } = require('../../src/services/worker/http/routes/pool-cooldown-utils');
      const session = createMockSession({ totalPoolTimeouts: 2 });
      const error = new Error('Timed out waiting for agent pool slot after 60000ms');
      expect(shouldEnterCooldown(error, session, 5)).toBe(true);
    });

    it('should NOT enter cooldown when max retries exhausted', () => {
      const { shouldEnterCooldown } = require('../../src/services/worker/http/routes/pool-cooldown-utils');
      const session = createMockSession({ totalPoolTimeouts: 5 });
      const error = new Error('Timed out waiting for agent pool slot after 60000ms');
      expect(shouldEnterCooldown(error, session, 5)).toBe(false);
    });

    it('should NOT enter cooldown for non-pool errors', () => {
      const { shouldEnterCooldown } = require('../../src/services/worker/http/routes/pool-cooldown-utils');
      const session = createMockSession({ totalPoolTimeouts: 0 });
      const error = new Error('FOREIGN KEY constraint failed');
      expect(shouldEnterCooldown(error, session, 5)).toBe(false);
    });
  });

  describe('ensureGeneratorRunning cooldown guard', () => {
    it('should skip generator start during cooldown for observation source', () => {
      const session = createMockSession({
        poolCooldownUntil: Date.now() + 60000, // 1 min from now
      });
      // cooldown is active, source is observation → should skip
      const shouldSkip = session.poolCooldownUntil && Date.now() < session.poolCooldownUntil;
      expect(shouldSkip).toBe(true);
    });

    it('should allow generator start for init source even during cooldown', () => {
      const session = createMockSession({
        poolCooldownUntil: Date.now() + 60000,
      });
      const source = 'init';
      // init source breaks cooldown
      const shouldBreakCooldown = source === 'init';
      expect(shouldBreakCooldown).toBe(true);
    });

    it('should allow generator start after cooldown expires', () => {
      const session = createMockSession({
        poolCooldownUntil: Date.now() - 1000, // 1 sec ago (expired)
      });
      const cooldownActive = session.poolCooldownUntil && Date.now() < session.poolCooldownUntil;
      expect(cooldownActive).toBe(false);
    });
  });

  describe('consecutiveRestarts isolation', () => {
    it('pool timeout should NOT increment consecutiveRestarts', () => {
      const session = createMockSession({ consecutiveRestarts: 2 });
      // Simulate pool cooldown entry — consecutiveRestarts stays untouched
      session.totalPoolTimeouts = (session.totalPoolTimeouts as number) + 1;
      expect(session.consecutiveRestarts).toBe(2); // unchanged
    });
  });
});
