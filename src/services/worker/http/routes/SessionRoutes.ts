/**
 * Session Routes
 *
 * Handles session lifecycle operations: initialization, observations, summarization, completion.
 * These routes manage the flow of work through the Claude Agent SDK.
 */

import express, { Request, Response } from 'express';
import { getWorkerPort } from '../../../../shared/worker-utils.js';
import { logger } from '../../../../utils/logger.js';
import { shouldClearStaleAnchorOnResumeFailure, resetSessionAnchorForFreshStart } from '../../../../shared/observer-anchor.js';
import { stripMemoryTagsFromPrompt, stripMemoryTagsFromPromptDetailed } from '../../../../utils/tag-stripping.js';
import { cleanToolField } from './observation-utils.js';
import { parseSkipPatterns, shouldSkipObservation, layerAStats, type ToolPattern } from './observation-filter.js';
import { SessionManager } from '../../SessionManager.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { SDKAgent } from '../../SDKAgent.js';
import type { WorkerService } from '../../../worker-service.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { SessionEventBroadcaster } from '../../events/SessionEventBroadcaster.js';
import { SessionCompletionHandler } from '../../session/SessionCompletionHandler.js';
import { PrivacyCheckValidator } from '../../validation/PrivacyCheckValidator.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, projectNameFromDbPath } from '../../../../shared/paths.js';
import { getProcessBySession, ensureProcessExit } from '../../ProcessRegistry.js';
import { getProjectName } from '../../../../utils/project-name.js';
import type { BypassLane } from '../../BypassLane.js';
import { shouldEnterCooldown } from './pool-cooldown-utils.js';
import { existsSync } from 'fs';
import type { ActiveSession } from '../../../worker-types.js';
import {
  decideGeneratorAction,
  isDbIoError,
  isProjectStillValid,
  type GeneratorAction,
} from '../../generator-action.js';

let cachedPatterns: { key: string; patterns: ToolPattern[] } | null = null;

export class SessionRoutes extends BaseRouteHandler {
  private completionHandler: SessionCompletionHandler;
  private spawnInProgress = new Map<string, boolean>();
  private crashRecoveryScheduled = new Set<string>();
  private bypassLane: BypassLane | null = null;

  /** Composite key to prevent cross-project collisions on same auto-increment sessionDbId */
  private spawnKey(sessionDbId: number, dbPath?: string): string {
    return `${dbPath || '_default'}::${sessionDbId}`;
  }

  constructor(
    private sessionManager: SessionManager,
    private dbManager: DatabaseManager,
    private sdkAgent: SDKAgent,
    private eventBroadcaster: SessionEventBroadcaster,
    private workerService: WorkerService
  ) {
    super();
    this.completionHandler = new SessionCompletionHandler(
      sessionManager,
      eventBroadcaster
    );
  }

  /** Inject bypass lane reference (called from WorkerService after construction). */
  setBypassLane(bypassLane: BypassLane): void {
    this.bypassLane = bypassLane;
  }

  /**
   * Get the currently selected provider name for main channel.
   */
  private getSelectedProvider(): 'claude' {
    return 'claude';
  }

  /**
   * Ensures SDK agent generator is running for a session.
   * Auto-starts if not already running to process pending queue.
   */
  private static readonly STALE_GENERATOR_THRESHOLD_MS = 30_000; // 30 seconds (#1099)
  private static readonly MAX_CONSECUTIVE_RESTARTS = 3;

  private ensureGeneratorRunning(sessionDbId: number, source: string, dbPath?: string): void {
    const session = this.sessionManager.getSession(sessionDbId, dbPath);
    if (!session) return;

    const key = this.spawnKey(sessionDbId, dbPath);

    // Wall-clock age guard: refuse new generators for sessions alive too long, to
    // cap runaway API spend (#1590). Use persisted started_at_epoch (milliseconds
    // since epoch — same unit as Date.now()) so the guard survives worker restarts
    // (session.startTime resets on every re-activation).
    const settingsForAge = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const maxAgeMs = parseInt(settingsForAge.CLAUDE_MEM_SESSION_MAX_AGE_MS, 10) || 14400000;
    const dbSessionRecord = this.dbManager.getSessionStore(session.dbPath).db
      .prepare('SELECT started_at_epoch FROM sdk_sessions WHERE id = ? LIMIT 1')
      .get(sessionDbId) as { started_at_epoch: number } | undefined;
    // started_at_epoch and session.startTime are BOTH milliseconds — no conversion.
    const sessionOriginMs = dbSessionRecord?.started_at_epoch ?? session.startTime;
    const sessionAgeMs = Date.now() - sessionOriginMs;
    if (sessionAgeMs > maxAgeMs) {
      logger.warn('SESSION', 'Session exceeded wall-clock age limit — aborting to prevent runaway spend', {
        sessionId: sessionDbId,
        ageHours: Math.round(sessionAgeMs / 3_600_000 * 10) / 10,
        limitHours: maxAgeMs / 3_600_000,
        source
      });
      if (!session.abortController.signal.aborted) {
        session.abortController.abort();
      }
      this.bypassLane?.stopForSession(sessionDbId); // Mirror stale-recovery teardown ordering (line 139)
      const pendingStore = this.sessionManager.getPendingMessageStore(session.dbPath);
      pendingStore.markAllSessionMessagesAbandoned(sessionDbId);
      this.sessionManager.removeSessionImmediate(sessionDbId, session.dbPath);
      return;
    }

    // GUARD: Prevent duplicate spawns
    if (this.spawnInProgress.get(key)) {
      logger.debug('SESSION', 'Spawn already in progress, skipping', { sessionDbId, source });
      return;
    }

    const selectedProvider = this.getSelectedProvider();

    // Pool cooldown guard — don't start generator during cooldown period.
    // Exception: 'init' (new user prompt) breaks cooldown — environment may have changed.
    if (session.poolCooldownUntil && Date.now() < session.poolCooldownUntil) {
      if (source !== 'init') {
        logger.debug('SESSION', 'In pool cooldown, skipping generator start', {
          sessionDbId, source,
          cooldownRemainingMs: session.poolCooldownUntil - Date.now()
        });
        return;
      }
      // New prompt breaks cooldown
      session.poolCooldownUntil = undefined;
      session.consecutiveRestarts = 0;
    }

    // Start generator if not running
    if (!session.generatorPromise) {
      // GUARD: Don't restart if the session already exhausted its restart budget.
      // 'init' is always preceded by initializeSession() which resets consecutiveRestarts
      // to 0 when a new prompt arrives, so the limit is vacuously false for init calls.
      // Observation/summarize events within the same prompt cycle must respect the limit.
      if (session.consecutiveRestarts > SessionRoutes.MAX_CONSECUTIVE_RESTARTS && source !== 'init') {
        logger.debug('SESSION', 'Skipping generator start — restart limit already exceeded', {
          sessionDbId, source, consecutiveRestarts: session.consecutiveRestarts
        });
        return;
      }
      this.spawnInProgress.set(key, true);
      this.startGeneratorWithProvider(session, selectedProvider, source);
      return;
    }

    // Generator is running - check if stale (no activity for 30s) to prevent queue stall (#1099)
    const timeSinceActivity = Date.now() - session.lastGeneratorActivity;
    if (timeSinceActivity > SessionRoutes.STALE_GENERATOR_THRESHOLD_MS) {
      logger.warn('SESSION', 'Stale generator detected, aborting to prevent queue stall (#1099)', {
        sessionId: sessionDbId,
        timeSinceActivityMs: timeSinceActivity,
        thresholdMs: SessionRoutes.STALE_GENERATOR_THRESHOLD_MS,
        source
      });
      // Abort the stale generator and reset state
      this.bypassLane?.stopForSession(session.sessionDbId); // Must precede AbortController replace (H1 pattern)
      session.abortController.abort();
      session.generatorPromise = null;
      session.abortController = new AbortController();
      session.lastGeneratorActivity = Date.now();
      // Start a fresh generator
      this.spawnInProgress.set(key, true);
      this.startGeneratorWithProvider(session, selectedProvider, 'stale-recovery');
      return;
    }

  }

