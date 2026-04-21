/**
 * SessionManager: Event-driven session lifecycle
 *
 * Responsibility:
 * - Manage active session lifecycle
 * - Handle event-driven message queues
 * - Coordinate between HTTP requests and SDK agent
 * - Zero-latency event notification (no polling)
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import path from 'path';
import { DatabaseManager } from './DatabaseManager.js';
import { logger } from '../../utils/logger.js';
import type { ActiveSession, PendingMessage, PendingMessageWithId, ObservationData } from '../worker-types.js';
import { PendingMessageStore } from '../sqlite/PendingMessageStore.js';
import { SessionQueueProcessor } from '../queue/SessionQueueProcessor.js';
import { getProcessBySession, ensureProcessExit } from './ProcessRegistry.js';
import { logSDKUsageSummary } from './SDKUsageTelemetry.js';
import { getBackpressureLevel, applyBackpressure } from './backpressure.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import type { SessionEventBroadcaster } from './events/SessionEventBroadcaster.js';

/** Info about sessions removed due to DB unreachable, for caller to handle SSE + bypass */
export interface DbUnreachableCleanup {
  sessionDbId: number;
  project: string;
  dbPath: string;
}

export class SessionManager {
  private dbManager: DatabaseManager;
  private sessions: Map<string, ActiveSession> = new Map();
  private sessionQueues: Map<string, EventEmitter> = new Map();
  private onSessionDeletedCallback?: () => void;
  private onStartGeneratorCallback?: (session: ActiveSession, source: string) => void;

  private sessionEventBroadcaster?: SessionEventBroadcaster;

  constructor(dbManager: DatabaseManager, sessionEventBroadcaster?: SessionEventBroadcaster) {
    this.dbManager = dbManager;
    this.sessionEventBroadcaster = sessionEventBroadcaster;
  }

  /**
   * Compute composite cache key to prevent cross-project collisions (B6).
   * Two different project databases can produce the same auto-increment ID.
   */
  private sessionKey(sessionDbId: number, dbPath?: string): string {
    return `${dbPath || '_default'}::${sessionDbId}`;
  }

  /**
   * Linear scan fallback when dbPath is unknown (e.g. legacy callers, startup recovery).
   * Returns the first matching key for the given sessionDbId.
   */
  private findSessionKey(sessionDbId: number): string | undefined {
    let found: string | undefined;
    for (const [key, session] of this.sessions) {
      if (session.sessionDbId === sessionDbId) {
        if (found) {
          logger.warn('SESSION', 'Multiple sessions found for same sessionDbId, using first match', {
            sessionDbId, firstKey: found, duplicateKey: key
          });
          return found;
        }
        found = key;
      }
    }
    return found;
  }

  /**
   * Get PendingMessageStore for a specific database path.
   *
   * Per-project isolation requires separate PendingMessageStore instances
   * because pending_messages has a FK on sdk_sessions(id) — the session must
   * exist in the SAME database where the message is enqueued.
   *
   * Always creates a fresh PendingMessageStore from the current pool handle
   * to avoid holding stale DB references after DbConnectionPool eviction.
   * PendingMessageStore is a lightweight wrapper, so re-creation cost is negligible.
   */
  private getPendingStore(dbPath?: string): PendingMessageStore {
    const sessionStore = this.dbManager.getSessionStore(dbPath);
    return new PendingMessageStore(sessionStore.db, 3);
  }

  /**
   * Public accessor for the pending-message store used by SummaryLane consumers.
   * Thin wrapper over the private getPendingStore to avoid widening visibility
   * for everyone; SummaryLane is the only external consumer.
   */
  public getPendingMessageStore(dbPath?: string): PendingMessageStore {
    return this.getPendingStore(dbPath);
  }

  /**
   * Set callback to be called when a session is deleted (for broadcasting status)
   */
  setOnSessionDeleted(callback: () => void): void {
    this.onSessionDeletedCallback = callback;
  }

  setOnStartGenerator(callback: (session: ActiveSession, source: string) => void): void {
    this.onStartGeneratorCallback = callback;
  }

  /**
   * True when a pending/processing summarize row exists for this session.
   * deleteSession() polls this during the legacy 60s drain window; Chunk 7
   * will drop the drain entirely once Stop hook stops calling deleteSession.
   */
  hasPendingSummarize(sessionDbId: number, dbPath?: string): boolean {
    try {
      const pendingStore = this.getPendingStore(dbPath);
      return pendingStore.hasPendingSummarize(sessionDbId);
    } catch {
      return false;
    }
  }

