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
import { DatabaseManager } from './DatabaseManager.js';
import { logger } from '../../utils/logger.js';
import type { ActiveSession, PendingMessage, PendingMessageWithId, ObservationData } from '../worker-types.js';
import { PendingMessageStore } from '../sqlite/PendingMessageStore.js';
import { SessionQueueProcessor } from '../queue/SessionQueueProcessor.js';
import { getProcessBySession, ensureProcessExit } from './ProcessRegistry.js';

export class SessionManager {
  private dbManager: DatabaseManager;
  private sessions: Map<string, ActiveSession> = new Map();
  private sessionQueues: Map<string, EventEmitter> = new Map();
  private onSessionDeletedCallback?: () => void;
  private onStartGeneratorCallback?: (session: ActiveSession, source: string) => void;

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
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
   * Set callback to be called when a session is deleted (for broadcasting status)
   */
  setOnSessionDeleted(callback: () => void): void {
    this.onSessionDeletedCallback = callback;
  }

  setOnStartGenerator(callback: (session: ActiveSession, source: string) => void): void {
    this.onStartGeneratorCallback = callback;
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
      lastGeneratorActivity: Date.now()  // Initialize for stale detection (Issue #1099)
    };

    logger.debug('SESSION', 'Creating new session object (memorySessionId cleared to prevent stale resume)', {
      sessionDbId,
      contentSessionId: dbSession.content_session_id,
      dbMemorySessionId: dbSession.memory_session_id || '(none in DB)',
      memorySessionId: '(cleared - will capture fresh from SDK)',
      lastPromptNumber: promptNumber || this.dbManager.getSessionStore(dbPath).getPromptNumberFromUserPrompts(dbSession.content_session_id)
    });

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
   * Queue an observation for processing (zero-latency notification)
   * Auto-initializes session if not in memory but exists in database
   *
   * CRITICAL: Persists to database FIRST before adding to in-memory queue.
   * This ensures observations survive worker crashes.
   */
  queueObservation(sessionDbId: number, data: ObservationData, dbPath?: string): void {
    // Auto-initialize from database if needed (handles worker restarts)
    const key = this.sessionKey(sessionDbId, dbPath);
    let session = this.sessions.get(key);
    if (!session) {
      session = this.initializeSession(sessionDbId, undefined, undefined, dbPath);
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
      const pendingStore = this.getPendingStore(session.dbPath);
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
  }

  /**
   * Queue a summarize request (zero-latency notification)
   * Auto-initializes session if not in memory but exists in database
   *
   * CRITICAL: Persists to database FIRST before adding to in-memory queue.
   * This ensures summarize requests survive worker crashes.
   */
  queueSummarize(sessionDbId: number, lastAssistantMessage?: string, dbPath?: string): void {
    // Auto-initialize from database if needed (handles worker restarts)
    const key = this.sessionKey(sessionDbId, dbPath);
    let session = this.sessions.get(key);
    if (!session) {
      session = this.initializeSession(sessionDbId, undefined, undefined, dbPath);
    }

    // CRITICAL: Persist to database FIRST
    const message: PendingMessage = {
      type: 'summarize',
      last_assistant_message: lastAssistantMessage
    };

    try {
      const pendingStore = this.getPendingStore(session.dbPath);
      const messageId = pendingStore.enqueue(sessionDbId, session.contentSessionId, message);
      const queueDepth = pendingStore.getPendingCount(sessionDbId);
      logger.info('QUEUE', `ENQUEUED | sessionDbId=${sessionDbId} | messageId=${messageId} | type=summarize | depth=${queueDepth}`, {
        sessionId: sessionDbId
      });
    } catch (error) {
      logger.error('SESSION', 'Failed to persist summarize to DB', {
        sessionId: sessionDbId
      }, error);
      throw error; // Don't continue if we can't persist
    }

    const emitter = this.sessionQueues.get(key);
    emitter?.emit('message');
  }

  /**
   * Delete a session (abort SDK agent and cleanup)
   * Verifies subprocess exit to prevent zombie process accumulation (Issue #737)
   */
  async deleteSession(sessionDbId: number, dbPath?: string): Promise<void> {
    const key = dbPath !== undefined
      ? this.sessionKey(sessionDbId, dbPath)
      : this.findSessionKey(sessionDbId);
    if (!key) return; // Already deleted
    const session = this.sessions.get(key);
    if (!session) {
      return; // Already deleted
    }

    const sessionDuration = Date.now() - session.startTime;

    // NEW: Wait for pending summarize messages before aborting
    // This prevents summary loss when session-complete arrives before
    // the SDKAgent finishes processing the summarize message.
    const DRAIN_MAX_WAIT_MS = 10_000;
    const DRAIN_POLL_INTERVAL_MS = 500;
    try {
      const pendingStore = this.getPendingStore(session.dbPath);
      if (pendingStore.hasPendingSummarize(sessionDbId)) {
        logger.info('SESSION', 'Waiting for pending summarize to drain before delete', { sessionDbId });
        let waited = 0;
        while (pendingStore.hasPendingSummarize(sessionDbId) && waited < DRAIN_MAX_WAIT_MS) {
          await new Promise(resolve => setTimeout(resolve, DRAIN_POLL_INTERVAL_MS));
          waited += DRAIN_POLL_INTERVAL_MS;
        }
        if (waited >= DRAIN_MAX_WAIT_MS) {
          logger.warn('SESSION', `Summarize drain timed out after ${DRAIN_MAX_WAIT_MS}ms, proceeding with delete`, { sessionDbId });
          // Mark any remaining pending/processing messages as failed
          // so they don't become permanent orphans
          try {
            const abandonCount = pendingStore.markAllSessionMessagesAbandoned(sessionDbId);
            if (abandonCount > 0) {
              logger.warn('SESSION', `Marked ${abandonCount} pending messages as abandoned after drain timeout`, { sessionDbId });
            }
          } catch (abandonError) {
            logger.warn('SESSION', 'Failed to mark messages as abandoned', { sessionDbId }, abandonError as Error);
          }
        } else {
          logger.info('SESSION', `Summarize drained after ${waited}ms`, { sessionDbId });
        }
      }
    } catch (error) {
      // Don't let drain errors block session cleanup
      logger.warn('SESSION', 'Error during summarize drain check, proceeding with delete', { sessionDbId }, error as Error);
    }

    // 1. Abort the SDK agent
    session.abortController.abort();

    // 2. Wait for generator to finish (with 30s timeout to prevent stale stall, Issue #1099)
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

    // 3. Verify subprocess exit with 5s timeout (Issue #737 fix)
    const tracked = getProcessBySession(sessionDbId);
    if (tracked && !tracked.process.killed && tracked.process.exitCode === null) {
      logger.debug('SESSION', `Waiting for subprocess PID ${tracked.pid} to exit`, {
        sessionId: sessionDbId,
        pid: tracked.pid
      });
      await ensureProcessExit(tracked, 5000);
    }

    // 4. Mark session as completed in database (best-effort)
    // Uses AND status = 'active' guard to avoid overwriting 'failed' status set by reaper
    try {
      const store = this.dbManager.getSessionStore(session.dbPath);
      store.db.prepare(
        'UPDATE sdk_sessions SET status = ?, completed_at_epoch = ? WHERE id = ? AND status = ?'
      ).run('completed', Date.now(), sessionDbId, 'active');
    } catch (error) {
      logger.warn('SESSION', 'Failed to mark session completed in DB', { sessionDbId }, error as Error);
    }

    // 5. Cleanup
    this.sessions.delete(key);
    this.sessionQueues.delete(key);

    logger.info('SESSION', 'Session deleted', {
      sessionId: sessionDbId,
      duration: `${(sessionDuration / 1000).toFixed(1)}s`,
      project: session.project
    });

    // Trigger callback to broadcast status update (spinner may need to stop)
    if (this.onSessionDeletedCallback) {
      this.onSessionDeletedCallback();
    }
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

      // Skip sessions with pending work
      const pendingCount = this.getPendingStore(session.dbPath).getPendingCount(session.sessionDbId);
      if (pendingCount > 0) continue;

      // Sessions with proactive summarize already queued: reap immediately
      // (skip idle time check — the summarize was the final lifecycle step)
      if (session.proactiveSummarizeQueued) {
        toReap.push({ key, sessionDbId: session.sessionDbId, dbPath: session.dbPath });
        continue;
      }

      // Use lastGeneratorActivity for idle detection (more accurate than startTime)
      const idleMs = now - session.lastGeneratorActivity;
      if (idleMs <= SessionManager.MAX_SESSION_IDLE_MS) continue;

      // Session is idle long enough — queue proactive summarize
      toSummarize.push(session);
    }

    // Phase 1: Queue proactive summarizes (will be reaped on next cycle)
    for (const session of toSummarize) {
      try {
        this.queueSummarize(session.sessionDbId, undefined, session.dbPath);
        session.proactiveSummarizeQueued = true;
        logger.info('SESSION', `Queued proactive summarize for idle session ${session.sessionDbId}`, {
          sessionDbId: session.sessionDbId,
          idleMs: now - session.lastGeneratorActivity
        });
        if (this.onStartGeneratorCallback) {
          this.onStartGeneratorCallback(session, 'proactive-summarize');
        }
      } catch (error) {
        // Summarize queue failed — reap immediately instead of leaving in limbo
        logger.warn('SESSION', `Proactive summarize failed, reaping directly`, { sessionDbId: session.sessionDbId }, error as Error);
        toReap.push({ key: this.sessionKey(session.sessionDbId, session.dbPath), sessionDbId: session.sessionDbId, dbPath: session.dbPath });
      }
    }

    // Phase 2: Reap sessions that are done with their summarize
    for (const { sessionDbId, dbPath } of toReap) {
      logger.warn('SESSION', `Reaping stale session ${sessionDbId} (idle >${Math.round(SessionManager.MAX_SESSION_IDLE_MS / 60000)}m)`, { sessionDbId });
      await this.deleteSession(sessionDbId, dbPath);
    }

    return toReap.length;
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
}
