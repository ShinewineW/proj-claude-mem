/**
 * Atomic observation insert helper for BypassLane.
 *
 * Mirrors fresh-summarize-store.ts: re-reads sdk_sessions.memory_session_id
 * inside the transaction immediately before calling storeObservations, so the
 * FK target is guaranteed to exist at INSERT time.
 *
 * Why this exists: BypassLane captures session.memorySessionId at claim time
 * (T0), then calls the bypass LLM (several seconds), then writes observations.
 * During that window, the observer path can rotate sdk_sessions.memory_session_id
 * via ensureMemorySessionIdRegistered (PROACTIVE_RESET → Layer C). If we INSERT
 * with the T0 value, the FK fails because the referenced row no longer carries it.
 *
 * Same race pattern as the April 2026 storeFreshSummaryForSession fix (commit
 * 8cba0ce0), different INSERT site.
 */

import type { SessionStore } from '../sqlite/SessionStore.js';

export interface BypassObservationPayload {
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  files_read: string[];
  files_modified: string[];
}

export interface StoreBypassObservationsResult {
  observationIds: number[];
  createdAtEpoch: number;
  memorySessionId: string;
}

/**
 * Atomically: SELECT current memory_session_id for sessionDbId, then
 * INSERT observations using that value. Both happen inside one transaction so
 * no observer-side UPDATE can interleave between SELECT and INSERT.
 *
 * Returns null when the sdk_sessions row is gone or has no memory_session_id
 * yet (caller treats this as a transient retry case, same as the existing
 * "Waiting for memorySessionId" branch).
 */
export function storeBypassObservationsForSession(
  store: SessionStore,
  sessionDbId: number,
  observations: BypassObservationPayload[],
  opts: {
    promptNumber?: number;
    overrideTimestampEpoch?: number;
    contentSessionId?: string | null;
  } = {},
): StoreBypassObservationsResult | null {
  const atomicInsert = store.db.transaction((): StoreBypassObservationsResult | null => {
    const row = store.db
      .prepare(
        `SELECT memory_session_id, project, content_session_id FROM sdk_sessions WHERE id = ? LIMIT 1`,
      )
      .get(sessionDbId) as
      | { memory_session_id: string | null; project: string; content_session_id: string | null }
      | undefined;

    if (!row) return null;
    if (!row.memory_session_id) return null;

    const contentSessionId = opts.contentSessionId ?? row.content_session_id ?? null;

    const stored = store.storeObservations(
      row.memory_session_id,
      row.project,
      observations,
      null,
      opts.promptNumber,
      0,
      opts.overrideTimestampEpoch,
      contentSessionId,
    );

    return {
      observationIds: stored.observationIds,
      createdAtEpoch: stored.createdAtEpoch,
      memorySessionId: row.memory_session_id,
    };
  });

  return atomicInsert();
}
