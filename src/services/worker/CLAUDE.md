# Worker Service Subsystem

## Core Components

| File | Purpose |
|------|---------|
| `SessionManager.ts` | Session lifecycle, event-driven message queuing, drain window, orphan cleanup |
| `DatabaseManager.ts` | Adapter over `DbConnectionPool` — `getSessionStore(dbPath?)`, `getChromaSync(dbPath?)` |
| `SDKAgent.ts` | Claude subprocess via Agent SDK, observer-only, PID tracking |
| `SearchManager.ts` | Search orchestration (Chroma → SQLite fallback) |
| `ProcessRegistry.ts` | Track spawned subprocess PIDs for zombie cleanup |
| `BypassLane.ts` | Parallel REST consumer for observations (Gemini/OpenRouter), circuit breaker, competing consumer on same queue |

## Subdirectories

| Dir | Purpose |
|-----|---------|
| `agents/` | `ResponseProcessor` (shared response parsing), `ObservationBroadcaster` (SSE) |
| `http/routes/` | `SessionRoutes`, `SearchRoutes`, `DataRoutes`, `MemoryRoutes`, `SettingsRoutes`, `observation-filter.ts` (Layer A pattern filter) |
| `search/` | `SearchOrchestrator`, strategies (Chroma/SQLite/Hybrid), filters |
| `events/` | `SessionEventBroadcaster` |
| `validation/` | `PrivacyCheckValidator` |

## Key Patterns

**Per-Project Isolation**: Every session has `dbPath` field. Routes extract from request → pass to DB methods. 3-step fallback: explicit → default → lastActive → throw.

**Event-Driven Queuing**: `EventEmitter` per session for zero-latency notifications. `PendingMessageStore` persists to DB first (crash-safe). Idle timeout (3min) triggers subprocess abort.

**Dual-Channel Processing**: Main channel always uses Claude SDK. Bypass lane (`BypassLane.ts`) processes observations in parallel via direct REST calls when `CLAUDE_MEM_PROVIDER != 'claude'`. Competing consumers on same `pending_messages` queue — main uses `claimNextMessage()` (all types), bypass uses `claimNextObservation()` (observation-only). Terminated sessions: `markAllSessionMessagesAbandoned` → cleanup. No fallback agents.

**SDK Token Optimization (Phase 1)**: Three-layer optimization in the observation pipeline:
- **Layer A**: `observation-filter.ts` — `parseSkipPatterns()`/`shouldSkipObservation()` pre-filter before enqueue. Cached patterns, configurable via `CLAUDE_MEM_SKIP_TOOL_PATTERNS`.
- **Layer B**: `SDKAgent.createMessageGenerator()` — batch same-prompt observations via `claimNextObservationBatch()`. Uses `buildBatchObservationPrompt()` for multi-item prompts. Settings loaded once per generator.
- **JSON/Truncation**: `buildObservationPrompt()` uses compact JSON, plain text rendering, `truncateField()` at `CLAUDE_MEM_OBS_MAX_FIELD_CHARS`.
- **Telemetry**: `optimizationStats` on `ActiveSession` — `batchedObservations`, `batchPromptsSaved`, `totalPromptChars` logged in `SDK_USAGE_SUMMARY`.

**Drain Window**: `deleteSession()` polls `hasPendingSummarize()` every 500ms (max 10s) before aborting, preventing summary loss on session close.
