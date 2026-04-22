/**
 * Per-session adaptive observation-cap policy.
 *
 * Each SDK session gets its own cap on how many observations are embedded
 * into the fresh-summarize prompt. The cap shrinks on failure and resets on
 * success. At the floor (1 obs), N consecutive failures trigger a recovery
 * jump back to RECOVERY_CAP (30) so we don't stay stuck at "1 obs" after a
 * transient failure cleared.
 *
 * Why adaptive instead of static: session 164 on ClaudeMem-ProjIso
 * accumulated 215 obs → the default 60-cap prompt was ~70KB and worked.
 * But other sessions may have denser per-obs content — a static cap that
 * works for one project can fail on another. Stepdown probes the right
 * size for each session rather than betting on a universal number.
 */

export const STEP_SEQUENCE = Object.freeze([60, 30, 15, 7, 3, 1] as const);
export const DEFAULT_OBS_CAP = STEP_SEQUENCE[0]; // 60
export const OBS_CAP_FLOOR = STEP_SEQUENCE[STEP_SEQUENCE.length - 1]; // 1
export const RECOVERY_CAP = STEP_SEQUENCE[1]; // 30
export const FAILURES_AT_FLOOR_BEFORE_RECOVERY = 5;

interface SessionState {
  stepIndex: number;         // index into STEP_SEQUENCE
  floorFailureCount: number; // consecutive failures at floor (stepIndex === last)
}

export class ObsCapPolicy {
  private state = new Map<number, SessionState>();

  getCapForSession(sessionDbId: number): number {
    const s = this.state.get(sessionDbId);
    return STEP_SEQUENCE[s?.stepIndex ?? 0];
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
    const lastIdx = STEP_SEQUENCE.length - 1;

    if (cur.stepIndex < lastIdx) {
      cur.stepIndex += 1;
      cur.floorFailureCount = 0;
    } else {
      // Already at floor — count toward recovery
      cur.floorFailureCount += 1;
      if (cur.floorFailureCount >= FAILURES_AT_FLOOR_BEFORE_RECOVERY) {
        // Jump back to RECOVERY_CAP (index 1 → 30)
        cur.stepIndex = STEP_SEQUENCE.indexOf(RECOVERY_CAP);
        cur.floorFailureCount = 0;
      }
    }
    this.state.set(sessionDbId, cur);
  }

  /** Record a successful summarize — resets cap to default (60). */
  recordSuccess(sessionDbId: number): void {
    this.state.delete(sessionDbId);
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
