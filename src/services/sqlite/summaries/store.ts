/**
 * Store session summaries in the database
 */
import { createHash } from 'crypto';
import type { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';
import type { SummaryInput, StoreSummaryResult } from './types.js';

/** Deduplication window: summaries with the same content hash within this window are skipped */
const DEDUP_WINDOW_MS = 30_000;

/**
 * Compute a short content hash for summary deduplication.
 * Uses (memory_session_id, request, investigated) as the semantic identity of a summary.
 */
export function computeSummaryContentHash(
  memorySessionId: string,
  request: string | null,
  investigated: string | null = null
): string {
  // Join with \x00 (mirrors computeObservationContentHash) so boundary-shifted
  // field vectors don't false-dedup: raw concatenation made ("a","b","") and
  // ("a","","b") hash identically, dropping a genuinely-different summary as a
  // duplicate inside the 30s dedup window.
  return createHash('sha256')
    .update([memorySessionId || '', request || '', investigated || ''].join('\x00'))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Check if a duplicate summary exists within the dedup window.
 */
export function findDuplicateSummary(
  db: Database,
  contentHash: string,
  timestampEpoch: number
): { id: number; created_at_epoch: number } | null {
  const windowStart = timestampEpoch - DEDUP_WINDOW_MS;
  const stmt = db.prepare(
    'SELECT id, created_at_epoch FROM session_summaries WHERE content_hash = ? AND created_at_epoch > ?'
  );
  return (stmt.get(contentHash, windowStart) as { id: number; created_at_epoch: number } | null);
}

/**
 * Store a session summary (from SDK parsing)
 * Assumes session already exists - will fail with FK error if not
 * Performs content-hash deduplication: skips INSERT if an identical summary exists within 30s
 *
 * @param db - Database instance
 * @param memorySessionId - SDK memory session ID
 * @param project - Project name
 * @param summary - Summary content from SDK parsing
 * @param promptNumber - Optional prompt number
 * @param discoveryTokens - Token count for discovery (default 0)
 * @param overrideTimestampEpoch - Optional timestamp override for backlog processing
 */
export function storeSummary(
  db: Database,
  memorySessionId: string,
  project: string,
  summary: SummaryInput,
  promptNumber?: number,
  discoveryTokens: number = 0,
  overrideTimestampEpoch?: number,
  contentSessionId: string | null = null
): StoreSummaryResult {
  // Use override timestamp if provided (for processing backlog messages with original timestamps)
  const timestampEpoch = overrideTimestampEpoch ?? Date.now();
  const timestampIso = new Date(timestampEpoch).toISOString();

  // Content-hash deduplication (mirrors observation dedup pattern)
  const contentHash = computeSummaryContentHash(memorySessionId, summary.request, summary.investigated);
  const existing = findDuplicateSummary(db, contentHash, timestampEpoch);
  if (existing) {
    logger.info('DB', `Summary dedup: skipping duplicate within ${DEDUP_WINDOW_MS}ms window`, {
      existingId: existing.id,
      contentHash,
      memorySessionId
    });
    return {
      id: existing.id,
      createdAtEpoch: existing.created_at_epoch
    };
  }

  const stmt = db.prepare(`
    INSERT INTO session_summaries
    (memory_session_id, content_session_id, project, request, investigated, learned, completed,
     next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    memorySessionId,
    contentSessionId,
    project,
    summary.request,
    summary.investigated,
    summary.learned,
    summary.completed,
    summary.next_steps,
    summary.notes,
    promptNumber || null,
    discoveryTokens,
    timestampIso,
    timestampEpoch,
    contentHash
  );

  return {
    id: Number(result.lastInsertRowid),
    createdAtEpoch: timestampEpoch
  };
}
