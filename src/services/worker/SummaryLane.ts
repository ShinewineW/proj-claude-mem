/**
 * SummaryLane — global single consumer for pending_messages.summarize rows.
 *
 * Architecture: 3-consumer split over the shared pending_messages queue.
 * Observer (main SDK, observation-only) + BypassLane (REST, observation-only)
 * + SummaryLane (global single consumer, fresh SDK subprocess, summarize-only).
 *
 * Lifecycle: idle → claim FIFO → drain observations → fresh SDK query →
 * atomic store (turn-key dedup) → re-read persisted row → Chroma sync +
 * cursor context + SSE broadcast → confirmProcessed. Retry/dead-letter
 * handled by the consume loop.
 */

import type { SessionManager } from './SessionManager.js';
import type { DatabaseManager } from './DatabaseManager.js';
import type { PersistentPendingMessage } from '../sqlite/PendingMessageStore.js';
import type { SummarySSEPayload } from './agents/types.js';
import { SummaryLaneTelemetry } from './SummaryLaneTelemetry.js';
import { logger } from '../../utils/logger.js';
import { isProjectStillValid } from './generator-action.js';
import { DB_PATH } from '../../shared/paths.js';
import { OBSERVER_SESSIONS_DIR, ensureDir, USER_SETTINGS_PATH } from '../../shared/paths.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { buildIsolatedEnv } from '../../shared/EnvManager.js';
import { buildFreshSummarizeDeps } from './fresh-summarize-deps.js';
import { runFreshSummarizeQuery } from './fresh-summarize.js';
import { storeFreshSummaryForSession, type StoreFreshSummaryResult } from './fresh-summarize-store.js';
import { findClaudeExecutable } from './claude-exec.js';
import { createPidCapturingSpawn } from './ProcessRegistry.js';
import { ModeManager } from '../domain/ModeManager.js';
import { getWorkerPort } from '../../shared/worker-utils.js';
import { updateCursorContextForProject } from '../integrations/CursorHooksInstaller.js';

type SummaryLaneState = 'DISABLED' | 'ACTIVE' | 'STOPPED';

export interface SummaryLaneStatus {
  state: SummaryLaneState;
  counters: ReturnType<SummaryLaneTelemetry['getCounters']>;
}

/**
 * Max time to wait for pending observation rows (up to the summarize turn)
 * to be processed. After this, we proceed with summarize using whatever
 * observations have been stored — same "accept loss on timeout" policy the
 * earlier drain window used. Surfaced as telemetry `drainTimedOut`.
 */
const DRAIN_TIMEOUT_MS = 30_000;
const DRAIN_POLL_MS = 500;

/**
 * Tools the fresh summarize query must never invoke. Identical to
 * SDKAgent.startSession — observer identity (read-only, no tool use) is the
 * same invariant on both paths.
 */
const SUMMARIZE_DISALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'Task',
  'NotebookEdit',
  'AskUserQuestion',
  'TodoWrite',
];

export class SummaryLane {
  private sessionManager: SessionManager | null = null;
  private dbManager: DatabaseManager | null = null;
  private dbPathsProvider: (() => Set<string>) | null = null;
  private onBroadcastSummary: ((payload: SummarySSEPayload) => void) | null = null;
  private onBroadcastProcessingStatus: (() => void) | null = null;

  private telemetry: SummaryLaneTelemetry;
  private abortController: AbortController | null = null;
  private state: SummaryLaneState = 'DISABLED';
  private consumerPromise: Promise<void> | null = null;

  constructor() {
    this.telemetry = new SummaryLaneTelemetry();
  }

  setSessionManager(sm: SessionManager): void { this.sessionManager = sm; }
  setDbManager(dm: DatabaseManager): void { this.dbManager = dm; }
  setDbPathsProvider(fn: () => Set<string>): void { this.dbPathsProvider = fn; }
  setBroadcastSummary(fn: (payload: SummarySSEPayload) => void): void { this.onBroadcastSummary = fn; }
  setBroadcastProcessingStatus(fn: () => void): void { this.onBroadcastProcessingStatus = fn; }

  getStatus(): SummaryLaneStatus {
    return { state: this.state, counters: this.telemetry.getCounters() };
  }

