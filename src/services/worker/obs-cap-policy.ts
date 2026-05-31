/**
 * Per-session adaptive observation-cap policy.
 *
 * Each SDK session gets its own cap on how many observations are embedded
 * into the fresh-summarize prompt. The cap shrinks on failure and HOLDS on
 * success — a dense session that only summarizes at a reduced cap stays there
 * for its lifetime instead of resetting to the top, re-failing, and stepping
 * down again on every single summary (the 150→fail→75→reset→150 oscillation
 * that burned one subprocess crash per summary on long sessions). Capacity is
 * reclaimed structurally rather than by probing up: the cap is per-session
 * (every new session starts at the top) and the in-memory state clears on
 * worker restart, so a reduced cap never leaks across sessions. At the floor
 * (1 obs), N consecutive failures trigger a recovery jump back to sequence[1]
 * (one halving below the configured default) so we don't stay stuck at
 * "1 obs" after a transient failure cleared.
 *
 * Why adaptive instead of static: session 164 on ClaudeMem-ProjIso
 * accumulated 215 obs. Some projects succeed comfortably at cap=150, while
 * other sessions may have denser per-obs content. Stepdown probes the right
 * size for each session rather than betting on a universal prompt size.
 */

export const DEFAULT_OBS_CAP = 150; // aligned with spec cap=150 success samples
export const OBS_CAP_FLOOR = 1;
export const FAILURES_AT_FLOOR_BEFORE_RECOVERY = 5;

/**
 * Build the stepdown sequence by repeatedly halving (floor) from `defaultCap`
 * down to 1. Parameterizing the sequence (vs. hardcoding a fixed ladder)
 * lets operators tune a single knob (CLAUDE_MEM_MAX_SUMMARY_OBSERVATIONS)
 * without editing magic constants spread across the code.
 *
 * Examples:
 *   150 → [150, 75, 37, 18, 9, 4, 2, 1]
 *   60  → [60, 30, 15, 7, 3, 1]
 *   40  → [40, 20, 10, 5, 2, 1]
 *   1   → [1]
 *
 * Guarantees:
 *   - First element is the user-requested cap
 *   - Sequence is strictly decreasing (dedup protects against edge cases)
 *   - Last element is always 1 (the floor)
 */
export function generateStepSequence(defaultCap: number): readonly number[] {
  const seq: number[] = [];
  let cur = Math.max(1, Math.floor(defaultCap));
  seq.push(cur);
  while (cur > 1) {
    cur = Math.floor(cur / 2);
    if (cur < 1) break;
    if (seq[seq.length - 1] !== cur) seq.push(cur);
  }
  return Object.freeze(seq);
}

/** Default sequence derived from DEFAULT_OBS_CAP. Exposed for tests. */
export const DEFAULT_STEP_SEQUENCE = generateStepSequence(DEFAULT_OBS_CAP);

interface SessionState {
  stepIndex: number;         // index into sequence
  floorFailureCount: number; // consecutive failures at floor (stepIndex === last)
}

export interface ObsCapPolicyOptions {
  /**
   * Top-of-stepdown cap. All stepdown values are derived from this by
   * repeated halving — a single knob that operators can tune without
   * editing a magic sequence list.
   *
   * Defensive: invalid values (0, negative, NaN, undefined) fall back to
   * DEFAULT_OBS_CAP. Settings files can have typos and a "cap disabled"
   * silent fallback is not safe.
   *
   * Wired from CLAUDE_MEM_MAX_SUMMARY_OBSERVATIONS in SummaryLane.
   */
  defaultCap?: number;
}

function resolveStepSequence(defaultCap?: number): readonly number[] {
  const validOverride =
    typeof defaultCap === 'number' &&
    Number.isFinite(defaultCap) &&
    defaultCap > 0;
  return validOverride
    ? generateStepSequence(Math.floor(defaultCap))
    : DEFAULT_STEP_SEQUENCE;
}

function sequencesEqual(
  lhs: readonly number[],
  rhs: readonly number[],
): boolean {
  if (lhs.length !== rhs.length) return false;
  return lhs.every((value, index) => value === rhs[index]);
}

export class ObsCapPolicy {
  private state = new Map<number, SessionState>();
  private sequence: readonly number[];

  constructor(opts?: ObsCapPolicyOptions) {
    this.sequence = resolveStepSequence(opts?.defaultCap);
  }

  /** The stepdown cascade in effect for this policy instance. */
  getSequence(): readonly number[] { return this.sequence; }

  /**
   * Refresh the default cap while preserving each session's failure depth.
   *
   * SummaryLane calls this before every summarize so config changes applied
   * through settings.json or /api/settings take effect without a worker
   * restart. Existing sessions keep their stepIndex where possible; if the
   * new sequence is shorter, the index clamps to the new floor.
   */
  syncDefaultCap(defaultCap?: number): void {
    const nextSequence = resolveStepSequence(defaultCap);
    if (sequencesEqual(this.sequence, nextSequence)) return;

    this.sequence = nextSequence;
    const lastIdx = this.sequence.length - 1;

    for (const [sessionDbId, sessionState] of this.state.entries()) {
      const stepIndex = Math.min(sessionState.stepIndex, lastIdx);
      this.state.set(sessionDbId, {
        stepIndex,
        floorFailureCount:
          stepIndex === lastIdx ? sessionState.floorFailureCount : 0,
      });
    }
  }

  /** The cap used for recovery jumps (second step of the sequence). */
  getRecoveryCap(): number {
    return this.sequence.length > 1 ? this.sequence[1] : this.sequence[0];
  }

  getCapForSession(sessionDbId: number): number {
    const s = this.state.get(sessionDbId);
    return this.sequence[s?.stepIndex ?? 0];
  }

  /**
   * Record a summarize failure on this session. Steps cap down one notch.
   * At floor, increments floorFailureCount; when it hits the recovery
   * threshold, the cap jumps back up to RECOVERY_CAP for another shot.
   */
  recordFailure(sessionDbId: number): void {
    const cur = this.state.get(sessionDbId) ?? {
      stepIndex: 0,
      floorFailureCount: 0,
    };
    const lastIdx = this.sequence.length - 1;

    if (cur.stepIndex < lastIdx) {
      cur.stepIndex += 1;
      cur.floorFailureCount = 0;
    } else {
      // Already at floor — count toward recovery
      cur.floorFailureCount += 1;
      if (cur.floorFailureCount >= FAILURES_AT_FLOOR_BEFORE_RECOVERY) {
        // Jump back to recovery step (index 1 = one halving below the cap).
        // For default sequence [150, 75, 37, ...] this lands at 75.
        // For single-element sequence (defaultCap=1), stays at 0.
        cur.stepIndex = this.sequence.length > 1 ? 1 : 0;
        cur.floorFailureCount = 0;
      }
    }
    this.state.set(sessionDbId, cur);
  }

  /**
   * Record a successful summarize. Holds the session at its current (possibly
   * reduced) cap rather than resetting to the top — see the class header for
   * why the old reset-to-default caused per-summary oscillation on dense
   * sessions. Clears floorFailureCount so a later failure starts a fresh
   * stepdown streak from the held level rather than carrying a stale counter.
   */
  recordSuccess(sessionDbId: number): void {
    const cur = this.state.get(sessionDbId);
    if (cur) cur.floorFailureCount = 0;
  }

  /** Forget one session (or all, if id omitted). */
  reset(sessionDbId?: number): void {
    if (sessionDbId === undefined) {
      this.state.clear();
    } else {
      this.state.delete(sessionDbId);
    }
  }
}
