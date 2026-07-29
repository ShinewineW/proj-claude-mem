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
-- This script is NOT idempotent: it restores snapshot rows and rebuilds live
-- tables. Run once against a backup.

BEGIN TRANSACTION;

-- 0. Drop either turn-identity index. The table rebuilds below intentionally
--    omit migration-34's turn_number columns, so this same script works both
--    before and after migration 34.
DROP INDEX IF EXISTS idx_session_summaries_turnnum_unique;

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

-- 3. Restore the pre-Chunk-6a session_summaries schema. Rebuilding instead
--    of DROP COLUMN also removes migration-34's turn_number when present,
--    while remaining valid on a pre-34 database where it does not exist.
ALTER TABLE session_summaries RENAME TO session_summaries_rollback_summarylane;

CREATE TABLE session_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  request TEXT,
  investigated TEXT,
  learned TEXT,
  completed TEXT,
  next_steps TEXT,
  files_read TEXT,
  files_edited TEXT,
  notes TEXT,
  prompt_number INTEGER,
  discovery_tokens INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  content_hash TEXT,
  FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO session_summaries
  (id, memory_session_id, project, request, investigated, learned, completed,
   next_steps, files_read, files_edited, notes, prompt_number,
   discovery_tokens, created_at, created_at_epoch, content_hash)
SELECT
  id, memory_session_id, project, request, investigated, learned, completed,
  next_steps, files_read, files_edited, notes, prompt_number,
  discovery_tokens, created_at, created_at_epoch, content_hash
FROM session_summaries_rollback_summarylane;

DROP TABLE session_summaries_rollback_summarylane;

CREATE INDEX idx_session_summaries_sdk_session
  ON session_summaries(memory_session_id);
CREATE INDEX idx_session_summaries_project
  ON session_summaries(project);
CREATE INDEX idx_session_summaries_created
  ON session_summaries(created_at_epoch DESC);

-- 4. Drop the content_session_id column from observations
--    (added in migration 28).
ALTER TABLE observations DROP COLUMN content_session_id;

-- 5. Restore the pre-34 pending_messages schema. This unconditional rebuild
--    is compatible with both shapes because the SELECT lists only columns
--    that existed before migration 34.
ALTER TABLE pending_messages RENAME TO pending_messages_rollback_turn_identity;

CREATE TABLE pending_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_db_id INTEGER NOT NULL,
  content_session_id TEXT NOT NULL,
  message_type TEXT NOT NULL
    CHECK(message_type IN ('observation', 'summarize')),
  tool_name TEXT,
  tool_input TEXT,
  tool_response TEXT,
  cwd TEXT,
  last_user_message TEXT,
  last_assistant_message TEXT,
  prompt_number INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'processing', 'processed', 'failed')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at_epoch INTEGER NOT NULL,
  started_processing_at_epoch INTEGER,
  completed_at_epoch INTEGER,
  failed_at_epoch INTEGER,
  FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
);

INSERT INTO pending_messages
  (id, session_db_id, content_session_id, message_type, tool_name, tool_input,
   tool_response, cwd, last_user_message, last_assistant_message,
   prompt_number, status, retry_count, created_at_epoch,
   started_processing_at_epoch, completed_at_epoch, failed_at_epoch)
SELECT
  id, session_db_id, content_session_id, message_type, tool_name, tool_input,
  tool_response, cwd, last_user_message, last_assistant_message,
  prompt_number, status, retry_count, created_at_epoch,
  started_processing_at_epoch, completed_at_epoch, failed_at_epoch
FROM pending_messages_rollback_turn_identity;

DROP TABLE pending_messages_rollback_turn_identity;

CREATE INDEX idx_pending_messages_session
  ON pending_messages(session_db_id);
CREATE INDEX idx_pending_messages_status
  ON pending_messages(status);
CREATE INDEX idx_pending_messages_claude_session
  ON pending_messages(content_session_id);

-- 6. Remove schema_versions entries for the five Chunk 6a migrations,
--    plus 34 (turn-identity split) which step 0 undid.
--    27: pre-migration snapshot
--    28: observations.content_session_id ADD COLUMN
--    29: session_summaries.content_session_id ADD COLUMN
--    30: backfill content_session_id from sdk_sessions
--    31: historical dedup + partial unique index
--    34: turn_number identity column + index swap
DELETE FROM schema_versions WHERE version IN (27, 28, 29, 30, 31, 34);

COMMIT;

-- 7. The snapshot tables are retained per spec §9 ("keep ≥6 months"). An
--    operator may drop them later with:
--      DROP TABLE observations_premigration_summarylane;
--      DROP TABLE session_summaries_premigration_summarylane;
--
-- Post-rollback verification (run outside the transaction):
--   SELECT COUNT(*) FROM session_summaries;   -- >= pre-migration count
--   PRAGMA table_info(session_summaries);     -- must NOT show content_session_id
--   PRAGMA index_list(session_summaries);     -- must NOT show idx_session_summaries_turn_unique
