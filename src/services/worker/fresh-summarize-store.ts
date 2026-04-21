/**
 * Atomic store helper for the fresh-summarize path.
 *
 * Why this exists:
 *   runFreshSummarize captures sessionRow.memory_session_id at query start
 *   and runs a ~30s fresh SDK query. During that window, the observer path
 *   may call ensureMemorySessionIdRegistered(sessionDbId, newId) when
 *   Claude returns a different session_id from its own query — which UPDATEs
 *   sdk_sessions.memory_session_id. The FK on session_summaries
 *   (memory_session_id → sdk_sessions(memory_session_id), ON UPDATE CASCADE)
 *   only cascades updates to existing dependents — it does NOT help a brand
 *   new INSERT with a now-stale value. Result: FOREIGN KEY constraint failed.
 *
 *   Confirmed in production logs (attn_sink/summarize-fresh-query/RESULT.md):
 *   two occurrences on 2026-04-19 (sessionDbId=216 @ 11:30:15 and 178 @
 *   11:34:33), both preceded by observer's ensureMemorySessionIdRegistered.
 *
 * The fix:
 *   Atomically (inside a bun:sqlite transaction) re-read the session row
 *   right before insert, use the CURRENT memory_session_id. Semantically
 *   correct because the summary represents work on sessionDbId N, and
 *   whichever memory_session_id is currently attached to that row is the
 *   one the summary belongs to.
 */

import type { SessionStore } from '../sqlite/SessionStore.js';

export interface FreshSummaryPayload {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string | null;
}

export function storeFreshSummaryForSession(
  store: SessionStore,
  sessionDbId: number,
  summary: FreshSummaryPayload,
  opts?: { promptNumber?: number; discoveryTokens?: number; contentSessionId?: string | null },
): { id: number; createdAtEpoch: number; memorySessionId: string } | null {
  const atomicInsert = store.db.transaction(
    (): { id: number; createdAtEpoch: number; memorySessionId: string } | null => {
      const row = store
        .db
        .prepare(
          `SELECT memory_session_id, project, content_session_id FROM sdk_sessions WHERE id = ? LIMIT 1`,
        )
        .get(sessionDbId) as { memory_session_id: string | null; project: string; content_session_id: string | null } | undefined;

      if (!row) return null;
      if (!row.memory_session_id) return null;

      const contentSessionId = opts?.contentSessionId ?? row.content_session_id ?? null;

      const stored = store.storeSummary(
        row.memory_session_id,
        row.project,
        summary,
        opts?.promptNumber,
        opts?.discoveryTokens ?? 0,
        undefined,
        contentSessionId,
      );
      return {
        id: stored.id,
        createdAtEpoch: stored.createdAtEpoch,
        memorySessionId: row.memory_session_id,
      };
    },
  );

  return atomicInsert();
}
