/**
 * SummaryLane — global single consumer for pending_messages.summarize rows.
 *
 * Architecture: 3-consumer split over the shared pending_messages queue.
 * Observer (main SDK, observation-only) + BypassLane (REST, observation-only)
 * + SummaryLane (global single consumer, fresh SDK subprocess, summarize-only).
 *
 * This skeleton adds lifecycle + consume-loop shell. The `processSummarize`
 * body (fresh SDK query + drain wait + idempotent store + Chroma/Cursor sync)
 * is implemented in Chunk 6b of the implementation plan.
 */

import type { SessionManager } from './SessionManager.js';
import type { DatabaseManager } from './DatabaseManager.js';
import type { SummarySSEPayload } from './agents/types.js';
import { SummaryLaneTelemetry } from './SummaryLaneTelemetry.js';
import { logger } from '../../utils/logger.js';
import { isProjectStillValid } from './generator-action.js';
import { DB_PATH } from '../../shared/paths.js';

type SummaryLaneState = 'DISABLED' | 'ACTIVE' | 'STOPPED';

export interface SummaryLaneStatus {
  state: SummaryLaneState;
  counters: ReturnType<SummaryLaneTelemetry['getCounters']>;
}

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
   * SKELETON — full implementation lands in Chunk 6b (drain wait + fresh query +
   * idempotent store + Chroma sync + Cursor context update + SSE broadcast).
   *
   * For now this throws so the consume loop's retry path gets exercised in tests.
   */
  private async processSummarize(
    _message: unknown,
    _dbPath: string,
    _signal: AbortSignal,
  ): Promise<void> {
    throw new Error('processSummarize not yet implemented (Chunk 6b)');
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
