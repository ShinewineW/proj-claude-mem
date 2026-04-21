/**
 * 4-layer telemetry for SummaryLane.
 *
 * Layer A: in-memory counters (claimed / processed / failed / retried / deadLetters / skipped / drainTimedOut / returnedExisting)
 * Layer B: per-message timing logs via recordStored options
 * Layer C: queue-depth alarm sampler (setInterval 30s; caller wires the sampler callback)
 * Layer D: hourly SUMLANE_USAGE_SUMMARY aggregation (emitted via flushHourly())
 */

import { logger } from '../../utils/logger.js';

export interface SummaryLaneCounters {
  claimed: number;
  processed: number;
  failed: number;
  retried: number;
  deadLetters: number;
  skipped: number;
  drainTimedOut: number;
  returnedExisting: number;
}

export interface QueueDepthSnapshot {
  pendingCount: number;
  oldestPendingAgeMs: number;
}

type QueueDepthSampler = () => QueueDepthSnapshot;

export class SummaryLaneTelemetry {
  private counters: SummaryLaneCounters = {
    claimed: 0,
    processed: 0,
    failed: 0,
    retried: 0,
    deadLetters: 0,
    skipped: 0,
    drainTimedOut: 0,
    returnedExisting: 0,
  };

  private queueWaitSamples: number[] = [];
  private processingSamples: number[] = [];
  private drainSamples: number[] = [];

  private queueDepthInterval: ReturnType<typeof setInterval> | null = null;
  private hourlyInterval: ReturnType<typeof setInterval> | null = null;

  private lastFlushCounters: SummaryLaneCounters = {
    claimed: 0, processed: 0, failed: 0, retried: 0,
    deadLetters: 0, skipped: 0, drainTimedOut: 0, returnedExisting: 0,
  };

  recordClaimed(messageId: number, queuedAtEpoch: number): void {
    this.counters.claimed++;
    const queueWaitMs = Date.now() - queuedAtEpoch;
    this.queueWaitSamples.push(queueWaitMs);
    logger.info('SUMLANE', 'message_claimed', { messageId, queueWaitMs });
  }

  recordProcessed(_messageId: number): void {
    this.counters.processed++;
  }

  recordStored(
    summaryId: number,
    processingDurationMs: number,
    opts: { drainTimedOut?: boolean; action?: 'inserted' | 'returned_existing' } = {},
  ): void {
    this.processingSamples.push(processingDurationMs);
    if (opts.drainTimedOut) this.counters.drainTimedOut++;
    if (opts.action === 'returned_existing') this.counters.returnedExisting++;
    logger.info('SUMLANE', 'message_processed', {
      summaryId,
      processingDurationMs,
      storeAction: opts.action ?? 'inserted',
      observationDrainTimedOut: !!opts.drainTimedOut,
    });
  }

  recordFailed(_messageId: number): void {
    this.counters.failed++;
  }

  recordRetried(messageId: number, retryCount: number): void {
    this.counters.retried++;
    logger.warn('SUMLANE', 'message_failed_retry', { messageId, retryCount });
  }

  recordDeadLetter(messageId: number): void {
    this.counters.deadLetters++;
    logger.error('SUMLANE', 'message_dead_lettered', { messageId });
  }

  recordSkipped(_messageId: number): void {
    this.counters.skipped++;
  }

  recordObservationDrain(drainMs: number): void {
    this.drainSamples.push(drainMs);
  }

  getCounters(): SummaryLaneCounters {
    return { ...this.counters };
  }

  /**
   * Start a 30s queue-depth sampler. Caller provides the sampler that queries
   * actual DB state (SummaryLane cannot hold a DB reference directly).
   */
  startQueueDepthAlarm(sampler: QueueDepthSampler): void {
    if (this.queueDepthInterval) return;
    this.queueDepthInterval = setInterval(() => {
      try {
        const snap = sampler();
        logger.info('SUMLANE', 'queue_depth_snapshot', snap);
        if (snap.pendingCount >= 5 && snap.oldestPendingAgeMs > 2 * 60 * 1000) {
          logger.warn('SUMLANE', 'queue_backlog_alarm', {
            ...snap,
            hint: 'Consider pool-of-N consumers if this alarm fires consistently',
          });
        }
      } catch (err) {
        logger.debug('SUMLANE', 'queue depth sampler failed', {}, err as Error);
      }
    }, 30_000);
  }

  /**
   * Start the recurring hourly flush of SUMLANE_USAGE_SUMMARY.
   */
  startHourlyFlush(): void {
    if (this.hourlyInterval) return;
    this.hourlyInterval = setInterval(() => {
      try {
        this.flushHourly();
      } catch (err) {
        logger.debug('SUMLANE', 'hourly flush failed', {}, err as Error);
      }
    }, 60 * 60 * 1000);
  }

  stop(): void {
    if (this.queueDepthInterval) {
      clearInterval(this.queueDepthInterval);
      this.queueDepthInterval = null;
    }
    if (this.hourlyInterval) {
      clearInterval(this.hourlyInterval);
      this.hourlyInterval = null;
    }
  }

  flushHourly(): void {
    const p95 = (samples: number[]): number => {
      if (samples.length === 0) return 0;
      const sorted = [...samples].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length * 0.95)];
    };
    const avg = (samples: number[]): number =>
      samples.length === 0 ? 0 : samples.reduce((a, b) => a + b, 0) / samples.length;

    const delta: SummaryLaneCounters = {
      claimed: this.counters.claimed - this.lastFlushCounters.claimed,
      processed: this.counters.processed - this.lastFlushCounters.processed,
      failed: this.counters.failed - this.lastFlushCounters.failed,
      retried: this.counters.retried - this.lastFlushCounters.retried,
      deadLetters: this.counters.deadLetters - this.lastFlushCounters.deadLetters,
      skipped: this.counters.skipped - this.lastFlushCounters.skipped,
      drainTimedOut: this.counters.drainTimedOut - this.lastFlushCounters.drainTimedOut,
      returnedExisting: this.counters.returnedExisting - this.lastFlushCounters.returnedExisting,
    };

    logger.info('SUMLANE', 'SUMLANE_USAGE_SUMMARY', {
      period: 'hour',
      ...delta,
      lifetime: { ...this.counters },
      avgQueueWaitMs: avg(this.queueWaitSamples),
      p95QueueWaitMs: p95(this.queueWaitSamples),
      avgProcessingMs: avg(this.processingSamples),
      p95ProcessingMs: p95(this.processingSamples),
      avgObservationDrainMs: avg(this.drainSamples),
    });

    this.lastFlushCounters = { ...this.counters };
    this.queueWaitSamples = [];
    this.processingSamples = [];
    this.drainSamples = [];
  }
}