  /**
   * Initialize a new session or return existing one
   */
  initializeSession(sessionDbId: number, currentUserPrompt?: string, promptNumber?: number, dbPath?: string): ActiveSession {
    logger.debug('SESSION', 'initializeSession called', {
      sessionDbId,
      promptNumber,
      has_currentUserPrompt: !!currentUserPrompt,
      dbPath: dbPath || '(none)'
    });

    // Check if already active (composite key prevents cross-project collisions, B6)
    const key = this.sessionKey(sessionDbId, dbPath);
    let session = this.sessions.get(key);
    if (session) {
      logger.debug('SESSION', 'Returning cached session', {
        sessionDbId,
        contentSessionId: session.contentSessionId,
        lastPromptNumber: session.lastPromptNumber
      });

      // Refresh project from database in case it was updated by new-hook
      // This fixes the bug where sessions created with empty project get updated
      // in the database but the in-memory session still has the stale empty value
      const dbSession = this.dbManager.getSessionById(sessionDbId, dbPath);
      if (dbSession.project && dbSession.project !== session.project) {
        logger.debug('SESSION', 'Updating project from database', {
          sessionDbId,
          oldProject: session.project,
          newProject: dbSession.project
        });
        session.project = dbSession.project;
      }

      // Update userPrompt for continuation prompts
      if (currentUserPrompt) {
        logger.debug('SESSION', 'Updating userPrompt for continuation', {
          sessionDbId,
          promptNumber,
          oldPrompt: session.userPrompt.substring(0, 80),
          newPrompt: currentUserPrompt.substring(0, 80)
        });
        session.userPrompt = currentUserPrompt;
        session.lastPromptNumber = promptNumber || session.lastPromptNumber;
        // New prompt cycle — reset restart budget so the generator can try again
        session.consecutiveRestarts = 0;
        // A new prompt begins a new turn — clear per-turn flags set by
        // closeSession / reaper so the generator is not treated as closing.
        session.closing = false;
        session.closeBroadcasted = false;
        session.proactiveSummarizeQueued = false;
      } else {
        logger.debug('SESSION', 'No currentUserPrompt provided for existing session', {
          sessionDbId,
          promptNumber,
          usingCachedPrompt: session.userPrompt.substring(0, 80)
        });
      }
      return session;
    }

    // Fetch from database
    const dbSession = this.dbManager.getSessionById(sessionDbId, dbPath);

    logger.debug('SESSION', 'Fetched session from database', {
      sessionDbId,
      content_session_id: dbSession.content_session_id,
      memory_session_id: dbSession.memory_session_id
    });

    // Log warning if we're discarding a stale memory_session_id (Issue #817)
    if (dbSession.memory_session_id) {
      logger.warn('SESSION', `Discarding stale memory_session_id from previous worker instance (Issue #817)`, {
        sessionDbId,
        staleMemorySessionId: dbSession.memory_session_id,
        reason: 'SDK context lost on worker restart - will capture new ID'
      });
    }

    // Use currentUserPrompt if provided, otherwise fall back to database (first prompt)
    const userPrompt = currentUserPrompt || dbSession.user_prompt;

    if (!currentUserPrompt) {
      logger.debug('SESSION', 'No currentUserPrompt provided for new session, using database', {
        sessionDbId,
        promptNumber,
        dbPrompt: dbSession.user_prompt.substring(0, 80)
      });
    } else {
      logger.debug('SESSION', 'Initializing session with fresh userPrompt', {
        sessionDbId,
        promptNumber,
        userPrompt: currentUserPrompt.substring(0, 80)
      });
    }

    // Create active session
    // CRITICAL: Do NOT load memorySessionId from database here (Issue #817)
    // When creating a new in-memory session, any database memory_session_id is STALE
    // because the SDK context was lost when the worker restarted. The SDK agent will
    // capture a new memorySessionId on the first response and persist it.
    // Loading stale memory_session_id causes "No conversation found" crashes on resume.
    session = {
      sessionDbId,
      contentSessionId: dbSession.content_session_id,
      memorySessionId: null,  // Always start fresh - SDK will capture new ID
      project: dbSession.project,
      userPrompt,
      pendingMessages: [],
      abortController: new AbortController(),
      generatorPromise: null,
      lastPromptNumber: promptNumber || this.dbManager.getSessionStore(dbPath).getPromptNumberFromUserPrompts(dbSession.content_session_id),
      startTime: Date.now(),
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      earliestPendingTimestamp: null,
      conversationHistory: [],  // Initialize empty - will be populated by agents
      currentProvider: null,  // Will be set when generator starts
      consecutiveRestarts: 0,  // Track consecutive restart attempts to prevent infinite loops
      dbPath: dbPath || undefined,  // Project-specific SQLite DB path
      processingMessageIds: [],  // CLAIM-CONFIRM: Track message IDs for confirmProcessed()
      lastGeneratorActivity: Date.now(),  // Initialize for stale detection (Issue #1099)
      contextResetCount: 0,  // Consecutive forceInit triggers — capped to prevent infinite loop
      totalPoolTimeouts: 0,
      lastResponseAt: null,
      // Generator Safety Net (Phase 2)
      totalLifetimeCrashes: 0,
      consecutiveEmptyObservations: 0,
      peakConsecutiveEmptyObs: 0,
    };

    logger.debug('SESSION', 'Creating new session object (memorySessionId cleared to prevent stale resume)', {
      sessionDbId,
      contentSessionId: dbSession.content_session_id,
      dbMemorySessionId: dbSession.memory_session_id || '(none in DB)',
      memorySessionId: '(cleared - will capture fresh from SDK)',
      lastPromptNumber: promptNumber || this.dbManager.getSessionStore(dbPath).getPromptNumberFromUserPrompts(dbSession.content_session_id)
    });

    // Derive project from dbPath if database has empty project (EP)
    // Standard layout: <project>/.claude/mem.db → derive from grandparent
    // Non-standard (env override): best-effort from parent — acceptable as fallback
    if ((!session.project || session.project.trim() === '') && dbPath) {
      const parent = path.basename(path.dirname(dbPath));
      const derived = parent === '.claude'
        ? path.basename(path.dirname(path.dirname(dbPath)))
        : path.basename(path.dirname(dbPath));
      if (derived && derived.trim() !== '') {
        logger.warn('SESSION', 'Session has empty project, derived from dbPath', {
          sessionDbId, derived
        });
        session.project = derived;
      }
    }

    this.sessions.set(key, session);

    // Create event emitter for queue notifications
    const emitter = new EventEmitter();
    this.sessionQueues.set(key, emitter);

    logger.info('SESSION', 'Session initialized', {
      sessionId: sessionDbId,
      project: session.project,
      contentSessionId: session.contentSessionId,
      queueDepth: 0,
      hasGenerator: false
    });

    return session;
  }

  /**
   * Get active session by ID.
   * When dbPath is provided, uses composite key for O(1) lookup.
   * Otherwise, falls back to linear scan (legacy callers, startup recovery).
   */
  getSession(sessionDbId: number, dbPath?: string): ActiveSession | undefined {
    if (dbPath !== undefined) {
      return this.sessions.get(this.sessionKey(sessionDbId, dbPath));
    }
    for (const session of this.sessions.values()) {
      if (session.sessionDbId === sessionDbId) return session;
    }
    return undefined;
  }

