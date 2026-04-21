-- Rollback for Chunk 6a of the SummaryLane migration (migrations 27-31).
-- Apply to a single project DB (per .claude/mem.db) after stopping the
-- worker.
--
-- Preconditions:
--   1. Worker is stopped (no writers touching these tables).
--   2. Pre-snapshot tables (observations_premigration_summarylane,
--      session_summaries_premigration_summarylane) still exist.
--      Verify with:
--        SELECT name FROM sqlite_master
--        WHERE type='table' AND name LIKE '%_premigration_summarylane';
--
-- This script is idempotent for schema DROPs but NOT for row restoration
-- (re-running would double-insert). Run once.

BEGIN TRANSACTION;

-- 1. Drop the partial unique index (migration 31).
DROP INDEX IF EXISTS idx_session_summaries_turn_unique;

-- 2. Restore rows destroyed by migration 31's dedup. We only restore
--    rows present in the snapshot whose id no longer exists in the live
--    table, so the statement is NOT safe to re-run (but the DROP INDEX
--    above is). Column list matches the session_summaries schema at the
--    snapshot point (migration 27) — WITHOUT content_session_id, since
--    that column did not exist yet when the snapshot was captured.
INSERT INTO session_summaries
  (id, memory_session_id, project, request, investigated, learned,
   completed, next_steps, notes, prompt_number, discovery_tokens,
   created_at, created_at_epoch, content_hash)
SELECT
  snap.id, snap.memory_session_id, snap.project, snap.request,
  snap.investigated, snap.learned, snap.completed, snap.next_steps,
  snap.notes, snap.prompt_number, snap.discovery_tokens,
  snap.created_at, snap.created_at_epoch, snap.content_hash
FROM session_summaries_premigration_summarylane snap
WHERE NOT EXISTS (
  SELECT 1 FROM session_summaries cur WHERE cur.id = snap.id
);

-- 3. Drop the content_session_id column from session_summaries
--    (added in migration 29). SQLite 3.35+ supports ALTER TABLE DROP
--    COLUMN directly; bun:sqlite ships 3.45+.
ALTER TABLE session_summaries DROP COLUMN content_session_id;

-- 4. Drop the content_session_id column from observations
--    (added in migration 28).
ALTER TABLE observations DROP COLUMN content_session_id;

-- 5. Remove schema_versions entries for the five Chunk 6a migrations.
--    27: pre-migration snapshot
--    28: observations.content_session_id ADD COLUMN
--    29: session_summaries.content_session_id ADD COLUMN
--    30: backfill content_session_id from sdk_sessions
--    31: historical dedup + partial unique index
DELETE FROM schema_versions WHERE version IN (27, 28, 29, 30, 31);

COMMIT;

-- 6. The snapshot tables are retained per spec §9 ("keep ≥6 months"). An
--    operator may drop them later with:
--      DROP TABLE observations_premigration_summarylane;
--      DROP TABLE session_summaries_premigration_summarylane;
--
-- Post-rollback verification (run outside the transaction):
--   SELECT COUNT(*) FROM session_summaries;   -- >= pre-migration count
--   PRAGMA table_info(session_summaries);     -- must NOT show content_session_id
--   PRAGMA index_list(session_summaries);     -- must NOT show idx_session_summaries_turn_unique