  /**
   * Start the SDK generator for a session.
   */
  private startGeneratorWithProvider(
    session: ReturnType<typeof this.sessionManager.getSession>,
    _provider: 'claude',
    source: string
  ): void {
    if (!session) return;

    // Reset AbortController if it was previously aborted
    // This fixes the bug where a session gets stuck in an infinite "Generator aborted" loop
    // after its AbortController was aborted (e.g., from a previous generator exit)
    if (session.abortController.signal.aborted) {
      logger.debug('SESSION', 'Resetting aborted AbortController before starting generator', {
        sessionId: session.sessionDbId
      });
      session.abortController = new AbortController();
    }

    const agent = this.sdkAgent;
    const agentName = 'Claude SDK';

    // Use database count for accurate telemetry (in-memory array is always empty due to FK constraint fix)
    const pendingStore = this.sessionManager.getPendingMessageStore(session.dbPath);
    const actualQueueDepth = pendingStore.getPendingCount(session.sessionDbId);

    logger.info('SESSION', `Generator auto-starting (${source}) using ${agentName}`, {
      sessionId: session.sessionDbId,
      queueDepth: actualQueueDepth,
      historyLength: session.conversationHistory.length
    });

    // Track which provider is running and mark activity for stale detection (#1099)
    session.currentProvider = 'claude';
    session.lastGeneratorActivity = Date.now();
    // Reset so Layer 1 stale detection uses spawnedAt (Check 4), not stale lastResponseAt (Check 3)
    session.lastResponseAt = null;

    // G1 fix: Start bypass lane consumer for this session (no-op if bypass disabled)
    this.bypassLane?.startForSession(session);

    // Capture the AbortController that belongs to THIS generator run.
    // session.abortController may be replaced (e.g. by stale-recovery) before the
    // .catch handler runs, so binding it here prevents a stale rejection from
    // checking against a brand-new controller (#1590).
    const myController = session.abortController;

    session.generatorPromise = agent.startSession(session, this.workerService)
      .catch(error => {
        // Only log non-abort errors
        if (myController.signal.aborted) return;

        const errorMsg = error instanceof Error ? error.message : String(error);

        // Treat SIGTERM (exit code 143) as intentional termination, not a crash.
        // When the subprocess is killed externally, abort the controller so the
        // .finally's decideGeneratorAction sees wasAborted=true and does NOT respawn (#1590).
        if (errorMsg.includes('code 143') || errorMsg.includes('signal SIGTERM')) {
          logger.warn('SESSION', 'Generator killed by external signal — aborting session to prevent respawn', {
            sessionId: session.sessionDbId,
            error: errorMsg
          });
          myController.abort();
          return;
        }

        session.lastGeneratorError = error instanceof Error ? error : new Error(String(error));

        logger.error('SESSION', `Generator failed`, {
          sessionId: session.sessionDbId,
          provider: 'claude',
          error: errorMsg
        }, error);

        // Retry processing messages (retry_count+1). Known tradeoff: if .finally() also
        // calls markAllSessionMessagesAbandoned (restart limit exceeded), retry_count increments
        // twice for one failure event. Accepted: burns 2 of 3 retries, only at restart limit.
        const pendingStore = this.sessionManager.getPendingMessageStore(session.dbPath);
        try {
          const { retried, failed: failedCount } = pendingStore.markSessionMessagesFailed(session.sessionDbId);
          if (retried + failedCount > 0) {
            logger.error('SESSION', `Marked messages after generator error`, {
              sessionId: session.sessionDbId,
              retried,
              failed: failedCount
            });
          }
        } catch (dbError) {
          logger.error('SESSION', 'Failed to mark messages as failed', {
            sessionId: session.sessionDbId
          }, dbError as Error);
        }

        // Stale-resume detection (symmetric with WorkerService .catch())
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (shouldClearStaleAnchorOnResumeFailure(errorMessage, session.memorySessionId)) {
          logger.warn('SESSION', 'Stale resume detected, forcing fresh init', {
            sessionDbId: session.sessionDbId, staleMemorySessionId: session.memorySessionId,
          });
          try {
            // Guard is true → anchor is a clearable legacy SDK id → helper clears it
            // (DB + memory) and sets forceInit (评审 R2-1: single choke point).
            resetSessionAnchorForFreshStart(this.dbManager.getSessionStore(session.dbPath), session);
          } catch {} // Best-effort DB update — on failure the anchor stays consistent (kept in both DB and memory); forceInit is already set by the helper
        }
      })
      .finally(async () => {
        // CRITICAL: Verify subprocess exit to prevent zombie accumulation (Issue #1168)
        const tracked = getProcessBySession(session.sessionDbId, session.dbPath);
        if (tracked && tracked.process.exitCode === null) {
          await ensureProcessExit(tracked, 5000);
        }

        // F2 fix: Stop bypass consumer on ANY generator exit (mirrors WorkerService pattern)
        this.bypassLane?.stopForSession(session.sessionDbId);

        const sessionDbId = session.sessionDbId;
        const key = this.spawnKey(sessionDbId, session.dbPath);
        this.spawnInProgress.delete(key);
        // Use the CAPTURED controller for the respawn decision, not the live
        // session.abortController. Stale-recovery / proactive-reset can swap
        // session.abortController to a brand-new (un-aborted) controller before
        // this .finally() runs; reading the live one would report wasAborted=false
        // for a generator that WAS intentionally aborted, causing an unwanted
        // respawn (#1590). myController is the AbortController bound to THIS run.
        const wasAborted = myController.signal.aborted;

        if (wasAborted) {
          logger.info('SESSION', `Generator aborted`, { sessionId: sessionDbId });
        } else {
          logger.error('SESSION', `Generator exited unexpectedly`, { sessionId: sessionDbId });
        }

        session.generatorPromise = null;
        session.currentProvider = null;
        this.workerService.broadcastProcessingStatus();

        // Capture error BEFORE any DB access (for db-unreachable detection)
        const lastError = session.lastGeneratorError;
        session.lastGeneratorError = undefined;

        // [P1-1 fix] DB-unreachable pre-check MUST run BEFORE getPendingMessageStore.
        // getPendingMessageStore → getSessionStore → DbConnectionPool.getOrCreate →
        // ensureDir() + new Database() silently recreates a deleted project directory.
        let dbFileExists: boolean | undefined;
        if (isDbIoError(lastError) && session.dbPath) {
          dbFileExists = existsSync(session.dbPath);
        }

        // Only access DB if project is still valid (or no I/O error occurred)
        let pendingCount = 0;
        let pendingObservationCount = 0;
        let pendingStore: any = null;
        if (dbFileExists !== false) {
          pendingStore = this.sessionManager.getPendingMessageStore(session.dbPath);
          pendingCount = pendingStore.getPendingCount(sessionDbId);
          // Security audit C1: decideGeneratorAction's P2b close-window branch
          // requires pendingObservationCount to be a real number. Passing
          // undefined silently disabled the same-turn drain restart path and
          // let queued observations get dropped at session close.
          pendingObservationCount = pendingStore.getPendingObservationCountUpToPrompt(
            sessionDbId,
            session.lastPromptNumber ?? null,
            Date.now(),
          );
        }

        const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
        const maxPoolRetries = parseInt(settings.CLAUDE_MEM_MAX_POOL_RETRIES, 10) || 5;
        const poolCooldownMs = parseInt(settings.CLAUDE_MEM_POOL_COOLDOWN_MS, 10) || 120000;

        // Centralized decision (S3)
        const action = decideGeneratorAction({
          totalLifetimeCrashes: session.totalLifetimeCrashes,
          consecutiveRestarts: session.consecutiveRestarts,
          contextResetCount: session.contextResetCount ?? 0,
          pendingCount,
          pendingObservationCount,
          wasAborted,
          proactiveReset: !!session.proactiveReset,
          isClosing: !!session.closing,
          isIdleTimeout: !!session.idleTimedOut,
          error: lastError,
          dbFileExists,
          poolTimeoutDetected: dbFileExists !== false ? shouldEnterCooldown(lastError, session, maxPoolRetries) : false,
          maxConsecutiveRestarts: SessionRoutes.MAX_CONSECUTIVE_RESTARTS,
          maxContextResets: 3,
          maxLifetimeCrashes: 10,
          maxPoolRetries,
          poolCooldownMs,
        });

        logger.debug('SESSION', `decideGeneratorAction result`, {
          sessionDbId,
          actionType: action.type,
          actionReason: action.type === 'abandon' ? action.reason : undefined,
        });

        // Execute action
        this.executeAction(action, session, pendingStore, settings, pendingCount);
      });
  }