  /**
   * Queue an observation for processing. Persist to database FIRST (crash-safe).
   * Layer 3 backpressure: may intentionally drop low-value observations under high queue depth.
   * @returns true if enqueued, false if dropped by backpressure
   */
  queueObservation(sessionDbId: number, data: ObservationData, dbPath?: string): boolean {
    // Auto-initialize from database if needed (handles worker restarts)
    const key = this.sessionKey(sessionDbId, dbPath);
    let session = this.sessions.get(key);
    if (!session) {
      session = this.initializeSession(sessionDbId, undefined, undefined, dbPath);
    }

    // New hook message arrived — CC is alive, clear idle timeout flag.
    // Must run BEFORE backpressure: even if observation is dropped, the session
    // should not be reaped as idle.
    if (session.lastExitWasIdleTimeout) {
      logger.debug('SESSION', 'Clearing lastExitWasIdleTimeout — CC alive', { sessionDbId: session.sessionDbId });
      session.lastExitWasIdleTimeout = false;
    }

    // Layer 3: Queue-depth backpressure (must be after initializeSession so session exists)
    const pendingStore = this.getPendingStore(session.dbPath);
    const bpPendingCount = pendingStore.getPendingCount(sessionDbId);
    const bpSettings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const bpL1 = parseInt(bpSettings.CLAUDE_MEM_BACKPRESSURE_L1, 10) || 20;
    const bpL2 = parseInt(bpSettings.CLAUDE_MEM_BACKPRESSURE_L2, 10) || 50;
    const bpSampleRate = parseInt(bpSettings.CLAUDE_MEM_BACKPRESSURE_SAMPLE_RATE, 10) || 3;
    const bpLevel = getBackpressureLevel(bpPendingCount, bpL1, bpL2);

    if (bpLevel > 0) {
      const shouldSkip = applyBackpressure(bpLevel, data.tool_name ?? '', data.tool_input ?? '', session as Record<string, unknown>, bpSampleRate);
      if (shouldSkip) {
        logger.info('QUEUE', 'Backpressure skip', {
          level: bpLevel, pendingCount: bpPendingCount,
          toolName: data.tool_name, sessionDbId
        });
        return false;
      }
    }

    // CRITICAL: Persist to database FIRST
    const message: PendingMessage = {
      type: 'observation',
      tool_name: data.tool_name,
      tool_input: data.tool_input,
      tool_response: data.tool_response,
      prompt_number: data.prompt_number,
      cwd: data.cwd
    };

    try {
      const messageId = pendingStore.enqueue(sessionDbId, session.contentSessionId, message);
      const queueDepth = pendingStore.getPendingCount(sessionDbId);
      const toolSummary = logger.formatTool(data.tool_name, data.tool_input);
      logger.info('QUEUE', `ENQUEUED | sessionDbId=${sessionDbId} | messageId=${messageId} | type=observation | tool=${toolSummary} | depth=${queueDepth}`, {
        sessionId: sessionDbId
      });
    } catch (error) {
      logger.error('SESSION', 'Failed to persist observation to DB', {
        sessionId: sessionDbId,
        tool: data.tool_name
      }, error);
      throw error; // Don't continue if we can't persist
    }

    // Notify generator immediately (zero latency)
    const emitter = this.sessionQueues.get(key);
    emitter?.emit('message');
    return true;
  }

  /**
   * Enqueue a summarize request for the SummaryLane consumer.
   *
   * Persists a `type='summarize'` row into `pending_messages` keyed by
   * `(content_session_id, prompt_number)`. SummaryLane runs a fresh SDK
   * subprocess per turn, so callers do NOT invoke the subprocess here; the
   * lane owns that lifecycle.
   *
   * Returns `{status:'skipped'}` when the turn is already summarized or has
   * a pending/processing summarize row; returns `{status:'queued'}` otherwise.
   */
  queueSummarize(
    sessionDbId: number,
    input: {
      lastAssistantMessage?: string;
      promptNumber: number;
      queuedAtEpoch: number;
    },
    dbPath?: string,
  ): { status: 'queued' | 'skipped'; obsCount: 0 } {
    const key = this.sessionKey(sessionDbId, dbPath);
    let session = this.sessions.get(key);
    if (!session) {
      session = this.initializeSession(sessionDbId, undefined, undefined, dbPath);
    }

    if (session.lastExitWasIdleTimeout) {
      logger.debug('SESSION', 'Clearing lastExitWasIdleTimeout — summarize received', {
        sessionDbId: session.sessionDbId,
      });
      session.lastExitWasIdleTimeout = false;
    }

    if (this.shouldDeduplicatePromptSummary({
      contentSessionId: session.contentSessionId,
      promptNumber: input.promptNumber,
      queuedAtEpoch: input.queuedAtEpoch,
      dbPath: session.dbPath,
    })) {
      return { status: 'skipped', obsCount: 0 };
    }

    const pendingStore = this.getPendingStore(session.dbPath);
    pendingStore.enqueue(sessionDbId, session.contentSessionId, {
      type: 'summarize',
      last_assistant_message: input.lastAssistantMessage,
      prompt_number: input.promptNumber,
    });

    return { status: 'queued', obsCount: 0 };
  }

