/**
 * Per-session adaptive observation cap policy.
 *
 * Problem (see today's session 164 on ClaudeMem-ProjIso):
 *   A single static cap can still be too large for sessions with high per-obs
 *   density. We want graceful degradation: if fresh-summarize fails, the NEXT
 *   attempt on the same session uses a smaller cap. Continue shrinking down
 *   to a 1-obs floor. Recover back to 30 after N stuck attempts at floor so
 *   we don't permanently pin a session at "1 obs" after a transient failure.
 *   Any success at any cap resets to default (60).
 *
 * Design (user spec):
 *   - STEP_SEQUENCE = [60, 30, 15, 7, 3, 1]
 *   - Default: 60 (first call on unknown session)
 *   - recordFailure(id): step to next smaller cap; stay at 1 until recovery
 *   - At floor (1), after FAILURES_AT_FLOOR_BEFORE_RECOVERY consecutive
 *     failures, jump back to 30 (recovery point, not 60 — we already know
 *     60 probably won't fly on this session, so retry at 30).
 *   - recordSuccess(id): reset to 60 (whole sequence unwound)
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  ObsCapPolicy,
  DEFAULT_OBS_CAP,
  STEP_SEQUENCE,
  FAILURES_AT_FLOOR_BEFORE_RECOVERY,
  RECOVERY_CAP,
} from '../../src/services/worker/obs-cap-policy.js';

describe('ObsCapPolicy constants', () => {
  it('default cap is 60 (user spec)', () => {
    expect(DEFAULT_OBS_CAP).toBe(60);
  });

  it('step sequence is [60, 30, 15, 7, 3, 1]', () => {
    expect(STEP_SEQUENCE).toEqual([60, 30, 15, 7, 3, 1]);
  });

  it('recovery cap is 30 (one step below default, per user spec)', () => {
    expect(RECOVERY_CAP).toBe(30);
  });

  it('recovery threshold is finite and >= 1', () => {
    expect(FAILURES_AT_FLOOR_BEFORE_RECOVERY).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(FAILURES_AT_FLOOR_BEFORE_RECOVERY)).toBe(true);
  });
});

describe('ObsCapPolicy.getCapForSession', () => {
  let policy: ObsCapPolicy;
  beforeEach(() => { policy = new ObsCapPolicy(); });

  it('returns default (60) for an unknown session', () => {
    expect(policy.getCapForSession(999)).toBe(60);
  });

  it('returns different caps for different sessions (state is per-session)', () => {
    policy.recordFailure(1);
    expect(policy.getCapForSession(1)).toBe(30);
    expect(policy.getCapForSession(2)).toBe(60); // untouched
  });
});

describe('ObsCapPolicy.recordFailure: step down sequence', () => {
  let policy: ObsCapPolicy;
  beforeEach(() => { policy = new ObsCapPolicy(); });

  it('60 → 30 after one failure', () => {
    policy.recordFailure(1);
    expect(policy.getCapForSession(1)).toBe(30);
  });

  it('30 → 15 after two failures', () => {
    policy.recordFailure(1);
    policy.recordFailure(1);
    expect(policy.getCapForSession(1)).toBe(15);
  });

  it('stepdown sequence 60→30→15→7→3→1', () => {
    const expected = [30, 15, 7, 3, 1];
    for (const expectedCap of expected) {
      policy.recordFailure(1);
      expect(policy.getCapForSession(1)).toBe(expectedCap);
    }
  });

  it('at floor (1), stays at floor until recovery threshold hit', () => {
    // Walk down to floor (5 failures: 60→30→15→7→3→1)
    for (let i = 0; i < 5; i++) policy.recordFailure(1);
    expect(policy.getCapForSession(1)).toBe(1);
    // Stay at floor for (recoveryThreshold - 1) more failures
    for (let i = 0; i < FAILURES_AT_FLOOR_BEFORE_RECOVERY - 1; i++) {
      policy.recordFailure(1);
      expect(policy.getCapForSession(1)).toBe(1);
    }
  });

  it('after N consecutive failures at floor, jumps back to recovery cap (30)', () => {
    // Walk down to floor
    for (let i = 0; i < 5; i++) policy.recordFailure(1);
    expect(policy.getCapForSession(1)).toBe(1);
    // Trigger the Nth floor failure to fire recovery
    for (let i = 0; i < FAILURES_AT_FLOOR_BEFORE_RECOVERY; i++) {
      policy.recordFailure(1);
    }
    expect(policy.getCapForSession(1)).toBe(RECOVERY_CAP);
  });

  it('after recovery to 30, further failures step down again (30→15→...)', () => {
    // Walk to floor + trigger recovery
    for (let i = 0; i < 5; i++) policy.recordFailure(1);
    for (let i = 0; i < FAILURES_AT_FLOOR_BEFORE_RECOVERY; i++) {
      policy.recordFailure(1);
    }
    expect(policy.getCapForSession(1)).toBe(RECOVERY_CAP); // 30
    policy.recordFailure(1);
    expect(policy.getCapForSession(1)).toBe(15);
  });
});

describe('ObsCapPolicy.recordSuccess: reset to default', () => {
  let policy: ObsCapPolicy;
  beforeEach(() => { policy = new ObsCapPolicy(); });

  it('resets cap to default (60) after success at any level', () => {
    policy.recordFailure(1);
    policy.recordFailure(1); // now at 15
    expect(policy.getCapForSession(1)).toBe(15);
    policy.recordSuccess(1);
    expect(policy.getCapForSession(1)).toBe(DEFAULT_OBS_CAP);
  });

  it('resets floor-counter too — next failure starts at 60→30', () => {
    // Go to floor
    for (let i = 0; i < 5; i++) policy.recordFailure(1);
    // Success at floor resets everything
    policy.recordSuccess(1);
    expect(policy.getCapForSession(1)).toBe(60);
    policy.recordFailure(1);
    expect(policy.getCapForSession(1)).toBe(30);
  });

  it('success on one session does not affect another', () => {
    policy.recordFailure(1);
    policy.recordFailure(2);
    policy.recordSuccess(1);
    expect(policy.getCapForSession(1)).toBe(60);
    expect(policy.getCapForSession(2)).toBe(30);
  });
});

describe('ObsCapPolicy.reset: full state drop (for tests / worker restart)', () => {
  it('reset(id) forgets session', () => {
    const policy = new ObsCapPolicy();
    policy.recordFailure(1);
    expect(policy.getCapForSession(1)).toBe(30);
    policy.reset(1);
    expect(policy.getCapForSession(1)).toBe(60);
  });

  it('reset() (no arg) clears all sessions', () => {
    const policy = new ObsCapPolicy();
    policy.recordFailure(1);
    policy.recordFailure(2);
    policy.reset();
    expect(policy.getCapForSession(1)).toBe(60);
    expect(policy.getCapForSession(2)).toBe(60);
  });
});