  /**
   * Execute a GeneratorAction — shared handler for centralized decision execution.
   * Called from .finally() after decideGeneratorAction().
   */
  private executeAction(
    action: GeneratorAction,
    session: ActiveSession,
    pendingStore: any,
    settings: any,
    pendingCount: number = 0,
  ): void {
    const sessionDbId = session.sessionDbId;

    switch (action.type) {
      case 'abandon': {
        if (action.reason !== 'db-unreachable') {
          // pendingStore may be null if DB was unreachable but action overridden
          if (pendingStore) {
            try {
              pendingStore.markAllSessionMessagesAbandoned(sessionDbId);
            } catch (e) {
              logger.error('SESSION', 'Failed to abandon messages', { sessionDbId }, e as Error);
            }
          }
          try {
            this.dbManager.getSessionStore(session.dbPath).markSessionFailed(sessionDbId);
            this.sessionManager.removeSessionImmediate(sessionDbId, session.dbPath);
          } catch (e) {
            logger.warn('SESSION', 'Failed to cleanup abandoned session', { sessionDbId }, e as Error);
          }
        } else {
          // db-unreachable: pure memory cleanup — NO DB access
          this.sessionManager.removeSessionMemoryOnly(sessionDbId, session.dbPath);
          if (session.dbPath) {
            try {
              this.dbManager.getPool().evict(session.dbPath);
            } catch {} // Best-effort pool eviction
          }
        }
        this.eventBroadcaster.broadcastSessionCompleted(sessionDbId, session.project);
        this.eventBroadcaster.broadcastAnomaly({
          type: action.reason === 'db-unreachable' ? 'db_unreachable' : 'session_abandoned',
          sessionDbId,
          project: session.project,
          reason: action.reason,
          pendingMessagesLost: pendingCount,
        });
        session.abortController.abort();
        logger.error('SESSION', `Session abandoned: ${action.reason}`, {
          sessionDbId,
          reason: action.reason,
          totalLifetimeCrashes: session.totalLifetimeCrashes,
        });
        break;
      }

      case 'proactive-reset': {
        session.proactiveReset = false; // Clear before any early return to prevent loop
        this.bypassLane?.stopForSession(sessionDbId);
        session.abortController = new AbortController();
        logger.info('SESSION', '[PROACTIVE_RESET] Restarting generator with fresh context', {
          sessionDbId,
          previousHistoryLength: session.conversationHistory.length,
        });
        if (!isProjectStillValid(session.dbPath)) {
          logger.warn('SESSION', 'Project invalid at proactive-reset time, abandoning', { sessionDbId });
          this.sessionManager.removeSessionMemoryOnly(sessionDbId, session.dbPath);
          this.eventBroadcaster.broadcastSessionCompleted(sessionDbId, session.project);
          break;
        }
        this.startGeneratorWithProvider(session, this.getSelectedProvider(), 'proactive-reset');
        break;
      }

      case 'pool-cooldown': {
        session.totalPoolTimeouts++;
        session.poolCooldownUntil = Date.now() + action.cooldownMs;
        logger.warn('SESSION', 'Pool timeout — entering cooldown', {
          sessionDbId,
          totalPoolTimeouts: session.totalPoolTimeouts,
          cooldownMs: action.cooldownMs,
        });
        setTimeout(() => {
          const s = this.sessionManager.getSession(sessionDbId, session.dbPath);
          if (s && s.poolCooldownUntil && Date.now() >= s.poolCooldownUntil) {
            s.poolCooldownUntil = undefined;
            s.consecutiveRestarts = 0;
            if (!isProjectStillValid(s.dbPath)) {
              logger.warn('SESSION', 'Project invalid at cooldown-retry time', { sessionDbId });
              this.sessionManager.removeSessionMemoryOnly(sessionDbId, s.dbPath);
              this.eventBroadcaster.broadcastSessionCompleted(sessionDbId, s.project);
              return;
            }
            this.ensureGeneratorRunning(sessionDbId, 'pool-cooldown-retry', session.dbPath);
          }
        }, action.cooldownMs);
        break;
      }

      case 'crash-recovery': {
        session.consecutiveRestarts = (session.consecutiveRestarts || 0) + 1;
        session.totalLifetimeCrashes++;

        if (session.totalLifetimeCrashes === 5) {
          this.eventBroadcaster.broadcastAnomaly({
            type: 'crash_anomaly',
            sessionDbId,
            project: session.project,
            totalCrashes: session.totalLifetimeCrashes,
            consecutiveCrashes: session.consecutiveRestarts,
          });
        }

        const key = this.spawnKey(sessionDbId, session.dbPath);
        if (this.crashRecoveryScheduled.has(key)) {
          logger.debug('SESSION', 'Crash recovery already scheduled', { sessionDbId });
          return;
        }

        logger.info('SESSION', `Restarting generator after crash`, {
          sessionDbId,
          consecutiveRestarts: session.consecutiveRestarts,
          totalLifetimeCrashes: session.totalLifetimeCrashes,
          backoffMs: action.backoffMs,
        });

        const oldController = session.abortController;
        session.abortController = new AbortController();
        oldController.abort();

        this.crashRecoveryScheduled.add(key);

        setTimeout(() => {
          this.crashRecoveryScheduled.delete(key);
          if (!isProjectStillValid(session.dbPath)) {
            logger.warn('SESSION', 'Project invalid at restart time, abandoning', { sessionDbId });
            this.sessionManager.removeSessionMemoryOnly(sessionDbId, session.dbPath);
            this.eventBroadcaster.broadcastSessionCompleted(sessionDbId, session.project);
            return;
          }
          const stillExists = this.sessionManager.getSession(sessionDbId, session.dbPath);
          if (stillExists && !stillExists.generatorPromise) {
            this.startGeneratorWithProvider(stillExists, this.getSelectedProvider(), 'crash-recovery');
          }
        }, action.backoffMs);
        break;
      }

      case 'idle-cleanup': {
        session.abortController.abort();
        session.consecutiveRestarts = 0;
        logger.debug('SESSION', 'Generator completed naturally, no pending work', { sessionDbId });
        break;
      }

      case 'noop': {
        if (session.idleTimedOut) {
          session.idleTimedOut = false;
          session.lastExitWasIdleTimeout = true;
        }
        break;
      }
    }

    this.workerService.broadcastProcessingStatus();
  }