  /**
   * Prompt-scoped dedupe: skip enqueue if this turn is already summarized OR
   * has a pending/processing summarize row. Empty-turn skip is deferred to
   * SummaryLane's drain-then-check (spec §4.2.C).
   */
  private shouldDeduplicatePromptSummary(input: {
    contentSessionId: string;
    promptNumber: number;
    queuedAtEpoch: number;
    dbPath?: string;
  }): boolean {
    const store = this.dbManager.getSessionStore(input.dbPath);
    try {
      const check = store.db.prepare(`
        SELECT
          EXISTS(
            SELECT 1 FROM session_summaries
            WHERE memory_session_id IN (
              SELECT memory_session_id FROM sdk_sessions WHERE content_session_id = ?
            ) AND prompt_number = ?
          ) AS already_summarized,
          EXISTS(
            SELECT 1 FROM pending_messages
            WHERE content_session_id = ?
              AND message_type = 'summarize'
              AND prompt_number = ?
              AND status IN ('pending', 'processing')
          ) AS already_queued
      `).get(
        input.contentSessionId,
        input.promptNumber,
        input.contentSessionId,
        input.promptNumber,
      ) as { already_summarized: 0 | 1; already_queued: 0 | 1 };
      return check.already_summarized === 1 || check.already_queued === 1;
    } catch (err) {
      logger.debug('SESSION', 'shouldDeduplicatePromptSummary query failed (defaulting to not-dedupe)', {
        contentSessionId: input.contentSessionId,
        promptNumber: input.promptNumber,
      }, err as Error);
      return false;
    }
  }

  /**
   * Close a session: mark DB row completed + broadcast + set closing flag.
   * Does NOT abort observer, does NOT remove from in-memory map, does NOT
   * wait for drain. Returns within ~5ms. The in-memory session is retained
   * so SummaryLane can look up session state until the reaper finalizes.
   *
   * Retry-safe (C4): if session.closing is already true, subsequent calls
   * short-circuit without re-broadcasting session_completed. Stop hook may
   * retry POST /complete on 499/network blips, and SSE consumers must not
   * receive duplicate session_completed events.
   */
  async closeSession(sessionDbId: number, dbPath?: string): Promise<void> {
    const key = dbPath !== undefined
      ? this.sessionKey(sessionDbId, dbPath)
      : this.findSessionKey(sessionDbId);
    if (!key) return;
    const session = this.sessions.get(key);
    if (!session) return;

    // Capture whether we already broadcast-fired. The closing flag may have
    // been set by deleteSession (which calls this method from its composition
    // path) before the DB update ran, so we cannot short-circuit on `closing`
    // alone — that would leave the DB in 'active' state forever.
    const alreadyBroadcasted = !!session.closeBroadcasted;

    // UPDATE is idempotent (guarded by status='active'), safe to run on retry.
    try {
      const store = this.dbManager.getSessionStore(session.dbPath);
      store.db.prepare(
        'UPDATE sdk_sessions SET status = ?, completed_at_epoch = ? WHERE id = ? AND status = ?'
      ).run('completed', Date.now(), sessionDbId, 'active');
    } catch (err) {
      logger.warn('SESSION', 'Failed to mark session completed', { sessionDbId }, err as Error);
    }

    session.closing = true;
    if (!alreadyBroadcasted) {
      session.closeBroadcasted = true;
      this.sessionEventBroadcaster?.broadcastSessionCompleted(sessionDbId, session.project);
    }
  }

  /**
   * In-memory cleanup. Triggered by reaper (15min idle + session.closing=true)
   * or worker shutdown. Aborts observer, waits generator (up to 30s), ensures
   * subprocess exit, removes from maps.
   */
  async finalizeSession(sessionDbId: number, dbPath?: string): Promise<void> {
    const key = dbPath !== undefined
      ? this.sessionKey(sessionDbId, dbPath)
      : this.findSessionKey(sessionDbId);
    if (!key) return;
    const session = this.sessions.get(key);
    if (!session) return;

    session.abortController.abort();

    if (session.generatorPromise) {
      const generatorDone = session.generatorPromise.catch(() => {
        logger.debug('SYSTEM', 'Generator already failed, cleaning up', { sessionId: session.sessionDbId });
      });
      const timeoutDone = new Promise<void>(resolve => {
        AbortSignal.timeout(30_000).addEventListener('abort', () => resolve(), { once: true });
      });
      await Promise.race([generatorDone, timeoutDone]).then(() => {}, () => {
        logger.warn('SESSION', 'Generator did not exit within 30s after abort, forcing cleanup (#1099)', { sessionDbId });
      });
    }

    const tracked = getProcessBySession(sessionDbId);
    if (tracked && tracked.process.exitCode === null) {
      logger.debug('SESSION', `Waiting for subprocess PID ${tracked.pid} to exit`, {
        sessionId: sessionDbId,
        pid: tracked.pid
      });
      await ensureProcessExit(tracked, 5000);
    }

    try {
      logSDKUsageSummary({ session, summaryType: 'session' });
    } catch {
      // best-effort
    }

    this.sessions.delete(key);
    this.sessionQueues.delete(key);

    if (this.onSessionDeletedCallback) {
      this.onSessionDeletedCallback();
    }
  }

