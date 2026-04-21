import { describe, it, expect } from 'bun:test';
import { decideGeneratorAction, type GeneratorActionContext } from '../../src/services/worker/generator-action.js';

function baseCtx(overrides: Partial<GeneratorActionContext> = {}): GeneratorActionContext {
  return {
    totalLifetimeCrashes: 0,
    consecutiveRestarts: 0,
    contextResetCount: 0,
    pendingCount: 0,
    wasAborted: false,
    proactiveReset: false,
    isClosing: false,
    isIdleTimeout: false,
    maxConsecutiveRestarts: 5,
    maxContextResets: 3,
    maxLifetimeCrashes: 10,
    maxPoolRetries: 5,
    poolCooldownMs: 120_000,
    pendingObservationCount: 0,
    ...overrides,
  };
}

describe('decideGeneratorAction close-window with pending observations', () => {
  it('returns crash-recovery when isClosing=true AND pendingObservationCount>0', () => {
    const ctx = baseCtx({ isClosing: true, pendingObservationCount: 3, pendingCount: 3 });
    const action = decideGeneratorAction(ctx);
    expect(action.type).toBe('crash-recovery');
  });

  it('returns noop when isClosing=true AND pendingObservationCount=0', () => {
    const ctx = baseCtx({ isClosing: true, pendingObservationCount: 0 });
    const action = decideGeneratorAction(ctx);
    expect(action.type).toBe('noop');
  });

  it('isIdleTimeout still forces noop regardless of pending obs', () => {
    const ctx = baseCtx({ isIdleTimeout: true, pendingObservationCount: 5, pendingCount: 5 });
    const action = decideGeneratorAction(ctx);
    expect(action.type).toBe('noop');
  });

  it('non-closing, non-idle sessions still use the usual decision tree', () => {
    const ctx = baseCtx({ pendingCount: 1, pendingObservationCount: 1 });
    const action = decideGeneratorAction(ctx);
    expect(action.type).toBe('crash-recovery');
  });
});