  /**
   * Begin consuming. MUST be called only after ModeManager.loadMode() finishes
   * AND observation-only recovery kickoff has completed.
   */
  start(): void {
    if (this.state === 'ACTIVE') return;
    if (
      !this.sessionManager || !this.dbManager || !this.dbPathsProvider ||
      !this.onBroadcastSummary || !this.onBroadcastProcessingStatus
    ) {
      throw new Error(
        'SummaryLane not wired — missing one of: sessionManager, dbManager, dbPathsProvider, ' +
        'broadcastSummary, broadcastProcessingStatus',
      );
    }
    this.state = 'ACTIVE';
    this.abortController = new AbortController();
    this.telemetry.startHourlyFlush();
    this.consumerPromise = this.consumeLoop(this.abortController.signal)
      .catch((err) => logger.error('SUMLANE', 'Consumer crashed', {}, err as Error))
      .finally(() => { this.state = 'STOPPED'; });
  }

  async stop(): Promise<void> {
    if (this.state !== 'ACTIVE') {
      this.state = 'STOPPED';
      return;
    }
    this.abortController?.abort();
    this.telemetry.stop();
    await this.consumerPromise;
  }

  private async consumeLoop(signal: AbortSignal): Promise<void> {
    const POLL_MS = 2000;

    while (!signal.aborted && this.state === 'ACTIVE') {
      try {
        const allDbPaths = this.dbPathsProvider!();
        let claimedAny = false;

        for (const dbPath of allDbPaths) {
          if (signal.aborted) break;
          if (dbPath !== DB_PATH && !isProjectStillValid(dbPath)) {
            continue;
          }
          const pendingStore = this.sessionManager!.getPendingMessageStore(dbPath);
          const message = pendingStore.claimNextSummarize();
          if (!message) continue;

          claimedAny = true;
          this.telemetry.recordClaimed(message.id, message.created_at_epoch);

          try {
            await this.processSummarize(message, dbPath, signal);
            this.telemetry.recordProcessed(message.id);
          } catch (err) {
            if (signal.aborted) break;
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.warn('SUMLANE', 'Processing failed, marking for retry', {
              messageId: message.id,
              sessionDbId: message.session_db_id,
              error: errMsg,
            });
            const result = pendingStore.markFailed(message.id);
            this.telemetry.recordFailed(message.id);
            if (result.finalStatus === 'pending') {
              this.telemetry.recordRetried(message.id, result.retryCount);
              await this.abortableSleep(2000, signal);
            } else {
              this.telemetry.recordDeadLetter(message.id);
              logger.error('SUMLANE', 'Summary dead-lettered after 3 retries — silently dropped', {
                sessionDbId: message.session_db_id,
                messageId: message.id,
                lastError: errMsg,
              });
            }
          }
        }

        if (!claimedAny) {
          await this.abortableSleep(POLL_MS, signal);
        }
      } catch (err) {
        if (signal.aborted) return;
        logger.error('SUMLANE', 'Consumer loop error (continuing)', {}, err as Error);
        await this.abortableSleep(1000, signal);
      }
    }
  }

