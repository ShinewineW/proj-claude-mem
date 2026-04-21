import { describe, test, expect } from 'bun:test';
import {
  decideGeneratorAction,
  isDbIoError,
  type GeneratorAction,
  type GeneratorActionContext,
} from '../../src/services/worker/generator-action.js';

// Helper to build a minimal context with sensible defaults
function makeCtx(overrides: Partial<GeneratorActionContext> = {}): GeneratorActionContext {
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

describe('isDbIoError', () => {
  test('detects disk I/O error message', () => {
    expect(isDbIoError(new Error('SQLite: disk I/O error'))).toBe(true);
  });
  test('detects unable to open database file', () => {
    expect(isDbIoError(new Error('unable to open database file'))).toBe(true);
  });
  test('detects SQLITE_IOERR code', () => {
    const err = new Error('IO error');
    (err as any).code = 10;
    expect(isDbIoError(err)).toBe(true);
  });
  test('detects SQLITE_CANTOPEN code', () => {
    const err = new Error('cannot open');
    (err as any).code = 14;
    expect(isDbIoError(err)).toBe(true);
  });
  test('detects malformed database schema', () => {
    expect(isDbIoError(new Error('database disk image is malformed'))).toBe(true);
  });
  test('returns false for null/undefined', () => {
    expect(isDbIoError(undefined)).toBe(false);
    expect(isDbIoError(null as any)).toBe(false);
  });
  test('returns false for normal errors', () => {
    expect(isDbIoError(new Error('something else'))).toBe(false);
  });
});

describe('decideGeneratorAction', () => {
  // Priority 1: unrecoverable error
  test('P1: unrecoverable error patterns → abandon', () => {
    const ctx = makeCtx({ error: new Error('ENOENT: no such file or directory, spawn') });
    const action = decideGeneratorAction(ctx);
    expect(action.type).toBe('abandon');
    if (action.type === 'abandon') expect(action.reason).toBe('unrecoverable');
  });

  test('P1: Invalid API key → abandon unrecoverable', () => {
    const ctx = makeCtx({ error: new Error('Invalid API key provided') });
    const action = decideGeneratorAction(ctx);
    expect(action.type).toBe('abandon');
    if (action.type === 'abandon') expect(action.reason).toBe('unrecoverable');
  });

  test('P1: FOREIGN KEY constraint → abandon unrecoverable', () => {
    const ctx = makeCtx({ error: new Error('FOREIGN KEY constraint failed') });
    const action = decideGeneratorAction(ctx);
    expect(action.type).toBe('abandon');
    if (action.type === 'abandon') expect(action.reason).toBe('unrecoverable');
  });

  // Priority 2: idle/closing
  test('P2: isIdleTimeout → noop', () => {
    const action = decideGeneratorAction(makeCtx({ isIdleTimeout: true }));
    expect(action.type).toBe('noop');
  });

  test('P2: isClosing with no pending observations → noop', () => {
    const action = decideGeneratorAction(makeCtx({ isClosing: true, pendingObservationCount: 0 }));
    expect(action.type).toBe('noop');
  });

  test('P2b: isClosing + pendingObservationCount>0 → crash-recovery (observation-drain)', () => {
    const action = decideGeneratorAction(makeCtx({ isClosing: true, pendingObservationCount: 3 }));
    expect(action.type).toBe('crash-recovery');
  });

  // Priority 3: context-exhausted
  test('P3: contextResetCount >= max → abandon context-exhausted', () => {
    const action = decideGeneratorAction(makeCtx({ contextResetCount: 3, maxContextResets: 3 }));
    expect(action.type).toBe('abandon');
    if (action.type === 'abandon') expect(action.reason).toBe('context-exhausted');
  });

  // Priority 4: proactiveReset
  test('P4: proactiveReset → proactive-reset', () => {
    const action = decideGeneratorAction(makeCtx({ proactiveReset: true }));
    expect(action.type).toBe('proactive-reset');
  });

  // Priority 5: wasAborted (no proactiveReset) → noop
  test('P5: wasAborted without proactiveReset → noop', () => {
    const action = decideGeneratorAction(makeCtx({ wasAborted: true, proactiveReset: false }));
    expect(action.type).toBe('noop');
  });

  test('P5: wasAborted WITH proactiveReset hits P4 first → proactive-reset', () => {
    const action = decideGeneratorAction(makeCtx({ wasAborted: true, proactiveReset: true }));
    expect(action.type).toBe('proactive-reset');
  });

  // Priority 6: DB unreachable
  test('P6: disk I/O error + dbFileExists=false → abandon db-unreachable', () => {
    const ctx = makeCtx({
      error: new Error('disk I/O error'),
      dbFileExists: false,
    });
    const action = decideGeneratorAction(ctx);
    expect(action.type).toBe('abandon');
    if (action.type === 'abandon') expect(action.reason).toBe('db-unreachable');
  });

  test('P6: disk I/O error + dbFileExists=true → does NOT abandon (transient)', () => {
    const ctx = makeCtx({
      error: new Error('disk I/O error'),
      dbFileExists: true,
      pendingCount: 5,
      consecutiveRestarts: 0,
    });
    const action = decideGeneratorAction(ctx);
    expect(action.type).not.toBe('abandon');
  });

  test('P6: disk I/O error + dbFileExists=undefined → does NOT abandon (no check)', () => {
    const ctx = makeCtx({
      error: new Error('disk I/O error'),
      pendingCount: 5,
      consecutiveRestarts: 0,
    });
    const action = decideGeneratorAction(ctx);
    expect(action.type).not.toBe('abandon');
  });

  // Priority 7: lifetime-exhausted
  test('P7: totalLifetimeCrashes >= 10 → abandon lifetime-exhausted', () => {
    const action = decideGeneratorAction(makeCtx({ totalLifetimeCrashes: 10, maxLifetimeCrashes: 10 }));
    expect(action.type).toBe('abandon');
    if (action.type === 'abandon') expect(action.reason).toBe('lifetime-exhausted');
  });

  // Priority 8: no pending → idle-cleanup
  test('P8: pendingCount=0 → idle-cleanup', () => {
    const action = decideGeneratorAction(makeCtx({ pendingCount: 0 }));
    expect(action.type).toBe('idle-cleanup');
  });

  // Priority 9: pool cooldown
  test('P9: pool timeout error → pool-cooldown', () => {
    const ctx = makeCtx({
      error: new Error('Timed out waiting for agent pool slot after 60000ms'),
      poolTimeoutDetected: true,
    });
    const action = decideGeneratorAction(ctx);
    expect(action.type).toBe('pool-cooldown');
    if (action.type === 'pool-cooldown') {
      expect(action.cooldownMs).toBe(120000);
    }
  });

  // Priority 10: restart-exhausted
  test('P10: consecutiveRestarts >= max → abandon restart-exhausted', () => {
    const action = decideGeneratorAction(makeCtx({ consecutiveRestarts: 3, maxConsecutiveRestarts: 3 }));
    expect(action.type).toBe('abandon');
    if (action.type === 'abandon') expect(action.reason).toBe('restart-exhausted');
  });

  test('P10: consecutiveRestarts = max-1 → does NOT abandon', () => {
    const action = decideGeneratorAction(makeCtx({ consecutiveRestarts: 2, maxConsecutiveRestarts: 3, pendingCount: 5 }));
    expect(action.type).toBe('crash-recovery');
  });

  // Priority 11: crash-recovery
  test('P11: pending work + restarts within budget → crash-recovery', () => {
    const action = decideGeneratorAction(makeCtx({ pendingCount: 3, consecutiveRestarts: 1 }));
    expect(action.type).toBe('crash-recovery');
    if (action.type === 'crash-recovery') {
      expect(action.backoffMs).toBeGreaterThan(0);
    }
  });

  test('P11: backoff is exponential (pre-increment values)', () => {
    const a0 = decideGeneratorAction(makeCtx({ pendingCount: 3, consecutiveRestarts: 0 }));
    const a1 = decideGeneratorAction(makeCtx({ pendingCount: 3, consecutiveRestarts: 1 }));
    const a2 = decideGeneratorAction(makeCtx({ pendingCount: 3, consecutiveRestarts: 2 }));
    if (a0.type === 'crash-recovery' && a1.type === 'crash-recovery' && a2.type === 'crash-recovery') {
      expect(a0.backoffMs).toBe(1000);  // pow(2,0) * 1000
      expect(a1.backoffMs).toBe(2000);  // pow(2,1) * 1000
      expect(a2.backoffMs).toBe(4000);  // pow(2,2) * 1000
    }
  });

  test('P8 beats P9: pendingCount=0 + poolTimeoutDetected → idle-cleanup (not pool-cooldown)', () => {
    const action = decideGeneratorAction(makeCtx({ pendingCount: 0, poolTimeoutDetected: true }));
    expect(action.type).toBe('idle-cleanup');
  });

  // Priority ordering: higher priority wins
  test('unrecoverable beats lifetime-exhausted', () => {
    const ctx = makeCtx({
      error: new Error('ENOENT: spawn failed'),
      totalLifetimeCrashes: 10,
      maxLifetimeCrashes: 10,
    });
    const action = decideGeneratorAction(ctx);
    expect(action.type).toBe('abandon');
    if (action.type === 'abandon') expect(action.reason).toBe('unrecoverable');
  });

  test('context-exhausted beats proactiveReset', () => {
    const ctx = makeCtx({
      contextResetCount: 3,
      maxContextResets: 3,
      proactiveReset: true,
    });
    const action = decideGeneratorAction(ctx);
    expect(action.type).toBe('abandon');
    if (action.type === 'abandon') expect(action.reason).toBe('context-exhausted');
  });

  test('db-unreachable beats lifetime-exhausted', () => {
    const ctx = makeCtx({
      error: new Error('disk I/O error'),
      dbFileExists: false,
      totalLifetimeCrashes: 10,
      maxLifetimeCrashes: 10,
    });
    const action = decideGeneratorAction(ctx);
    expect(action.type).toBe('abandon');
    if (action.type === 'abandon') expect(action.reason).toBe('db-unreachable');
  });

  test('lifetime-exhausted beats restart-exhausted', () => {
    const ctx = makeCtx({
      totalLifetimeCrashes: 10,
      maxLifetimeCrashes: 10,
      consecutiveRestarts: 4,
      maxConsecutiveRestarts: 3,
    });
    const action = decideGeneratorAction(ctx);
    expect(action.type).toBe('abandon');
    if (action.type === 'abandon') expect(action.reason).toBe('lifetime-exhausted');
  });

  // Default → noop
  test('default: no error, no pending, no special state → idle-cleanup', () => {
    const action = decideGeneratorAction(makeCtx({ pendingCount: 0 }));
    expect(action.type).toBe('idle-cleanup');
  });
});
