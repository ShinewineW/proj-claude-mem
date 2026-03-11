# SQLite Persistence Layer

## Core Classes

| File | Purpose |
|------|---------|
| `SessionStore.ts` | Main CRUD for sessions, observations, summaries, prompts. Schema versions up to 25. |
| `PendingMessageStore.ts` | Persistent message queue with claim-confirm lifecycle (pending→processing→deleted). |
| `SessionSearch.ts` | Filter-only structured search (vector search via ChromaDB, not local FTS). |
| `Database.ts` | Entry point: `ClaudeMemDatabase` (recommended) wraps SessionStore + migrations. |
| `migrations/runner.ts` | `MigrationRunner` — extracted from SessionStore, 17 migration methods (schema versions up to 25). |

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

Stale 'processing' messages auto-reset after 60s. `hasPendingSummarize()` checks unclaimed summarizes for drain window.

## Migration Conventions

- Each migration checks `schema_versions` + actual column existence (defends against #979)
- Use `INSERT OR IGNORE` into `schema_versions` for idempotence
- Large schema changes: `CREATE TABLE AS SELECT` + rename in transaction
