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
 *
 * Turn-key dedup (Chunk 6b):
 *   Before INSERTing, we check the (content_session_id, turn_number) turn key
 *   against the partial unique index from migration 34. If an existing row
 *   matches, return it with action='returned_existing'. This makes idempotent
 *   replay safe: SummaryLane can reclaim a pending summarize row after crash
 *   without generating a duplicate summary. The key is turn IDENTITY, not
 *   prompt_number — keying on the latter collapsed consecutive
 *   `<task-notification>` turns onto one slot and silently dropped all but the
 *   first. When turnNumber is absent or contentSessionId is NULL the turn key
 *   is invalid and we fall back to the content-hash dedup inside storeSummary.
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

export interface StoreFreshSummaryResult {
  action: 'inserted' | 'returned_existing';
  id: number;
  createdAtEpoch: number;
  memorySessionId: string;
}

export function storeFreshSummaryForSession(
  store: SessionStore,
  sessionDbId: number,
  summary: FreshSummaryPayload,
  opts?: { promptNumber?: number; turnNumber?: number; discoveryTokens?: number; contentSessionId?: string | null },
): StoreFreshSummaryResult | null {
  const atomicInsert = store.db.transaction(
    (): StoreFreshSummaryResult | null => {
      const row = store
        .db
        .prepare(
          `SELECT memory_session_id, project, content_session_id FROM sdk_sessions WHERE id = ? LIMIT 1`,
        )
        .get(sessionDbId) as { memory_session_id: string | null; project: string; content_session_id: string | null } | undefined;

      if (!row) return null;
      if (!row.memory_session_id) return null;

      const contentSessionId = opts?.contentSessionId ?? row.content_session_id ?? null;

      // Turn-key dedup (migration 34 partial unique index): if this
      // (content_session_id, turn_number) has already produced a summary,
      // return the existing row as 'returned_existing' so the caller can
      // still drive downstream (Chroma sync, SSE broadcast) and confirm the
      // pending_messages row idempotently. Guarded by non-NULL because the
      // index is partial over non-NULL columns.
      if (
        contentSessionId !== null &&
        opts?.turnNumber !== undefined &&
        opts.turnNumber !== null
      ) {
        const existing = store
          .db
          .prepare(
            `SELECT id, created_at_epoch FROM session_summaries
             WHERE content_session_id = ? AND turn_number = ?
             LIMIT 1`,
          )
          .get(contentSessionId, opts.turnNumber) as { id: number; created_at_epoch: number } | undefined;

        if (existing) {
          return {
            action: 'returned_existing',
            id: existing.id,
            createdAtEpoch: existing.created_at_epoch,
            memorySessionId: row.memory_session_id,
          };
        }
      }

      const stored = store.storeSummary(
        row.memory_session_id,
        row.project,
        summary,
        opts?.promptNumber,
        opts?.discoveryTokens ?? 0,
        undefined,
        contentSessionId,
        opts?.turnNumber,
      );
      return {
        action: 'inserted',
        // storeSummary skips (id=null) only when memory_session_id is falsy, but
        // line 69 already returned null in that case — so on this path id is a real row id.
        id: stored.id!,
        createdAtEpoch: stored.createdAtEpoch,
        memorySessionId: row.memory_session_id,
      };
    },
  );

  return atomicInsert();
}