  /**
   * Delete a session (abort SDK agent and cleanup)
   * Preserves the legacy 60s drain wait for admin DELETE callers until
   * Chunk 7 rewires the Stop hook to skip the drain entirely. Structurally
   * this is now `drain-wait + closeSession + finalizeSession`.
   */
  async deleteSession(sessionDbId: number, dbPath?: string): Promise<void> {
    const key = dbPath !== undefined
      ? this.sessionKey(sessionDbId, dbPath)
      : this.findSessionKey(sessionDbId);
    if (!key) return;
    const session = this.sessions.get(key);
    if (!session) return;

    const sessionDuration = Date.now() - session.startTime;

    // Mark closing early so generator-action treats pending exits as noop.
    session.closing = true;

    // Legacy drain wait — retained until Chunk 7 Stop-hook rewire removes it.
    const DRAIN_MAX_WAIT_MS = 60_000;
    const DRAIN_POLL_INTERVAL_MS = 500;
    try {
      const pendingStore = this.getPendingStore(session.dbPath);
      if (this.hasPendingSummarize(sessionDbId, session.dbPath)) {
        logger.info('SESSION', 'Waiting for pending summarize to drain before delete', { sessionDbId });
        let waited = 0;
        while (this.hasPendingSummarize(sessionDbId, session.dbPath) && waited < DRAIN_MAX_WAIT_MS) {
          await new Promise(resolve => setTimeout(resolve, DRAIN_POLL_INTERVAL_MS));
          waited += DRAIN_POLL_INTERVAL_MS;
        }
        if (waited >= DRAIN_MAX_WAIT_MS) {
          logger.warn('SESSION', `Summarize drain timed out after ${DRAIN_MAX_WAIT_MS}ms, proceeding with delete`, { sessionDbId });
          try {
            const { failed: abandonCount, retried } = pendingStore.markAllSessionMessagesAbandoned(sessionDbId);
            if (abandonCount + retried > 0) {
              logger.warn('SESSION', `Marked ${abandonCount} messages abandoned after drain timeout (${retried} retryable)`, { sessionDbId });
            }
          } catch (abandonError) {
            logger.warn('SESSION', 'Failed to mark messages as abandoned', { sessionDbId }, abandonError as Error);
          }
        } else {
          logger.info('SESSION', `Summarize drained after ${waited}ms`, { sessionDbId });
        }
      }
    } catch (error) {
      logger.warn('SESSION', 'Error during summarize drain check, proceeding with delete', { sessionDbId }, error as Error);
    }

    await this.closeSession(sessionDbId, dbPath);
    await this.finalizeSession(sessionDbId, dbPath);

    logger.info('SESSION', 'Session deleted', {
      sessionId: sessionDbId,
      duration: `${(sessionDuration / 1000).toFixed(1)}s`,
      project: session.project
    });
  }

  /**
   * Remove session from in-memory maps and notify without awaiting generator.
   * Used when SDK resume fails and we give up (no fallback): avoids deadlock
   * from deleteSession() awaiting the same generator promise we're inside.
   */
  removeSessionImmediate(sessionDbId: number, dbPath?: string): void {
    const key = dbPath !== undefined
      ? this.sessionKey(sessionDbId, dbPath)
      : this.findSessionKey(sessionDbId);
    if (!key) return;
    const session = this.sessions.get(key);
    if (!session) return;

    // Mark session as completed in database (best-effort)
    // Uses AND status = 'active' guard to avoid overwriting 'failed' status set by reaper
    try {
      const store = this.dbManager.getSessionStore(session.dbPath);
      store.db.prepare(
        'UPDATE sdk_sessions SET status = ?, completed_at_epoch = ? WHERE id = ? AND status = ?'
      ).run('completed', Date.now(), sessionDbId, 'active');
    } catch (error) {
      logger.warn('SESSION', 'Failed to mark session completed in DB', { sessionDbId }, error as Error);
    }

    logSDKUsageSummary({
      session,
      summaryType: 'session'
    });

    this.sessions.delete(key);
    this.sessionQueues.delete(key);

    logger.info('SESSION', 'Session removed (orphaned after SDK termination)', {
      sessionId: sessionDbId,
      project: session.project
    });

    if (this.onSessionDeletedCallback) {
      this.onSessionDeletedCallback();
    }
  }

  /**
   * Remove a session from memory ONLY — no database access.
   * Used when DB is unreachable (deleted directory, disk I/O error).
   * Does NOT call getSessionStore(), getStore(), or any DB method.
   */
  removeSessionMemoryOnly(sessionDbId: number, dbPath?: string): void {
    const key = dbPath !== undefined
      ? this.sessionKey(sessionDbId, dbPath)
      : this.findSessionKey(sessionDbId);
    if (!key) return;
    const session = this.sessions.get(key);
    if (!session) return;

    logSDKUsageSummary({
      session,
      summaryType: 'session'
    });

    this.sessions.delete(key);
    this.sessionQueues.delete(key);

    logger.info('SESSION', 'Session removed (memory-only, db-unreachable)', {
      sessionId: sessionDbId,
      project: session.project
    });

    if (this.onSessionDeletedCallback) {
      this.onSessionDeletedCallback();
    }
  }

  private static readonly MAX_SESSION_IDLE_MS = 15 * 60 * 1000; // 15 minutes