  /**
   * Process one claimed summarize message end-to-end.
   *
   * Drives all downstream effects from the persisted row (re-read after
   * storeFreshSummaryForSession), not from the LLM output — LLM outputs are
   * non-deterministic, the DB row is canonical. Chroma sync and cursor
   * context update are fire-and-forget (via Promise.allSettled) so one
   * downstream failure doesn't strand the pending_messages row.
   */
  private async processSummarize(
    message: PersistentPendingMessage,
    dbPath: string,
    signal: AbortSignal,
  ): Promise<void> {
    const processingStartedAt = Date.now();
    const sessionStore = this.dbManager!.getSessionStore(dbPath);
    const pendingStore = this.sessionManager!.getPendingMessageStore(dbPath);
    const sessionDbId = message.session_db_id;

    // -----------------------------------------------------------------
    // 1. Resolve session row. A missing row (or missing memory_session_id)
    //    means we cannot summarize: skip idempotently.
    // -----------------------------------------------------------------
    const sessionRow = sessionStore.getSessionById(sessionDbId);
    if (!sessionRow || !sessionRow.memory_session_id) {
      logger.info('SUMLANE', 'Skip: session row or memory_session_id missing', {
        sessionDbId, messageId: message.id,
      });
      pendingStore.confirmProcessed(message.id);
      this.onBroadcastProcessingStatus!();
      this.telemetry.recordSkipped(message.id);
      return;
    }

    // -----------------------------------------------------------------
    // 2. Drain observations up to this turn. Ensures the fresh query sees
    //    every observation that should belong to the summary. After timeout
    //    we proceed anyway — loss of the tail is preferable to stranding.
    // -----------------------------------------------------------------
    const promptNumber = message.prompt_number;
    const queuedAtEpoch = message.created_at_epoch;
    const drainStart = Date.now();
    let drainTimedOut = false;
    // If promptNumber is null we can still drain via created_at_epoch cutoff
    // (same NULL-tolerant semantics the counting method has).
    while (!signal.aborted) {
      const remaining = pendingStore.getPendingObservationCountUpToPrompt(
        sessionDbId,
        promptNumber,
        queuedAtEpoch,
      );
      if (remaining === 0) break;
      if (Date.now() - drainStart > DRAIN_TIMEOUT_MS) {
        drainTimedOut = true;
        logger.warn('SUMLANE', 'Observation drain timed out', {
          sessionDbId, messageId: message.id, remaining, drainMs: DRAIN_TIMEOUT_MS,
        });
        break;
      }
      await this.abortableSleep(DRAIN_POLL_MS, signal);
    }
    const drainElapsed = Date.now() - drainStart;
    this.telemetry.recordObservationDrain(drainElapsed);
    if (signal.aborted) {
      // Abort during drain — leave the message claimed for another lane run
      // after restart (stale claim self-heal in claimNextSummarize).
      return;
    }

    // -----------------------------------------------------------------
    // 3. Resolve per-turn userPrompt. Prefer the exact-turn row in
    //    user_prompts; fall back to the session-metadata prompt stored in
    //    sdk_sessions.user_prompt (legacy, pre-migration rows). Never pass
    //    an undefined — buildFreshSummaryPrompt expects a string.
    // -----------------------------------------------------------------
    let userPrompt = sessionRow.user_prompt ?? '';
    if (
      sessionRow.content_session_id &&
      typeof promptNumber === 'number' &&
      promptNumber !== null
    ) {
      const row = sessionStore.getUserPromptByContentSessionAndPromptNumber(
        sessionRow.content_session_id,
        promptNumber,
      );
      if (row) userPrompt = row.prompt_text;
    }

    // -----------------------------------------------------------------
    // 4. Build deps + run fresh SDK query. Non-success statuses throw so
    //    the consume loop's markFailed/retry path fires.
    // -----------------------------------------------------------------
    const mode = ModeManager.getInstance().getActiveMode();
    const deps = this.buildDeps({
      sessionStore,
      contentSessionId: sessionRow.content_session_id,
      promptNumber: promptNumber ?? 0,
      queuedAtEpoch,
      sessionDbId,
      dbPath,
      signal,
    });

    const result = await runFreshSummarizeQuery(deps, {
      memorySessionId: sessionRow.memory_session_id,
      userPrompt,
      lastAssistantMessage: message.last_assistant_message ?? undefined,
      mode,
    });

    if (result.status !== 'success' || !result.summary) {
      throw new Error(
        `Fresh summarize non-success: status=${result.status} obsCount=${result.obsCount} durationMs=${result.durationMs}`,
      );
    }

    const summaryPayload = {
      request: result.summary.request ?? '',
      investigated: result.summary.investigated ?? '',
      learned: result.summary.learned ?? '',
      completed: result.summary.completed ?? '',
      next_steps: result.summary.next_steps ?? '',
      notes: result.summary.notes,
    };

    // -----------------------------------------------------------------
    // 5. Atomic store. Turn-key dedup inside the helper may return an
    //    existing row as 'returned_existing' — still a success for us
    //    because downstream needs to re-fire (Chroma docs may be missing
    //    from a prior aborted run).
    // -----------------------------------------------------------------
    let stored: StoreFreshSummaryResult | null;
    try {
      stored = storeFreshSummaryForSession(
        sessionStore,
        sessionDbId,
        summaryPayload,
        {
          promptNumber: promptNumber ?? undefined,
          discoveryTokens: 0,
          contentSessionId: sessionRow.content_session_id ?? null,
        },
      );
    } catch (err) {
      // FK race or SQLite error — let consume loop retry.
      throw err;
    }

    if (!stored) {
      logger.warn('SUMLANE', 'Skip: session disappeared during store', {
        sessionDbId, messageId: message.id,
      });
      pendingStore.confirmProcessed(message.id);
      this.onBroadcastProcessingStatus!();
      return;
    }

    // -----------------------------------------------------------------
    // 6. Re-read the persisted row — this is the source of truth payload.
    //    LLM output is non-deterministic; the DB row is what search /
    //    Chroma / SSE must agree on. If the row vanished (concurrent
    //    delete) we still confirm-process the pending message to avoid
    //    infinite retry.
    // -----------------------------------------------------------------
    const persistedRow = sessionStore.getSummaryById(stored.id);
    if (!persistedRow) {
      logger.error('SUMLANE', 'Persisted summary row vanished before downstream — confirming anyway', {
        sessionDbId, summaryId: stored.id, messageId: message.id,
      });
      pendingStore.confirmProcessed(message.id);
      this.onBroadcastProcessingStatus!();
      this.telemetry.recordStored(stored.id, Date.now() - processingStartedAt, {
        drainTimedOut, action: stored.action,
      });
      return;
    }

    const downstreamPayload = {
      request: persistedRow.request,
      investigated: persistedRow.investigated,
      learned: persistedRow.learned,
      completed: persistedRow.completed,
      next_steps: persistedRow.next_steps,
      notes: persistedRow.notes,
    };

    // -----------------------------------------------------------------
    // 7. Downstream effects — ChromaSync + Cursor context + SSE. Run in
    //    parallel and allSettled so one failure doesn't abort the others.
    //    Both Chroma and Cursor are fire-and-forget from the user's POV:
    //    SQLite has the authoritative summary, search falls back to SQLite
    //    if Chroma is stale.
    // -----------------------------------------------------------------
    const chromaSync = this.dbManager!.getChromaSync(dbPath);
    const chromaPromise = chromaSync
      ? chromaSync.syncSummary(
          stored.id,
          stored.memorySessionId,
          persistedRow.project,
          downstreamPayload,
          persistedRow.prompt_number ?? null,
          persistedRow.created_at_epoch,
          0,
        ).catch((err) => {
          logger.warn('SUMLANE', 'Chroma sync failed (non-critical)', {
            sessionDbId, summaryId: stored!.id,
          }, err as Error);
        })
      : Promise.resolve();

    const cursorPromise = updateCursorContextForProject(persistedRow.project, getWorkerPort())
      .catch((err) => {
        logger.warn('SUMLANE', 'Cursor context update failed (non-critical)', {
          sessionDbId, project: persistedRow.project,
        }, err as Error);
      });

    await Promise.allSettled([chromaPromise, cursorPromise]);

    // -----------------------------------------------------------------
    // 8. SSE broadcast + confirm processed. Broadcast from persistedRow
    //    so the viewer shows exactly what was stored.
    // -----------------------------------------------------------------
    const ssePayload: SummarySSEPayload = {
      id: stored.id,
      session_id: sessionRow.content_session_id ?? '',
      request: persistedRow.request,
      investigated: persistedRow.investigated,
      learned: persistedRow.learned,
      completed: persistedRow.completed,
      next_steps: persistedRow.next_steps,
      notes: persistedRow.notes,
      project: persistedRow.project,
      prompt_number: persistedRow.prompt_number ?? null,
      created_at_epoch: persistedRow.created_at_epoch,
    };
    this.onBroadcastSummary!(ssePayload);

    pendingStore.confirmProcessed(message.id);
    this.onBroadcastProcessingStatus!();

    this.telemetry.recordStored(stored.id, Date.now() - processingStartedAt, {
      drainTimedOut, action: stored.action,
    });
  }