  setupRoutes(app: express.Application): void {
    // Legacy session endpoints (use sessionDbId)
    app.post('/sessions/:sessionDbId/init', this.handleSessionInit.bind(this));
    app.post('/sessions/:sessionDbId/observations', this.handleObservations.bind(this));
    app.post('/sessions/:sessionDbId/summarize', this.handleSummarize.bind(this));
    app.get('/sessions/:sessionDbId/status', this.handleSessionStatus.bind(this));
    app.delete('/sessions/:sessionDbId', this.handleSessionDelete.bind(this));
    app.post('/sessions/:sessionDbId/complete', this.handleSessionComplete.bind(this));

    // New session endpoints (use contentSessionId)
    app.post('/api/sessions/init', this.handleSessionInitByClaudeId.bind(this));
    app.post('/api/sessions/observations', this.handleObservationsByClaudeId.bind(this));
    app.post('/api/sessions/summarize', this.handleSummarizeByClaudeId.bind(this));
    app.post('/api/sessions/complete', this.handleCompleteByClaudeId.bind(this));

    // Hook-side prompt_number resolution — Stop hook queries this before
    // POSTing summarize so the turn key is authoritative at enqueue time.
    app.get('/api/sessions/resolve-prompt-number', this.handleResolvePromptNumber.bind(this));
  }

