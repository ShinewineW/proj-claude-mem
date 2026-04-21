import { describe, test, expect } from 'bun:test';
import { decideGeneratorAction } from '../../src/services/worker/generator-action.js';

function makeCtx(overrides: any = {}) {
  return {
    totalLifetimeCrashes: 0,
    consecutiveRestarts: 0,
    contextResetCount: 0,
    pendingCount: 5,
    pendingObservationCount: 5,
    wasAborted: false,
    isClosing: false,
    isIdleTimeout: false,
    proactiveReset: false,
    maxConsecutiveRestarts: 3,
    maxContextResets: 3,
    maxLifetimeCrashes: 10,
    maxPoolRetries: 5,
    poolCooldownMs: 120000,
    ...overrides,
  };
}

describe('totalLifetimeCrashes', () => {
  test('below threshold → crash-recovery (not abandon)', () => {
    const action = decideGeneratorAction(makeCtx({ totalLifetimeCrashes: 9, consecutiveRestarts: 1 }));
    expect(action.type).toBe('crash-recovery');
  });

  test('at threshold → abandon lifetime-exhausted', () => {
    const action = decideGeneratorAction(makeCtx({ totalLifetimeCrashes: 10 }));
    expect(action.type).toBe('abandon');
    if (action.type === 'abandon') expect(action.reason).toBe('lifetime-exhausted');
  });

  test('above threshold → abandon lifetime-exhausted', () => {
    const action = decideGeneratorAction(makeCtx({ totalLifetimeCrashes: 15 }));
    expect(action.type).toBe('abandon');
    if (action.type === 'abandon') expect(action.reason).toBe('lifetime-exhausted');
  });

  test('proactiveReset is NOT counted (P4 takes priority)', () => {
    const action = decideGeneratorAction(makeCtx({
      totalLifetimeCrashes: 9,
      proactiveReset: true,
    }));
    expect(action.type).toBe('proactive-reset');
  });

  test('pool timeout is NOT counted (P9 takes priority)', () => {
    const action = decideGeneratorAction(makeCtx({
      totalLifetimeCrashes: 9,
      poolTimeoutDetected: true,
    }));
    expect(action.type).toBe('pool-cooldown');
  });
});