  /**
   * Reap sessions with no active generator and no pending work that have been idle too long.
   * This unblocks the orphan reaper which skips processes for "active" sessions. (Issue #1168)
   */
  async reapStaleSessions(): Promise<number> {
    const now = Date.now();
    const toReap: { key: string; sessionDbId: number; dbPath?: string }[] = [];
    const toSummarize: ActiveSession[] = [];

    for (const [key, session] of this.sessions) {
      // Skip sessions with active generators
      if (session.generatorPromise) continue;

      // S1 reaper auxiliary: sessions with high crash count in active crash-restart cycle
      // Intentionally lower than decideGeneratorAction P7 (>=10) — proactive backstop
      if (session.totalLifetimeCrashes > 5 &&
          (Date.now() - session.lastGeneratorActivity) < 5 * 60 * 1000) {
        logger.warn('SESSION', `Reaping crash-looping session (${session.totalLifetimeCrashes} lifetime crashes)`, {
          sessionDbId: session.sessionDbId,
          totalLifetimeCrashes: session.totalLifetimeCrashes,
        });
        toReap.push({ key, sessionDbId: session.sessionDbId, dbPath: session.dbPath });
        continue;
      }

      // Skip sessions in pool cooldown — timer or ghost cleanup will restart them
      if (session.poolCooldownUntil && Date.now() < session.poolCooldownUntil) continue;

      // D3 fix: skip sessions with pending work ONLY when generator is running (original logic).
      // Sessions with pending work but no generator and no cooldown are abandoned — reap them.
      const pendingCount = this.getPendingStore(session.dbPath).getPendingCount(session.sessionDbId);
      if (pendingCount > 0 && session.generatorPromise) continue;

      // Sessions with proactive summarize already queued: reap immediately
      // (skip idle time check — the summarize was the final lifecycle step)
      if (session.proactiveSummarizeQueued) {
        toReap.push({ key, sessionDbId: session.sessionDbId, dbPath: session.dbPath });
        continue;
      }

      // Use lastGeneratorActivity for idle detection (more accurate than startTime)
      const idleMs = now - session.lastGeneratorActivity;
      if (idleMs <= SessionManager.MAX_SESSION_IDLE_MS) continue;

      // Sessions closed by Stop hook (closing=true) and idle → final reap.
      // Do NOT queue another proactive summarize — the Stop hook already
      // queued one and the viewer has already received session_completed.
      if (session.closing) {
        logger.info(
          'SESSION',
          `Reaping closed session ${session.sessionDbId} (idle >${Math.round(SessionManager.MAX_SESSION_IDLE_MS / 60000)}m)`,
          { sessionDbId: session.sessionDbId },
        );
        toReap.push({ key, sessionDbId: session.sessionDbId, dbPath: session.dbPath });
        continue;
      }

      // If last generator exited due to idle timeout and no new hook messages arrived since,
      // CC is gone — reap directly instead of futile proactive summarize that would spin for
      // ~16 min waiting for a dead SDK subprocess
      if (session.lastExitWasIdleTimeout) {
        logger.info('SESSION', `Reaping idle-timeout session ${session.sessionDbId} directly (no new hook activity)`, {
          sessionDbId: session.sessionDbId,
          idleMs
        });
        toReap.push({ key, sessionDbId: session.sessionDbId, dbPath: session.dbPath });
        continue;
      }

      // Session is idle long enough — queue proactive summarize
      toSummarize.push(session);
    }

    // Phase 1: Queue proactive summarizes (SummaryLane picks them up).
    for (const session of toSummarize) {
      try {
        // Reaper needs a stable (contentSessionId, promptNumber) key. When the
        // session never recorded a prompt number, skip summarize and reap
        // directly — SummaryLane cannot consume anchorless rows.
        if (session.lastPromptNumber == null) {
          logger.info('SESSION', `Skipping proactive summarize — no lastPromptNumber`, {
            sessionDbId: session.sessionDbId,
          });
          toReap.push({
            key: this.sessionKey(session.sessionDbId, session.dbPath),
            sessionDbId: session.sessionDbId,
            dbPath: session.dbPath,
          });
          continue;
        }
        const result = this.queueSummarize(
          session.sessionDbId,
          {
            lastAssistantMessage: undefined,
            promptNumber: session.lastPromptNumber,
            queuedAtEpoch: Date.now(),
          },
          session.dbPath,
        );
        session.proactiveSummarizeQueued = true;
        // Reaper-initiated close is semantically equivalent to a Stop hook
        // close — set closing so Phase 2 routes through finalizeSession.
        session.closing = true;
        logger.info('SESSION', `Queued proactive summarize for idle session ${session.sessionDbId}`, {
          sessionDbId: session.sessionDbId,
          idleMs: now - session.lastGeneratorActivity,
          queueStatus: result.status,
        });
      } catch (error) {
        logger.warn('SESSION', `Proactive summarize failed, reaping directly`, { sessionDbId: session.sessionDbId }, error as Error);
        toReap.push({ key: this.sessionKey(session.sessionDbId, session.dbPath), sessionDbId: session.sessionDbId, dbPath: session.dbPath });
      }
    }

    // Phase 2: Reap sessions that are done with their summarize.
    // When session.closing=true the Stop hook already closed DB + broadcast,
    // so we go straight to finalizeSession (in-memory cleanup only).
    // Non-closed idle sessions keep the legacy deleteSession path for now.
    for (const { sessionDbId, dbPath } of toReap) {
      const reapKey = dbPath !== undefined
        ? this.sessionKey(sessionDbId, dbPath)
        : this.findSessionKey(sessionDbId);
      const reapSession = reapKey ? this.sessions.get(reapKey) : undefined;
      if (reapSession?.closing) {
        logger.warn('SESSION', `Finalizing closed session ${sessionDbId}`, { sessionDbId });
        await this.finalizeSession(sessionDbId, dbPath);
      } else {
        logger.warn('SESSION', `Reaping stale session ${sessionDbId} (non-closed path)`, { sessionDbId });
        await this.deleteSession(sessionDbId, dbPath);
      }
    }

    return toReap.length;
  }

  private static readonly GHOST_SESSION_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