  /**
   * Initialize a new session
   */
  private handleSessionInit = this.wrapHandler((req: Request, res: Response): void => {
    const sessionDbId = this.parseIntParam(req, res, 'sessionDbId');
    if (sessionDbId === null) return;

    const { userPrompt, promptNumber, dbPath } = req.body;
    logger.info('HTTP', 'SessionRoutes: handleSessionInit called', {
      sessionDbId,
      promptNumber,
      has_userPrompt: !!userPrompt
    });

    const session = this.sessionManager.initializeSession(sessionDbId, userPrompt, promptNumber, dbPath);

    // Get the latest user_prompt for this session to sync to Chroma
    const latestPrompt = this.dbManager.getSessionStore(dbPath).getLatestUserPrompt(session.contentSessionId);

    // Broadcast new prompt to SSE clients (for web UI)
    if (latestPrompt) {
      this.eventBroadcaster.broadcastNewPrompt({
        id: latestPrompt.id,
        content_session_id: latestPrompt.content_session_id,
        project: latestPrompt.project,
        prompt_number: latestPrompt.prompt_number,
        prompt_text: latestPrompt.prompt_text,
        created_at_epoch: latestPrompt.created_at_epoch
      });

      // Sync user prompt to Chroma (null when Chroma is disabled)
      const chromaSync = this.dbManager.getChromaSync(dbPath);
      const promptText = latestPrompt.prompt_text;
      if (chromaSync) {
        const chromaStart = Date.now();
        chromaSync.syncUserPrompt(
          latestPrompt.id,
          latestPrompt.memory_session_id,
          latestPrompt.project,
          promptText,
          latestPrompt.prompt_number,
          latestPrompt.created_at_epoch
        ).then(() => {
          const chromaDuration = Date.now() - chromaStart;
          const truncatedPrompt = promptText.length > 60
            ? promptText.substring(0, 60) + '...'
            : promptText;
          logger.debug('CHROMA', 'User prompt synced', {
            promptId: latestPrompt.id,
            duration: `${chromaDuration}ms`,
            prompt: truncatedPrompt
          });
        }).catch((error) => {
          logger.error('CHROMA', 'User prompt sync failed, continuing without vector search', {
            promptId: latestPrompt.id,
            prompt: promptText.length > 60 ? promptText.substring(0, 60) + '...' : promptText
          }, error);
        });
      }
    }

    // Idempotent: ensure generator is running (matches handleObservations / handleSummarize)
    this.ensureGeneratorRunning(sessionDbId, 'init', dbPath);

    // Broadcast session started event
    this.eventBroadcaster.broadcastSessionStarted(sessionDbId, session.project);

    res.json({ status: 'initialized', sessionDbId, port: getWorkerPort() });
  });

  /**
   * Queue observations for processing
   * CRITICAL: Ensures SDK agent is running to process the queue (ALWAYS SAVE EVERYTHING)
   */
  private handleObservations = this.wrapHandler((req: Request, res: Response): void => {
    const sessionDbId = this.parseIntParam(req, res, 'sessionDbId');
    if (sessionDbId === null) return;

    const { tool_name, tool_input, tool_response, prompt_number, cwd, dbPath } = req.body;

    const enqueued = this.sessionManager.queueObservation(sessionDbId, {
      tool_name,
      tool_input,
      tool_response,
      prompt_number,
      cwd
    }, dbPath);

    if (!enqueued) {
      res.json({ status: 'skipped', reason: 'backpressure' });
      return;
    }

    // CRITICAL: Ensure SDK agent is running to consume the queue
    this.ensureGeneratorRunning(sessionDbId, 'observation', dbPath);

    // Broadcast observation queued event
    this.eventBroadcaster.broadcastObservationQueued(sessionDbId);

    res.json({ status: 'queued' });
  });

  /**
   * Queue summarize request
   * CRITICAL: Ensures SDK agent is running to process the queue (ALWAYS SAVE EVERYTHING)
   */
  private handleSummarize = this.wrapHandler((req: Request, res: Response): void => {
    const sessionDbId = this.parseIntParam(req, res, 'sessionDbId');
    if (sessionDbId === null) return;

    const { last_assistant_message, prompt_number, dbPath } = req.body;
    let resolvedPromptNumber: number | null = null;
    if (typeof prompt_number === 'number' && Number.isFinite(prompt_number)) {
      resolvedPromptNumber = prompt_number;
    } else {
      try {
        const session = this.sessionManager.getSession(sessionDbId, dbPath);
        if (session?.contentSessionId) {
          const store = this.dbManager.getSessionStore(dbPath);
          // Attribute summarize to the latest real user prompt — skip redacted placeholders.
          const pn = store.getLatestRealPromptNumber(session.contentSessionId);
          resolvedPromptNumber = pn > 0 ? pn : null;
        }
      } catch {
        // Best-effort resolution; falls through to 400 if still null.
      }
    }
    if (resolvedPromptNumber === null) {
      res.status(400).json({ error: 'prompt_number missing and unresolvable for session' });
      return;
    }

    const queuedAtEpoch = Date.now();
    const result = this.sessionManager.queueSummarize(
      sessionDbId,
      { lastAssistantMessage: last_assistant_message, promptNumber: resolvedPromptNumber, queuedAtEpoch },
      dbPath,
    );

    // Observation-drain wake-up: SummaryLane handles the summary itself, but
    // the observer still needs to drain same-turn observations before
    // SummaryLane processes the summary (spec §4.2). Start generator only when
    // observations remain.
    try {
      const pendingStore = this.sessionManager.getPendingMessageStore(dbPath);
      const pendingObs = pendingStore.getPendingObservationCountUpToPrompt(
        sessionDbId,
        resolvedPromptNumber,
        queuedAtEpoch,
      );
      if (pendingObs > 0) {
        this.ensureGeneratorRunning(sessionDbId, 'summary-observation-drain', dbPath);
      }
    } catch {
      // Best-effort; SummaryLane still owns the summarize row.
    }

    // Broadcast only when a NEW summarize row was persisted. Deduped turns
    // must not emit phantom queued state to the viewer or API callers.
    if (result.status === 'queued') {
      this.eventBroadcaster.broadcastSummarizeQueued();
    }

    res.json({ status: result.status });
  });

  /**
   * Get session status
   */
  private handleSessionStatus = this.wrapHandler((req: Request, res: Response): void => {
    const sessionDbId = this.parseIntParam(req, res, 'sessionDbId');
    if (sessionDbId === null) return;

    const dbPath = req.body?.dbPath;
    const session = this.sessionManager.getSession(sessionDbId, dbPath);

    if (!session) {
      res.json({ status: 'not_found' });
      return;
    }

    // Use database count for accurate queue length (in-memory array is always empty due to FK constraint fix)
    const pendingStore = this.sessionManager.getPendingMessageStore(session.dbPath);
    const queueLength = pendingStore.getPendingCount(sessionDbId);

    res.json({
      status: 'active',
      sessionDbId,
      project: session.project,
      queueLength,
      uptime: Date.now() - session.startTime
    });
  });

