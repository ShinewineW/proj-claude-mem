/**
 * Per-session adaptive observation cap policy.
 *
 * Design (user spec):
 *   - Sequence derived from a single knob (defaultCap) by repeated halving
 *     (floor) down to 1. For defaultCap=150 the sequence is
 *     [150, 75, 37, 18, 9, 4, 2, 1]. For defaultCap=60 it is
 *     [60, 30, 15, 7, 3, 1]. Operator changes ONE number, sequence derives
 *     automatically — no magic constants scattered through the code.
 *   - recordFailure: step cap to next smaller value; at floor (1), stays
 *     until FAILURES_AT_FLOOR_BEFORE_RECOVERY consecutive floor failures
 *     trigger a jump back to sequence[1] (halved from cap).
 *   - recordSuccess: reset to default — the whole sequence unwinds on any
 *     Claude-authored summary.
 *   - reset(id) / reset(): per-session or global state drop.
 *
 * Why adaptive vs. static cap: static 150 works on many sessions but
 * obs density varies by project. Stepdown probes the right per-session
 * size rather than betting on one universal number.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  ObsCapPolicy,
  DEFAULT_OBS_CAP,
  DEFAULT_STEP_SEQUENCE,
  FAILURES_AT_FLOOR_BEFORE_RECOVERY,
  OBS_CAP_FLOOR,
  generateStepSequence,
} from '../../src/services/worker/obs-cap-policy.js';

describe('generateStepSequence', () => {
  it('default cap 150 produces [150, 75, 37, 18, 9, 4, 2, 1]', () => {
    expect(generateStepSequence(150)).toEqual([150, 75, 37, 18, 9, 4, 2, 1]);
  });

  it('cap 60 produces [60, 30, 15, 7, 3, 1]', () => {
    expect(generateStepSequence(60)).toEqual([60, 30, 15, 7, 3, 1]);
  });

  it('cap 40 produces [40, 20, 10, 5, 2, 1]', () => {
    expect(generateStepSequence(40)).toEqual([40, 20, 10, 5, 2, 1]);
  });

  it('cap 1 produces [1] (degenerate)', () => {
    expect(generateStepSequence(1)).toEqual([1]);
  });

  it('cap 2 produces [2, 1]', () => {
    expect(generateStepSequence(2)).toEqual([2, 1]);
  });

  it('clamps non-positive caps to 1', () => {
    expect(generateStepSequence(0)).toEqual([1]);
    expect(generateStepSequence(-5)).toEqual([1]);
  });

  it('floors non-integer caps', () => {
    expect(generateStepSequence(150.7)).toEqual([150, 75, 37, 18, 9, 4, 2, 1]);
  });

  it('sequence is strictly decreasing', () => {
    const seq = generateStepSequence(100);
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]).toBeLessThan(seq[i - 1]);
    }
  });

  it('sequence always ends at 1 (the floor)', () => {
    for (const cap of [150, 60, 40, 25, 10, 5, 2]) {
      const seq = generateStepSequence(cap);
      expect(seq[seq.length - 1]).toBe(1);
    }
  });
});

describe('ObsCapPolicy constants', () => {
  it('default cap is 150 (aligned with spec cap=150 success samples)', () => {
    expect(DEFAULT_OBS_CAP).toBe(150);
  });

  it('floor is 1', () => {
    expect(OBS_CAP_FLOOR).toBe(1);
  });

  it('DEFAULT_STEP_SEQUENCE matches generateStepSequence(DEFAULT_OBS_CAP)', () => {
    expect(DEFAULT_STEP_SEQUENCE).toEqual(generateStepSequence(DEFAULT_OBS_CAP));
  });

  it('recovery threshold is finite and >= 1', () => {
    expect(FAILURES_AT_FLOOR_BEFORE_RECOVERY).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(FAILURES_AT_FLOOR_BEFORE_RECOVERY)).toBe(true);
  });
});

describe('ObsCapPolicy configurable defaultCap', () => {
  it('constructor accepts a custom defaultCap (for settings-driven override)', () => {
    const policy = new ObsCapPolicy({ defaultCap: 100 });
    expect(policy.getCapForSession(42)).toBe(100);
  });

  it('falls back to DEFAULT_OBS_CAP when defaultCap is omitted', () => {
    const policy = new ObsCapPolicy();
    expect(policy.getCapForSession(42)).toBe(DEFAULT_OBS_CAP);
  });

  it('falls back to DEFAULT_OBS_CAP on invalid defaultCap (0, negative, NaN)', () => {
    expect(new ObsCapPolicy({ defaultCap: 0 }).getCapForSession(1)).toBe(DEFAULT_OBS_CAP);
    expect(new ObsCapPolicy({ defaultCap: -5 }).getCapForSession(1)).toBe(DEFAULT_OBS_CAP);
    expect(new ObsCapPolicy({ defaultCap: NaN }).getCapForSession(1)).toBe(DEFAULT_OBS_CAP);
  });

  it('custom defaultCap derives its OWN halving sequence (no hardcoded fallback)', () => {
    // User sets 100. Sequence derives from 100, not from 150's [75, 37, ...].
    const policy = new ObsCapPolicy({ defaultCap: 100 });
    expect(policy.getSequence()).toEqual([100, 50, 25, 12, 6, 3, 1]);
  });

  it('recovery cap is the second step of the sequence (halved from default)', () => {
    expect(new ObsCapPolicy({ defaultCap: 150 }).getRecoveryCap()).toBe(75);
    expect(new ObsCapPolicy({ defaultCap: 60 }).getRecoveryCap()).toBe(30);
    expect(new ObsCapPolicy({ defaultCap: 40 }).getRecoveryCap()).toBe(20);
    // Degenerate: single-element sequence → recovery stays at that element
    expect(new ObsCapPolicy({ defaultCap: 1 }).getRecoveryCap()).toBe(1);
  });

  it('custom defaultCap still steps down through ITS sequence after failure', () => {
    const policy = new ObsCapPolicy({ defaultCap: 100 });
    policy.recordFailure(1);
    expect(policy.getCapForSession(1)).toBe(50);  // 100 halved
    policy.recordFailure(1);
    expect(policy.getCapForSession(1)).toBe(25);  // 50 halved
  });
});

describe('ObsCapPolicy.syncDefaultCap', () => {
  it('rebuilds the sequence from a new defaultCap (no hardcoded fallback)', () => {
    const policy = new ObsCapPolicy({ defaultCap: 150 });
    policy.syncDefaultCap(40);
    expect(policy.getSequence()).toEqual([40, 20, 10, 5, 2, 1]);
    expect(policy.getCapForSession(1)).toBe(40);
  });

  it('preserves each session step depth when the configured cap changes', () => {
    const policy = new ObsCapPolicy({ defaultCap: 150 });
    policy.recordFailure(1);
    policy.recordFailure(1);
    expect(policy.getCapForSession(1)).toBe(37);

    policy.syncDefaultCap(40);

    // Same stepIndex=2 mapped onto the new sequence [40, 20, 10, 5, 2, 1].
    expect(policy.getCapForSession(1)).toBe(10);
  });

  it('clears floor failure count if a larger cap makes the session no longer be at floor', () => {
    const policy = new ObsCapPolicy({ defaultCap: 2 });
    policy.recordFailure(1);
    policy.recordFailure(1);
    expect(policy.getCapForSession(1)).toBe(1);

    policy.syncDefaultCap(150);
    policy.recordFailure(1);

    // The session left floor during reconfigure, so the next failure should
    // step down once from sequence index 1 → 2 instead of triggering recovery.
    expect(policy.getCapForSession(1)).toBe(DEFAULT_STEP_SEQUENCE[2]);
  });
});

describe('ObsCapPolicy.getCapForSession', () => {
  let policy: ObsCapPolicy;
  beforeEach(() => { policy = new ObsCapPolicy(); });

  it('returns default (150) for an unknown session', () => {
    expect(policy.getCapForSession(999)).toBe(150);
  });

  it('returns different caps for different sessions (state is per-session)', () => {
    policy.recordFailure(1);
    expect(policy.getCapForSession(1)).toBe(DEFAULT_STEP_SEQUENCE[1]); // 75
    expect(policy.getCapForSession(2)).toBe(150); // untouched
  });
});

describe('ObsCapPolicy.recordFailure: step down sequence', () => {
  let policy: ObsCapPolicy;
  beforeEach(() => { policy = new ObsCapPolicy(); });

  it('steps down through DEFAULT_STEP_SEQUENCE on consecutive failures', () => {
    // Skip index 0 (starting state); walk through rest of the sequence
    for (let i = 1; i < DEFAULT_STEP_SEQUENCE.length; i++) {
      policy.recordFailure(1);
      expect(policy.getCapForSession(1)).toBe(DEFAULT_STEP_SEQUENCE[i]);
    }
  });

  it('at floor, stays at floor until recovery threshold hit', () => {
    // Walk down to floor
    for (let i = 1; i < DEFAULT_STEP_SEQUENCE.length; i++) policy.recordFailure(1);
    expect(policy.getCapForSession(1)).toBe(OBS_CAP_FLOOR);
    // Stay at floor for (recoveryThreshold - 1) more failures
    for (let i = 0; i < FAILURES_AT_FLOOR_BEFORE_RECOVERY - 1; i++) {
      policy.recordFailure(1);
      expect(policy.getCapForSession(1)).toBe(OBS_CAP_FLOOR);
    }
  });

  it('after N consecutive floor failures, jumps back to recovery cap (sequence[1])', () => {
    // Walk down to floor
    for (let i = 1; i < DEFAULT_STEP_SEQUENCE.length; i++) policy.recordFailure(1);
    expect(policy.getCapForSession(1)).toBe(OBS_CAP_FLOOR);
    // Trigger the Nth floor failure to fire recovery
    for (let i = 0; i < FAILURES_AT_FLOOR_BEFORE_RECOVERY; i++) {
      policy.recordFailure(1);
    }
    expect(policy.getCapForSession(1)).toBe(policy.getRecoveryCap());
  });

  it('after recovery, further failures step down again', () => {
    for (let i = 1; i < DEFAULT_STEP_SEQUENCE.length; i++) policy.recordFailure(1);
    for (let i = 0; i < FAILURES_AT_FLOOR_BEFORE_RECOVERY; i++) policy.recordFailure(1);
    expect(policy.getCapForSession(1)).toBe(policy.getRecoveryCap());
    policy.recordFailure(1);
    expect(policy.getCapForSession(1)).toBe(DEFAULT_STEP_SEQUENCE[2]);
  });
});

describe('ObsCapPolicy.recordSuccess: reset to default', () => {
  let policy: ObsCapPolicy;
  beforeEach(() => { policy = new ObsCapPolicy(); });

  it('resets cap to default (150) after success at any level', () => {
    policy.recordFailure(1);
    policy.recordFailure(1);
    expect(policy.getCapForSession(1)).toBe(DEFAULT_STEP_SEQUENCE[2]);
    policy.recordSuccess(1);
    expect(policy.getCapForSession(1)).toBe(DEFAULT_OBS_CAP);
  });

  it('resets floor-counter too — next failure starts from index 1', () => {
    for (let i = 1; i < DEFAULT_STEP_SEQUENCE.length; i++) policy.recordFailure(1);
    policy.recordSuccess(1);
    expect(policy.getCapForSession(1)).toBe(DEFAULT_OBS_CAP);
    policy.recordFailure(1);
    expect(policy.getCapForSession(1)).toBe(DEFAULT_STEP_SEQUENCE[1]);
  });

  it('success on one session does not affect another', () => {
    policy.recordFailure(1);
    policy.recordFailure(2);
    policy.recordSuccess(1);
    expect(policy.getCapForSession(1)).toBe(DEFAULT_OBS_CAP);
    expect(policy.getCapForSession(2)).toBe(DEFAULT_STEP_SEQUENCE[1]);
  });
});

describe('ObsCapPolicy.reset: full state drop (for tests / worker restart)', () => {
  it('reset(id) forgets session', () => {
    const policy = new ObsCapPolicy();
    policy.recordFailure(1);
    expect(policy.getCapForSession(1)).toBe(DEFAULT_STEP_SEQUENCE[1]);
    policy.reset(1);
    expect(policy.getCapForSession(1)).toBe(DEFAULT_OBS_CAP);
  });

  it('reset() (no arg) clears all sessions', () => {
    const policy = new ObsCapPolicy();
    policy.recordFailure(1);
    policy.recordFailure(2);
    policy.reset();
    expect(policy.getCapForSession(1)).toBe(DEFAULT_OBS_CAP);
    expect(policy.getCapForSession(2)).toBe(DEFAULT_OBS_CAP);
  });
});