  /**
   * Periodic DB scan for ghost sessions and stuck processing messages.
   * Ghost = session is 'active' in DB but absent from in-memory sessions Map.
   * Called from the 2-minute stale reaper interval (worker-service.ts).
   */
  cleanupGhostSessionsInDb(
    dbPaths: Set<string>,
    existsFn: (path: string) => boolean = fs.existsSync,
  ): DbUnreachableCleanup[] {
    const now = Date.now();
    const threshold = now - SessionManager.GHOST_SESSION_THRESHOLD_MS;
    const dbUnreachableCleanups: DbUnreachableCleanup[] = [];

    for (const dbPath of dbPaths) {
      // S5 PRE-CHECK: Verify DB file exists before accessing DbConnectionPool
      if (!existsFn(dbPath)) {
        const sessionsToRemove: { sessionDbId: number; project: string }[] = [];
        for (const [, session] of this.sessions) {
          if (session.dbPath === dbPath) {
            sessionsToRemove.push({ sessionDbId: session.sessionDbId, project: session.project });
          }
        }
        for (const { sessionDbId, project } of sessionsToRemove) {
          this.removeSessionMemoryOnly(sessionDbId, dbPath);
          dbUnreachableCleanups.push({ sessionDbId, project, dbPath });
          logger.warn('SESSION', `Ghost cleanup: DB missing, removed session from memory`, {
            sessionDbId,
            dbPath,
          });
        }
        try {
          this.dbManager.getPool().evict(dbPath);
        } catch {} // Best-effort
        continue;
      }

      try {
        const sessionStore = this.dbManager.getSessionStore(dbPath);
        const pendingStore = this.getPendingStore(dbPath);

        // D1: Find and clean ghost sessions
        const ghostCandidates = sessionStore.db.prepare(
          'SELECT id FROM sdk_sessions WHERE status = ? AND started_at_epoch < ?'
        ).all('active', threshold) as { id: number }[];

        for (const { id } of ghostCandidates) {
          const key = this.sessionKey(id, dbPath);
          if (this.sessions.has(key)) continue; // In memory — not a ghost

          const sessionResult = sessionStore.db.prepare(
            'UPDATE sdk_sessions SET status = ?, completed_at_epoch = ? WHERE id = ? AND status = ?'
          ).run('failed', now, id, 'active');

          if (sessionResult.changes > 0) {
            const msgResult = sessionStore.db.prepare(
              "UPDATE pending_messages SET status = 'failed', failed_at_epoch = ? WHERE session_db_id = ? AND status IN ('pending', 'processing')"
            ).run(now, id);

            logger.warn('SESSION', `Ghost session ${id} cleaned up`, {
              sessionDbId: id,
              dbPath,
              messagesMarkedFailed: msgResult.changes
            });
          }
        }

        // D2: Reset stuck processing messages across ALL sessions
        const resetCount = pendingStore.resetStaleProcessingMessages(5 * 60 * 1000);
        if (resetCount > 0) {
          logger.info('SESSION', `Reset ${resetCount} stuck processing message(s)`, { dbPath });
        }
      } catch (error) {
        // S5 CATCH: Check if error is DB unreachable
        if (error instanceof Error && (error.message.includes('disk I/O error')
            || error.message.includes('unable to open database file'))) {
          if (!existsFn(dbPath)) {
            const toRemoveCatch: { sessionDbId: number; project: string }[] = [];
            for (const [, session] of this.sessions) {
              if (session.dbPath === dbPath) toRemoveCatch.push({ sessionDbId: session.sessionDbId, project: session.project });
            }
            for (const { sessionDbId, project } of toRemoveCatch) {
              this.removeSessionMemoryOnly(sessionDbId, dbPath);
              dbUnreachableCleanups.push({ sessionDbId, project, dbPath });
            }
            try {
              this.dbManager.getPool().evict(dbPath);
            } catch {}
          }
        }
        logger.warn('SESSION', 'Ghost cleanup failed for DB (skipping)', { dbPath }, error as Error);
      }
    }

    // Check for sessions stuck in expired cooldown (e.g., worker restarted during cooldown)
    for (const [, session] of this.sessions) {
      if (session.poolCooldownUntil &&
          Date.now() >= session.poolCooldownUntil &&
          !session.generatorPromise) {
        logger.info('SESSION', 'Clearing expired pool cooldown, attempting generator restart', {
          sessionDbId: session.sessionDbId,
          cooldownExpiredMs: Date.now() - session.poolCooldownUntil,
        });
        session.poolCooldownUntil = undefined;
        session.consecutiveRestarts = 0;
        const pendingStore = this.getPendingMessageStore(session.dbPath);
        const pendingCount = pendingStore.getPendingCount(session.sessionDbId);
        if (pendingCount > 0 && this.onStartGeneratorCallback) {
          this.onStartGeneratorCallback(session, 'cooldown-expired-recovery');
        }
      }
    }

    return dbUnreachableCleanups;
  }

  /**
   * Shutdown all active sessions
   */
  async shutdownAll(): Promise<void> {
    const entries = Array.from(this.sessions.values());
    await Promise.all(entries.map(session => this.deleteSession(session.sessionDbId, session.dbPath)));
  }

  /**
   * Clean up orphaned pending messages from previous Worker crashes.
   * Called once on Worker startup.
   *
   * 1. Resets stale 'processing' messages (>5min) back to 'pending'
   * 2. Marks orphaned summarize messages as 'failed':
   *    - Session not in active sessions map
   *    - Message older than 5 minutes
   */
  cleanupOrphanedMessages(dbPath?: string): void {
    try {
      const pendingStore = this.getPendingStore(dbPath);
      const resetCount = pendingStore.resetStaleProcessingMessages(); // default: 5 min threshold
      // Filter to sessions belonging to this specific DB to avoid cross-project false matches (W4)
      const activeSessionIds = Array.from(this.sessions.values())
        .filter(s => s.dbPath === dbPath || (!s.dbPath && !dbPath))
        .map(s => s.sessionDbId);
      const orphanCount = pendingStore.markOrphanedSummarizesFailed(activeSessionIds);

      if (resetCount > 0 || orphanCount > 0) {
        logger.info('SESSION', 'Startup orphan cleanup complete', {
          staleReset: resetCount,
          orphanedFailed: orphanCount
        });
      }
    } catch (error) {
      logger.warn('SESSION', 'Orphan cleanup failed (non-fatal)', {}, error as Error);
    }
  }

