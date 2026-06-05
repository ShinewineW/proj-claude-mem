# SQLite Persistence Layer

## Core Classes

| File | Purpose |
|------|---------|
| `SessionStore.ts` | Main CRUD for sessions, observations, summaries, prompts. Delegates all migrations to `MigrationRunner` (single source of truth). Schema versions up to 33. |
| `PendingMessageStore.ts` | Persistent message queue with claim-confirm lifecycle (pending→processing→deleted). |
| `SessionSearch.ts` | Filter-only structured search (vector search via ChromaDB, not local FTS). |
| `Database.ts` | Entry point: `ClaudeMemDatabase` (recommended) — opens a tuned `bun:sqlite` connection and runs `MigrationRunner.runAllMigrations()` directly (replaces SessionStore as the DB coordinator). |
| `migrations/runner.ts` | `MigrationRunner` — extracted from SessionStore, 25 migration steps (`runAllMigrations`, schema versions up to 33; legacy version-9999 sentinel migrated/dropped in step 25). |
| `Import.ts` → `import/bulk.ts` | Bulk import: `importObservation()`, `importSessionSummary()`, `importSdkSession()`, `importUserPrompt()` with content_hash dedup. `Import.ts` is a re-export shim; logic lives in `import/bulk.ts`. |
| `transactions.ts` | Shared transaction helpers. |
| `observations/`, `summaries/`, `sessions/`, `prompts/`, `timeline/` | Per-domain split modules (store/get/recent/types) re-exported by `Observations.ts`, `Summaries.ts`, `Sessions.ts`, `Prompts.ts`, `Timeline.ts`. |

## Key Tables

| Table | Purpose | Key FKs |
|-------|---------|---------|
| `sdk_sessions` | Session metadata | `content_session_id` (Claude Code), `memory_session_id` (SDK Agent) |
| `observations` | Work observations (6 types) | `memory_session_id` → sdk_sessions |
| `session_summaries` | Session summaries | `memory_session_id` → sdk_sessions |
| `user_prompts` | User messages (FTS5) | `content_session_id` → sdk_sessions |
| `pending_messages` | Message queue | `session_db_id` → sdk_sessions.id |

## PendingMessageStore Lifecycle

`enqueue()` → pending → `claimNextMessage()` → processing → `confirmProcessed()` → deleted

- **String detection in enqueue**: `typeof tool_input === 'string'` stores as-is (avoids double-encoding from cleanToolField). Objects get `JSON.stringify`. Post-claim invariant: `toPendingMessage()` returns raw JSON strings (no parsing).
- **Batch claiming**: `claimNextObservationBatch(sessionDbId, promptNumber, maxCount)` claims FIFO-contiguous same-prompt observations with boundary protection (`status IN ('pending', 'processing')` subquery prevents skipping over summarize/different-prompt rows).
- Stale 'processing' messages auto-reset after 60s. `hasPendingSummarize()` checks unclaimed summarizes for drain window.
- **`markFailed` retry semantic**: uses `retry_count < maxRetries` (strict less-than). With `maxRetries=3`: call 1 → retry_count=1 (pending), call 2 → 2 (pending), call 3 → 3 (pending), call 4 → `'failed'`. Need **N+1 calls** to reach `'failed'` when `maxRetries=N`. Returns `{finalStatus: 'pending' | 'failed', retryCount}` — SummaryLane uses `finalStatus` to decide retry-with-backoff vs dead-letter; legacy callers (BypassLane, tests) ignore the return value. Existing test pin at `pending-message-retry.test.ts` seeds `enqueueWithState('processing', 3)` → `markFailed` → expects `failed_at_epoch` set.

## Migration Conventions

- Each migration checks `schema_versions` + actual column existence (defends against #979)
- Use `INSERT OR IGNORE` into `schema_versions` for idempotence
- Large schema changes: `CREATE TABLE AS SELECT` + rename in transaction
- **Single source of truth**: All migrations live in `MigrationRunner.runAllMigrations()`. `SessionStore` constructor delegates to it (no inline migration logic), and `DbConnectionPool` creates per-project DBs via `new SessionStore()`, so adding a step to the `runAllMigrations` array is sufficient to schema-migrate every DB