  /**
   * Delete a session
   */
  private handleSessionDelete = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const sessionDbId = this.parseIntParam(req, res, 'sessionDbId');
    if (sessionDbId === null) return;

    const dbPath = req.body?.dbPath;
    const project = this.sessionManager.getSession(sessionDbId, dbPath)?.project;
    // Admin DELETE → immediate close + finalize. Post-SummaryLane, pending
    // summarize rows persist; SummaryLane still consumes them against the
    // now-completed session row.
    await this.completionHandler.deleteByDbId(sessionDbId, dbPath, project);

    res.json({ status: 'deleted' });
  });

  /**
   * Complete a session (backward compatibility for cleanup-hook)
   * cleanup-hook expects POST /sessions/:sessionDbId/complete instead of DELETE
   */
  private handleSessionComplete = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const sessionDbId = this.parseIntParam(req, res, 'sessionDbId');
    if (sessionDbId === null) return;

    const dbPath = req.body?.dbPath;
    const project = this.sessionManager.getSession(sessionDbId, dbPath)?.project;
    await this.completionHandler.completeByDbId(sessionDbId, dbPath, project);

    res.json({ success: true });
  });

  /**
   * Queue observations by contentSessionId (post-tool-use-hook uses this)
   * POST /api/sessions/observations
   * Body: { contentSessionId, tool_name, tool_input, tool_response, cwd }
   */
  private handleObservationsByClaudeId = this.wrapHandler((req: Request, res: Response): void => {
    const { contentSessionId, tool_name, tool_input, tool_response, cwd, dbPath } = req.body;

    if (!contentSessionId) {
      return this.badRequest(res, 'Missing contentSessionId');
    }

    // Load skip tools from settings
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const skipTools = new Set(settings.CLAUDE_MEM_SKIP_TOOLS.split(',').map(t => t.trim()).filter(Boolean));

    // Skip low-value or meta tools
    if (skipTools.has(tool_name)) {
      layerAStats.toolExcluded++;
      logger.debug('SESSION', 'Skipping observation for tool', { tool_name });
      res.json({ status: 'skipped', reason: 'tool_excluded' });
      return;
    }

    // Phase 1: SKIP_TOOLS runs first (exact-match), then SKIP_TOOL_PATTERNS (path-aware)
    const patternKey = settings.CLAUDE_MEM_SKIP_TOOL_PATTERNS || '';
    if (!cachedPatterns || cachedPatterns.key !== patternKey) {
      cachedPatterns = { key: patternKey, patterns: parseSkipPatterns(patternKey) };
    }
    if (shouldSkipObservation(tool_name, tool_input, cachedPatterns.patterns)) {
      layerAStats.patternFiltered++;
      logger.info('SESSION', 'Skipping observation by pattern filter', { tool_name, reason: 'pattern_filtered' });
      res.json({ status: 'skipped', reason: 'pattern_filtered' });
      return;
    }

    // Skip meta-observations: file operations on session-memory files
    const fileOperationTools = new Set(['Edit', 'Write', 'Read', 'NotebookEdit']);
    if (fileOperationTools.has(tool_name) && tool_input) {
      const filePath = tool_input.file_path || tool_input.notebook_path;
      if (filePath && filePath.includes('session-memory')) {
        logger.debug('SESSION', 'Skipping meta-observation for session-memory file', {
          tool_name,
          file_path: filePath
        });
        res.json({ status: 'skipped', reason: 'session_memory_meta' });
        return;
      }
    }

    const store = this.dbManager.getSessionStore(dbPath);

    // Get or create session — name the session from the DB it is being written into
    // (the allowlist-routed dbPath), NOT from live cwd. This path is the session's
    // creator whenever UserPromptSubmit never fires (worker restart, race, or a
    // session that only ever emits PostToolUse). Deriving from cwd via getProjectName()
    // uses resolveWorkspaceRoot, a second resolver that climbs to a parent workspace
    // when the parent holds a `.claude/` and is not a git repo — diverging from the
    // allowlist-routed dbPath and leaking a phantom parent-named project (e.g.
    // "wangjiazhe") into a child project's DB. dbPath-derived name can never diverge
    // from the DB. Fall back to cwd only for the global/legacy DB (no project root).
    const project = projectNameFromDbPath(dbPath) ?? (cwd ? getProjectName(cwd) : '');
    const sessionDbId = store.createSDKSession(contentSessionId, project, '');
    // Attribute observation to the latest REAL user prompt. Redacted placeholders
    // (system notifications, Monitor noise) advance the global counter but their
    // prompt_number must not steal credit for tool-use that belongs to the
    // preceding real turn — they were never the user's intent.
    const promptNumber = store.getLatestRealPromptNumber(contentSessionId);

    // Privacy check: skip if user prompt was entirely private
    const userPrompt = PrivacyCheckValidator.checkUserPromptPrivacy(
      store,
      contentSessionId,
      promptNumber,
      'observation',
      sessionDbId,
      { tool_name }
    );
    if (!userPrompt) {
      res.json({ status: 'skipped', reason: 'private' });
      return;
    }

    // Safely serialize and strip memory tags from tool fields
    const cleanedToolInput = cleanToolField(tool_input);
    const cleanedToolResponse = cleanToolField(tool_response);

    // Queue observation
    const enqueued = this.sessionManager.queueObservation(sessionDbId, {
      tool_name,
      tool_input: cleanedToolInput,
      tool_response: cleanedToolResponse,
      prompt_number: promptNumber,
      cwd: cwd || (() => {
        logger.error('SESSION', 'Missing cwd when queueing observation in SessionRoutes', {
          sessionId: sessionDbId,
          tool_name
        });
        return '';
      })()
    }, dbPath);

    if (!enqueued) {
      res.json({ status: 'skipped', reason: 'backpressure' });
      return;
    }

    // Ensure SDK agent is running
    this.ensureGeneratorRunning(sessionDbId, 'observation', dbPath);

    // Broadcast observation queued event
    this.eventBroadcaster.broadcastObservationQueued(sessionDbId);

    res.json({ status: 'queued' });
  });

  /**
   * Queue summarize by contentSessionId (summary-hook uses this)
   * POST /api/sessions/summarize
   * Body: { contentSessionId, last_assistant_message }
   *
   * Checks privacy, queues summarize request for SDK agent
   */
  private handleSummarizeByClaudeId = this.wrapHandler((req: Request, res: Response): void => {
    const { contentSessionId, last_assistant_message, prompt_number, dbPath } = req.body;

    if (!contentSessionId) {
      return this.badRequest(res, 'Missing contentSessionId');
    }

    const store = this.dbManager.getSessionStore(dbPath);
    const sessionDbId = store.createSDKSession(contentSessionId, '', '');

    // Accept an explicit prompt_number from the hook when available; fall back
    // to the latest user_prompts row for this contentSessionId. The hook may
    // pass prompt_number when it knows the exact turn being summarized; when
    // unavailable (or stale client), resolve server-side so a transient hook
    // miss does not force fallback-queue replay.
    let resolvedPromptNumber: number;
    if (typeof prompt_number === 'number' && Number.isFinite(prompt_number)) {
      resolvedPromptNumber = prompt_number;
    } else {
      // Attribute summarize to the latest real user prompt — skip redacted placeholders.
      resolvedPromptNumber = store.getLatestRealPromptNumber(contentSessionId);
    }

    // Use the resolved prompt_number as the privacy anchor for THIS turn.
    const userPrompt = PrivacyCheckValidator.checkUserPromptPrivacy(
      store,
      contentSessionId,
      resolvedPromptNumber,
      'summarize',
      sessionDbId,
    );
    if (!userPrompt) {
      res.json({ status: 'skipped', reason: 'private' });
      return;
    }

    const queuedAtEpoch = Date.now();
    const result = this.sessionManager.queueSummarize(
      sessionDbId,
      {
        lastAssistantMessage: last_assistant_message,
        promptNumber: resolvedPromptNumber,
        queuedAtEpoch,
      },
      dbPath,
    );

    // Wake observer only when same-turn observations remain to drain; never
    // start the generator as a "summarize owner" — SummaryLane is the sole
    // owner of the summarize row.
    try {
      const pendingStore = this.sessionManager.getPendingMessageStore(dbPath);
      const pendingObs = pendingStore.getPendingObservationCountUpToPrompt(
        sessionDbId,
        resolvedPromptNumber,
        queuedAtEpoch,
      );
      if (pendingObs > 0) {
        this.ensureGeneratorRunning(sessionDbId, 'summary-observation-drain', dbPath);
      }
    } catch {
      // Best-effort; SummaryLane still owns the summarize row.
    }

    if (result.status === 'queued') {
      this.eventBroadcaster.broadcastSummarizeQueued();
    }

    res.json(result);
  });

  /**
   * Resolve the current `prompt_number` for a content session.
   * GET /api/sessions/resolve-prompt-number?contentSessionId=...&dbPath=...
   *
   * Hook-side pre-resolution: Stop hook calls this before POSTing summarize
   * so the turn key is authoritative at enqueue time, independent of whatever
   * the worker's server-side fallback would compute. If no prompt is recorded
   * yet, returns 404 — the hook should then write a fallback entry without
   * prompt_number and let replay resolve at that time.
   */
  private handleResolvePromptNumber = this.wrapHandler((req: Request, res: Response): void => {
    const contentSessionId = typeof req.query.contentSessionId === 'string'
      ? req.query.contentSessionId
      : undefined;
    const dbPath = typeof req.query.dbPath === 'string' ? req.query.dbPath : undefined;

    if (!contentSessionId) {
      res.status(400).json({ error: 'contentSessionId query param required' });
      return;
    }

    const store = this.dbManager.getSessionStore(dbPath);
    // Hook callers (Stop hook → summarize POST) need the turn key of the latest
    // REAL user prompt — never a redacted placeholder, otherwise the summary is
    // attributed to a synthetic noise event instead of the user's actual ask.
    const promptNumber = store.getLatestRealPromptNumber(contentSessionId);
    if (typeof promptNumber !== 'number' || promptNumber <= 0) {
      res.status(404).json({ error: 'No prompt recorded for contentSessionId yet' });
      return;
    }
    res.json({ prompt_number: promptNumber });
  });

  /**
   * Complete session by contentSessionId (session-complete hook uses this)
   * POST /api/sessions/complete
   * Body: { contentSessionId }
   *
   * Removes session from active sessions map, allowing orphan reaper to
   * clean up any remaining subprocesses.
   *
   * Fixes Issue #842: Sessions stay in map forever, reaper thinks all active.
   */
  private handleCompleteByClaudeId = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { contentSessionId, dbPath } = req.body;

    logger.info('HTTP', '→ POST /api/sessions/complete', { contentSessionId });

    if (!contentSessionId) {
      return this.badRequest(res, 'Missing contentSessionId');
    }

    const store = this.dbManager.getSessionStore(dbPath);

    // Look up sessionDbId from contentSessionId (createSDKSession is idempotent)
    // Pass empty strings - we only need the ID lookup, not to create a new session
    const sessionDbId = store.createSDKSession(contentSessionId, '', '');

    // Check if session is in the active sessions map
    const activeSession = this.sessionManager.getSession(sessionDbId, dbPath);
    if (!activeSession) {
      // Session may not be in memory (already completed or never initialized)
      logger.debug('SESSION', 'session-complete: Session not in active map', {
        contentSessionId,
        sessionDbId
      });
      res.json({ status: 'skipped', reason: 'not_active' });
      return;
    }

    // Complete the session (removes from active sessions map)
    await this.completionHandler.completeByDbId(sessionDbId, dbPath, activeSession.project);

    logger.info('SESSION', 'Session completed via API', {
      contentSessionId,
      sessionDbId
    });

    res.json({ status: 'completed', sessionDbId });
  });

  /**
   * Initialize session by contentSessionId (new-hook uses this)
   * POST /api/sessions/init
   * Body: { contentSessionId, project, prompt }
   *
   * Performs all session initialization DB operations:
   * - Creates/gets SDK session (idempotent)
   * - Increments prompt counter
   * - Saves user prompt (with privacy tag stripping)
   *
   * Returns: { sessionDbId, promptNumber, skipped: boolean, reason?: string }
   */
  private handleSessionInitByClaudeId = this.wrapHandler((req: Request, res: Response): void => {
    const { contentSessionId, dbPath } = req.body;

    // Only contentSessionId is truly required — Cursor and other platforms
    // may omit prompt/project in their payload (#838, #1049)
    const project = req.body.project || 'unknown';
    const prompt = req.body.prompt || '[media prompt]';
    const customTitle = req.body.customTitle || undefined;

    logger.info('HTTP', 'SessionRoutes: handleSessionInitByClaudeId called', {
      contentSessionId,
      project,
      prompt_length: prompt?.length,
      customTitle
    });

    // Validate required parameters
    if (!this.validateRequired(req, res, ['contentSessionId'])) {
      return;
    }

    const store = this.dbManager.getSessionStore(dbPath);

    // Step 1: Create/get SDK session (idempotent INSERT OR IGNORE)
    const sessionDbId = store.createSDKSession(contentSessionId, project, prompt, customTitle);

    // Verify session creation with DB lookup
    const dbSession = store.getSessionById(sessionDbId);
    const isNewSession = !dbSession?.memory_session_id;
    logger.info('SESSION', `CREATED | contentSessionId=${contentSessionId} → sessionDbId=${sessionDbId} | isNew=${isNewSession} | project=${project}`, {
      sessionId: sessionDbId
    });

    // Step 2: Get next prompt number from user_prompts count
    const currentCount = store.getPromptNumberFromUserPrompts(contentSessionId);
    const promptNumber = currentCount + 1;

    // Debug-level alignment logs for detailed tracing
    const memorySessionId = dbSession?.memory_session_id || null;
    if (promptNumber > 1) {
      logger.debug('HTTP', `[ALIGNMENT] DB Lookup Proof | contentSessionId=${contentSessionId} → memorySessionId=${memorySessionId || '(not yet captured)'} | prompt#=${promptNumber}`);
    } else {
      logger.debug('HTTP', `[ALIGNMENT] New Session | contentSessionId=${contentSessionId} | prompt#=${promptNumber} | memorySessionId will be captured on first SDK response`);
    }

    // Step 3: Strip privacy tags + detect intentional redaction.
    // We persist the prompt row in all cases below (Step 5) so that prompt
    // numbering stays monotonic in `user_prompts` even when a turn is fully
    // redacted/noise — otherwise `getPromptNumberFromUserPrompts()` returns
    // a stale count and subsequent turns get the wrong promptNumber, causing
    // a session-wide skip-loop (issue surfaced 2026-05-20).
    const stripResult = stripMemoryTagsFromPromptDetailed(prompt);
    const cleanedPrompt = stripResult.stripped;

    // Step 4: Fully redacted (some recognized tag wrapped the whole prompt).
    // Persist the empty row with is_redacted=1 so PrivacyCheckValidator can
    // skip downstream work without confusing this with race-condition empties.
    if (stripResult.wasRedacted) {
      logger.debug('HOOK', 'Session init - prompt fully redacted', {
        sessionId: sessionDbId,
        promptNumber,
        originalLength: prompt.length,
        redactionReason: stripResult.redactionReason
      });

      store.saveUserPrompt(contentSessionId, promptNumber, '', true);

      res.json({
        sessionDbId,
        promptNumber,
        skipped: true,
        reason: 'redacted',
        redactionReason: stripResult.redactionReason
      });
      return;
    }

    // Step 4b: Skip system-injected noise prompts
    // - Monitor event / Monitor permission denied: platform task notifications
    // - <Role_Definition>: skill system prompts echoed back as user input
    // Persist with is_redacted=1 so PrivacyCheckValidator skips downstream work
    // AND so the prompt counter advances (preventing the stale-promptNumber loop).
    if (
      cleanedPrompt.includes('Monitor event') ||
      cleanedPrompt.includes('Permission to use Monitor has been denied') ||
      cleanedPrompt.startsWith('<Role_Definition>')
    ) {
      logger.debug('HOOK', 'Session init - skipping system noise prompt', {
        sessionId: sessionDbId,
        promptNumber,
        reason: cleanedPrompt.startsWith('<Role_Definition>') ? 'skill_system_prompt' : 'monitor_noise'
      });

      store.saveUserPrompt(contentSessionId, promptNumber, cleanedPrompt, true);

      res.json({
        sessionDbId,
        promptNumber,
        skipped: true,
        reason: 'system_noise'
      });
      return;
    }

    // Step 5: Save cleaned user prompt
    store.saveUserPrompt(contentSessionId, promptNumber, cleanedPrompt);

    // Broadcast new prompt to SSE clients (for web UI)
    const latestPrompt = store.getLatestUserPrompt(contentSessionId);
    if (latestPrompt) {
      this.eventBroadcaster.broadcastNewPrompt({
        id: latestPrompt.id,
        content_session_id: latestPrompt.content_session_id,
        project: latestPrompt.project,
        prompt_number: latestPrompt.prompt_number,
        prompt_text: latestPrompt.prompt_text,
        created_at_epoch: latestPrompt.created_at_epoch
      });
    }

    // Step 6: Check if SDK agent is already running for this session (#1079)
    // If contextInjected is true, the hook should skip re-initializing the SDK agent
    const contextInjected = this.sessionManager.getSession(sessionDbId, dbPath) !== undefined;

    // Broadcast session started for truly new sessions (enables real-time viewer updates)
    // Use !contextInjected (session not in active map) instead of isNewSession
    // because memory_session_id may still be NULL on subsequent prompts before SDK responds
    if (!contextInjected) {
      this.eventBroadcaster.broadcastSessionStarted(sessionDbId, project);
    }

    // Debug-level log since CREATED already logged the key info
    logger.debug('SESSION', 'User prompt saved', {
      sessionId: sessionDbId,
      promptNumber,
      contextInjected
    });

    res.json({
      sessionDbId,
      promptNumber,
      skipped: false,
      contextInjected
    });
  });
}
