/**
 * RetentionManager - Observation lifecycle management
 *
 * Runs during SessionStart to clean up old observations based on importance scoring.
 * Rules:
 *   1. Observations <= retentionDays old: PROTECTED
 *   2. Older observations with score < threshold: DELETED
 *   3. Remaining old observations capped at maxKept (by score DESC)
 *   4. Orphaned prompts (session has 0 remaining observations) deleted
 *   5. Summaries are NEVER deleted
 */

import type { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';

export interface RetentionConfig {
  enabled: boolean;
  retentionDays: number;
  scoreThreshold: number;
  maxKept: number;
}

export interface CleanupResult {
  deleted: number;
  kept: number;
  orphanedPrompts: number;
  elapsed_ms: number;
}

/** Observation type importance weights */
const TYPE_SCORES: Record<string, number> = {
  decision: 1.0,
  discovery: 0.9,
  bugfix: 0.7,
  feature: 0.6,
  refactor: 0.5,
  change: 0.4,
};

const W_TYPE = 0.25;
const W_RECENCY = 0.50;
const W_REFERENCE = 0.25;

export class RetentionManager {
  /**
   * Compute importance score for a single observation.
   *
   * score = W_TYPE * typeScore + W_RECENCY * recencyScore + W_REFERENCE * referenceScore
   *
   * Args:
   *   type: Observation type (decision, discovery, bugfix, feature, refactor, change).
   *   ageDays: Age of the observation in days.
   *   accessCount: Number of times the observation has been accessed via search.
   *
   * Returns:
   *   Score between 0.0 and 1.0.
   */
  static computeScore(type: string, ageDays: number, accessCount: number): number {
    const typeScore = TYPE_SCORES[type] ?? 0.4;
    const recencyScore = ageDays <= 30 ? 1.0 : Math.max(0, 1 - (ageDays - 30) / 150);
    const referenceScore = Math.min(1.0, accessCount / 5);

    return W_TYPE * typeScore + W_RECENCY * recencyScore + W_REFERENCE * referenceScore;
  }

  /**
   * Run retention cleanup for a project database.
   *
   * Deletes old, low-importance observations and their orphaned prompts.
   * Summaries are never deleted. Only affects the specified project.
   *
   * Args:
   *   db: SQLite database connection.
   *   project: Project identifier to scope cleanup.
   *   config: Retention configuration (thresholds, caps, enabled flag).
   *
   * Returns:
   *   CleanupResult with counts of deleted/kept items and elapsed time.
   */
  static cleanup(db: Database, project: string, config: RetentionConfig): CleanupResult {
    const start = performance.now();

    if (!config.enabled) {
      return { deleted: 0, kept: 0, orphanedPrompts: 0, elapsed_ms: 0 };
    }

    const cutoffEpoch = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000;

    // Fetch all observations beyond grace period for this project
    const oldObservations = db.query(`
      SELECT id, type, created_at_epoch, access_count
      FROM observations
      WHERE project = ? AND created_at_epoch < ?
      ORDER BY created_at_epoch DESC
    `).all(project, cutoffEpoch) as Array<{
      id: number;
      type: string;
      created_at_epoch: number;
      access_count: number;
    }>;

    if (oldObservations.length === 0) {
      return { deleted: 0, kept: 0, orphanedPrompts: 0, elapsed_ms: performance.now() - start };
    }

    const now = Date.now();
    const scored = oldObservations.map(obs => {
      const ageDays = (now - obs.created_at_epoch) / (24 * 60 * 60 * 1000);
      const score = this.computeScore(obs.type, ageDays, obs.access_count);
      return { id: obs.id, score };
    });

    // Phase 1: Mark observations below threshold for deletion
    const toDelete: number[] = [];
    const toKeep = scored.filter(s => {
      if (s.score < config.scoreThreshold) {
        toDelete.push(s.id);
        return false;
      }
      return true;
    });

    // Phase 2: Enforce hard cap -- sort kept by score DESC, delete overflow
    if (toKeep.length > config.maxKept) {
      toKeep.sort((a, b) => b.score - a.score);
      const overflow = toKeep.splice(config.maxKept);
      toDelete.push(...overflow.map(o => o.id));
    }

    // Phase 3: Delete observations in a single transaction
    let orphanedPrompts = 0;
    if (toDelete.length > 0) {
      const deleteTransaction = db.transaction(() => {
        // Delete observations
        const placeholders = toDelete.map(() => '?').join(',');
        db.prepare(`DELETE FROM observations WHERE id IN (${placeholders})`).run(...toDelete);

        // Delete orphaned prompts: sessions that have 0 remaining observations
        const orphanResult = db.prepare(`
          DELETE FROM user_prompts
          WHERE content_session_id IN (
            SELECT s.content_session_id FROM sdk_sessions s
            WHERE s.project = ?
              AND NOT EXISTS (
                SELECT 1 FROM observations o
                WHERE o.memory_session_id = s.memory_session_id
              )
          )
        `).run(project);
        orphanedPrompts = orphanResult.changes;
      });

      deleteTransaction();
    }

    const elapsed_ms = performance.now() - start;

    logger.info('RETENTION', `Cleanup complete for ${project}`, {
      deleted: toDelete.length,
      kept: toKeep.length,
      orphanedPrompts,
      elapsed_ms: Math.round(elapsed_ms),
    });

    return {
      deleted: toDelete.length,
      kept: toKeep.length,
      orphanedPrompts,
      elapsed_ms,
    };
  }
}
