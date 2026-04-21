/**
 * Generator Action — Centralized decision function for generator restart/abandon.
 *
 * PURE FUNCTION: decideGeneratorAction() has no I/O, no side effects.
 * Filesystem checks (existsSync) are performed by callers and passed via context.
 *
 * Eliminates the dual-.finally() synchronization problem (4 historical bugs).
 * Both SessionRoutes and WorkerService call this function to get a GeneratorAction,
 * then pass it to executeGeneratorAction() which handles the shared execution logic.
 */

import { existsSync } from 'fs';

// ── Types ──

export type GeneratorAction =
  | { type: 'abandon'; reason: 'context-exhausted' | 'restart-exhausted' | 'lifetime-exhausted' | 'db-unreachable' | 'unrecoverable' }
  | { type: 'proactive-reset' }
  | { type: 'crash-recovery'; backoffMs: number }
  | { type: 'pool-cooldown'; cooldownMs: number }
  | { type: 'idle-cleanup' }
  | { type: 'noop' };

export interface GeneratorActionContext {
  // Session state
  totalLifetimeCrashes: number;
  consecutiveRestarts: number;
  contextResetCount: number;
  pendingCount: number;
  /**
   * Count of pending/processing observation rows for the active turn
   * (message_type='observation' only). Distinct from `pendingCount`, which
   * includes summarize rows. Used by P2b to allow an observation-drain
   * restart during the close window.
   */
  pendingObservationCount: number;
  wasAborted: boolean;
  proactiveReset: boolean;
  isClosing: boolean;
  isIdleTimeout: boolean;

  // Error context
  error?: Error;
  dbFileExists?: boolean; // Caller-side fs.existsSync(session.dbPath) — undefined = not checked
  poolTimeoutDetected?: boolean; // Caller-side shouldEnterCooldown() result

  // Thresholds (from settings or constants)
  maxConsecutiveRestarts: number;
  maxContextResets: number;
  maxLifetimeCrashes: number;
  maxPoolRetries: number;
  poolCooldownMs: number;
}

// ── Unrecoverable error patterns (consolidated from worker-service.ts:647-654) ──

const UNRECOVERABLE_PATTERNS = [
  'ENOENT',
  'spawn',
  'Invalid API key',
  'FOREIGN KEY constraint failed',
  'permission denied',
  'EACCES',
] as const;

function isUnrecoverableError(error?: Error): boolean {
  if (!error) return false;
  const msg = error.message || '';
  return UNRECOVERABLE_PATTERNS.some(pattern => msg.includes(pattern));
}

// ── DB I/O error detection ──

export function isDbIoError(error?: Error | null): boolean {
  if (!error) return false;
  const msg = error.message || '';
  const code = (error as any).code;
  return msg.includes('disk I/O error')
    || msg.includes('unable to open database file')
    || msg.includes('database disk image is malformed')
    || code === 10   // SQLITE_IOERR
    || code === 14;  // SQLITE_CANTOPEN
}

// ── Project validity check ──

/**
 * Check if a project's DB file still exists.
 * Used as a pre-check before accessing DbConnectionPool (which would auto-create via ensureDir).
 * @param dbPath - Project DB path. If undefined, returns true (skip check).
 * @param existsFn - Injected for testability. Defaults to fs.existsSync.
 */
export function isProjectStillValid(
  dbPath: string | undefined,
  existsFn: (path: string) => boolean = existsSync,
): boolean {
  if (!dbPath) return true;
  return existsFn(dbPath);
}

// ── Core decision function (PURE — no I/O) ──

export function decideGeneratorAction(ctx: GeneratorActionContext): GeneratorAction {
  // P1: Unrecoverable error → immediate abandon
  if (isUnrecoverableError(ctx.error)) {
    return { type: 'abandon', reason: 'unrecoverable' };
  }

  // P2a: Idle timeout is always terminal for this generator — noop.
  if (ctx.isIdleTimeout) {
    return { type: 'noop' };
  }

  // P2b: Closing window — allow observation-drain via crash-recovery restart
  // if there is still observation work for this session. Once observations are
  // fully drained, close becomes terminal.
  if (ctx.isClosing) {
    if (ctx.pendingObservationCount > 0) {
      return { type: 'crash-recovery', backoffMs: 500 };
    }
    return { type: 'noop' };
  }

  // P3: Context reset exhausted → abandon
  if (ctx.contextResetCount >= ctx.maxContextResets) {
    return { type: 'abandon', reason: 'context-exhausted' };
  }

  // P4: Proactive reset (Layer C planned restart) → restart without crash counters
  if (ctx.proactiveReset) {
    return { type: 'proactive-reset' };
  }

  // P5: User abort (not proactiveReset, not context exhaustion) → noop
  if (ctx.wasAborted) {
    return { type: 'noop' };
  }

  // P6: DB unreachable (disk I/O error + file missing) → abandon
  if (isDbIoError(ctx.error) && ctx.dbFileExists === false) {
    return { type: 'abandon', reason: 'db-unreachable' };
  }

  // P7: Lifetime crash limit → abandon
  if (ctx.totalLifetimeCrashes >= ctx.maxLifetimeCrashes) {
    return { type: 'abandon', reason: 'lifetime-exhausted' };
  }

  // P8: No pending work → idle cleanup
  if (ctx.pendingCount === 0) {
    return { type: 'idle-cleanup' };
  }

  // P9: Pool timeout → cooldown (don't consume restart budget)
  if (ctx.poolTimeoutDetected) {
    return { type: 'pool-cooldown', cooldownMs: ctx.poolCooldownMs };
  }

  // P10: Restart budget exhausted → abandon
  if (ctx.consecutiveRestarts >= ctx.maxConsecutiveRestarts) {
    return { type: 'abandon', reason: 'restart-exhausted' };
  }

  // P11: Pending work + restart budget remaining → crash recovery
  if (ctx.pendingCount > 0) {
    const backoffMs = Math.min(1000 * Math.pow(2, ctx.consecutiveRestarts), 8000);
    return { type: 'crash-recovery', backoffMs: Math.max(backoffMs, 1000) };
  }

  // Default → noop
  return { type: 'noop' };
}

// ── Layer C: Proactive history reset check ──

/**
 * Check if conversation history has grown beyond safe thresholds.
 */
export function shouldProactiveReset(
  historyLength: number,
  history: { content?: string }[],
  maxLength: number,
  maxTokens: number,
): boolean {
  if (historyLength > maxLength) return true;
  const estimatedTokens = history.reduce(
    (sum, msg) => sum + Math.ceil((msg.content?.length || 0) / 4), 0
  );
  if (estimatedTokens > maxTokens) return true;
  return false;
}