  /**
   * Check if any session has pending messages (for spinner tracking)
   */
  hasPendingMessages(): boolean {
    for (const session of this.sessions.values()) {
      if (this.getPendingStore(session.dbPath).getPendingCount(session.sessionDbId) > 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get number of active sessions (for stats)
   */
  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  getActiveSessions(): IterableIterator<ActiveSession> {
    return this.sessions.values();
  }

  /**
   * Get distinct project names that have active sessions (for viewer dashboard)
   */
  getActiveProjectNames(): Set<string> {
    const names = new Set<string>();
    for (const session of this.sessions.values()) {
      if (session.project) names.add(session.project);
    }
    return names;
  }

  /**
   * Get total queue depth across all sessions (for activity indicator)
   */
  getTotalQueueDepth(): number {
    let total = 0;
    for (const session of this.sessions.values()) {
      total += this.getPendingStore(session.dbPath).getPendingCount(session.sessionDbId);
    }
    return total;
  }

  /**
   * Get total active work (queued + currently processing)
   * Counts both pending messages and items actively being processed by SDK agents
   */
  getTotalActiveWork(): number {
    // getPendingCount includes 'processing' status, so this IS the total active work
    return this.getTotalQueueDepth();
  }

  /**
   * Check if any session is actively processing (has pending messages OR active generator)
   * Used for activity indicator to prevent spinner from stopping while SDK is processing
   */
  isAnySessionProcessing(): boolean {
    for (const session of this.sessions.values()) {
      if (this.getPendingStore(session.dbPath).getPendingCount(session.sessionDbId) > 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get message iterator for SDKAgent to consume (event-driven, no polling)
   * Auto-initializes session if not in memory but exists in database
   *
   * CRITICAL: Uses PendingMessageStore for crash-safe message persistence.
   * Messages are marked as 'processing' when yielded and must be marked 'processed'
   * by the SDK agent after successful completion.
   */
  async *getMessageIterator(sessionDbId: number, dbPath?: string): AsyncIterableIterator<PendingMessageWithId> {
    // Auto-initialize from database if needed (handles worker restarts)
    const key = this.sessionKey(sessionDbId, dbPath);
    let session = this.sessions.get(key);
    if (!session) {
      session = this.initializeSession(sessionDbId, undefined, undefined, dbPath);
    }

    const emitter = this.sessionQueues.get(key);
    if (!emitter) {
      throw new Error(`No emitter for session ${sessionDbId}`);
    }

    const processor = new SessionQueueProcessor(this.getPendingStore(session.dbPath), emitter);

    // Use the robust iterator - messages are deleted on claim (no tracking needed)
    // CRITICAL: Pass onIdleTimeout callback that triggers abort to kill the subprocess
    // Without this, the iterator returns but the Claude subprocess stays alive as a zombie
    for await (const message of processor.createIterator({
      sessionDbId,
      signal: session.abortController.signal,
      onIdleTimeout: () => {
        logger.info('SESSION', 'Triggering abort due to idle timeout to kill subprocess', { sessionDbId });
        session.idleTimedOut = true;
        session.abortController.abort();
      }
    })) {
      // Track earliest timestamp for accurate observation timestamps
      // This ensures backlog messages get their original timestamps, not current time
      if (session.earliestPendingTimestamp === null) {
        session.earliestPendingTimestamp = message._originalTimestamp;
      } else {
        session.earliestPendingTimestamp = Math.min(session.earliestPendingTimestamp, message._originalTimestamp);
      }

      // Update generator activity for stale detection (Issue #1099)
      session.lastGeneratorActivity = Date.now();

      yield message;
    }
  }

  /**
   * Get the PendingMessageStore for a specific database path
   * (for SDKAgent to mark messages as processed)
   */
  getPendingMessageStore(dbPath?: string): PendingMessageStore {
    return this.getPendingStore(dbPath);
  }

  /**
   * Collect per-session diagnostics for the health endpoint.
   * Iterates active sessions, queries queue stats, detects stuck sessions.
   */
  getDiagnostics(): {
    totalPendingMessages: number;
    totalProcessingMessages: number;
    sessions: Array<{
      sessionDbId: number;
      project: string;
      idleSeconds: number;
      pendingCount: number;
      processingCount: number;
      status: 'healthy' | 'idle' | 'stuck';
    }>;
  } {
    const IDLE_THRESHOLD_MS = 3 * 60 * 1000; // Match SessionQueueProcessor IDLE_TIMEOUT_MS
    const now = Date.now();
    let totalPending = 0;
    let totalProcessing = 0;
    const sessionDiags: Array<{
      sessionDbId: number;
      project: string;
      idleSeconds: number;
      pendingCount: number;
      processingCount: number;
      status: 'healthy' | 'idle' | 'stuck';
    }> = [];

    for (const session of this.sessions.values()) {
      try {
        const store = this.getPendingStore(session.dbPath);
        const stats = store.getQueueStats(session.sessionDbId);
        totalPending += stats.pendingCount;
        totalProcessing += stats.processingCount;

        const idleMs = now - (session.lastGeneratorActivity || session.startTime || now);
        const idleSeconds = Math.floor(idleMs / 1000);
        const hasPending = stats.pendingCount + stats.processingCount > 0;

        let status: 'healthy' | 'idle' | 'stuck' = 'healthy';
        if (idleMs >= IDLE_THRESHOLD_MS && hasPending) {
          status = 'stuck';
        } else if (idleMs >= IDLE_THRESHOLD_MS) {
          status = 'idle';
        }

        sessionDiags.push({
          sessionDbId: session.sessionDbId,
          project: session.project || 'unknown',
          idleSeconds,
          pendingCount: stats.pendingCount,
          processingCount: stats.processingCount,
          status,
        });
      } catch (err) {
        logger.warn('SESSION', 'getDiagnostics: DB error for session, reporting as unknown', {
          sessionDbId: session.sessionDbId, error: err instanceof Error ? err.message : String(err),
        });
        sessionDiags.push({
          sessionDbId: session.sessionDbId,
          project: session.project || 'unknown',
          idleSeconds: -1, pendingCount: -1, processingCount: -1, status: 'healthy',
        });
      }
    }

    return {
      totalPendingMessages: totalPending,
      totalProcessingMessages: totalProcessing,
      sessions: sessionDiags,
    };
  }

  /**
   * Notify main-lane consumers that a message is available for claim.
   * Called by BypassLane when it requeues a failed message — wakes
   * the main lane's waitForMessage() immediately instead of waiting
   * for the 3-minute idle timeout.
   */
  notifyMessageAvailable(sessionDbId: number, dbPath?: string): void {
    const key = this.sessionKey(sessionDbId, dbPath);
    const emitter = this.sessionQueues.get(key);
    emitter?.emit('message');
  }
}