  /**
   * Build FreshSummarizeDeps for this summarize message. Isolates the
   * observation-loader closure (content_session_id scoped) from deps
   * plumbing (paths / env / spawn wrapper).
   */
  private buildDeps(input: {
    sessionStore: ReturnType<DatabaseManager['getSessionStore']>;
    contentSessionId: string | null;
    promptNumber: number;
    queuedAtEpoch: number;
    sessionDbId: number;
    dbPath: string;
    signal: AbortSignal;
  }) {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const modelId = settings.CLAUDE_MEM_MODEL;
    ensureDir(OBSERVER_SESSIONS_DIR);

    // content_session_id is the stable cross-turn key — the observer may
    // UPDATE sdk_sessions.memory_session_id mid-flight, so scoping by
    // content_session_id + promptNumber gives a deterministic observation
    // window that survives that churn.
    const csid = input.contentSessionId;
    const getObservationsForSession = () => {
      if (!csid) {
        logger.debug('SUMLANE', 'No content_session_id — summary will run on empty obs', {
          sessionDbId: input.sessionDbId,
        });
        return [];
      }
      return input.sessionStore.getObservationsForContentSessionUpToPrompt(
        csid, input.promptNumber, input.queuedAtEpoch,
      );
    };

    return buildFreshSummarizeDeps({
      getObservationsForSession,
      modelId,
      disallowedTools: SUMMARIZE_DISALLOWED_TOOLS,
      signal: input.signal,
      isolatedEnv: buildIsolatedEnv(),
      cwd: OBSERVER_SESSIONS_DIR,
      pathToClaudeCodeExecutable: findClaudeExecutable(),
      spawnClaudeCodeProcess: createPidCapturingSpawn(input.sessionDbId, input.dbPath),
    });
  }

  private async abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      if (signal.aborted) {
        clearTimeout(timer);
        resolve();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
