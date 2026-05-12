# Worker Service Subsystem

## Core Components

| File | Purpose |
|------|---------|
| `SessionManager.ts` | Session lifecycle, event-driven message queuing, drain window, orphan cleanup |
| `DatabaseManager.ts` | Adapter over `DbConnectionPool` — `getSessionStore(dbPath?)`, `getChromaSync(dbPath?)` |
| `SDKAgent.ts` | Claude subprocess via Agent SDK, observer-only, PID tracking |
| `SearchManager.ts` | Search orchestration (Chroma → SQLite fallback) |
| `ProcessRegistry.ts` | Track spawned subprocess PIDs for zombie cleanup |
| `BypassLane.ts` | Parallel REST consumer for observations (Gemini/OpenRouter/OpenCode Go), circuit breaker, competing consumer on same queue |

## Subdirectories

| Dir | Purpose |
|-----|---------|
| `agents/` | `ResponseProcessor` (response parsing), `ObservationBroadcaster` (SSE), `FallbackErrorHandler` (provider error classification), `SessionCleanupHelper` (abandon/fail coordination), `types.ts` |
| `http/routes/` | `SessionRoutes`, `SearchRoutes`, `DataRoutes`, `MemoryRoutes`, `SettingsRoutes`, `observation-filter.ts` (Layer A pattern filter) |
| `search/` | shared types (`SEARCH_CONSTANTS`) |
| `events/` | `SessionEventBroadcaster` |
| `validation/` | `PrivacyCheckValidator` |

## Key Patterns

**Per-Project Isolation**: Every session has `dbPath` field. Routes extract from request → pass to DB methods. 3-step fallback: explicit → default → lastActive → throw.

**Event-Driven Queuing**: `EventEmitter` per session for zero-latency notifications. `PendingMessageStore` persists to DB first (crash-safe). Subprocess idle timeout (3min, no new messages) triggers abort; session reaper (15min, no generator activity) triggers proactive summarize then reap.

**Dual-Channel Processing**: Main channel always uses Claude SDK. Bypass lane (`BypassLane.ts`) processes observations in parallel via direct REST calls when `CLAUDE_MEM_PROVIDER != 'claude'`. Competing consumers on same `pending_messages` queue — main uses `claimNextMessage()` (all types), bypass uses `claimNextObservation()` (observation-only). Terminated sessions: `markAllSessionMessagesAbandoned` → cleanup. No fallback agents.

**SDK Token Optimization (Phase 1)**: Three-layer optimization in the observation pipeline:
- **Layer A**: `observation-filter.ts` — `parseSkipPatterns()`/`shouldSkipObservation()` pre-filter before enqueue. Cached patterns, configurable via `CLAUDE_MEM_SKIP_TOOL_PATTERNS`.
- **Layer B**: `SDKAgent.createMessageGenerator()` — batch same-prompt observations via `claimNextObservationBatch()`. Uses `buildBatchObservationPrompt()` for multi-item prompts. Settings loaded once per generator.
- **JSON/Truncation**: `buildObservationPrompt()` uses compact JSON, plain text rendering, `truncateField()` at `CLAUDE_MEM_OBS_MAX_FIELD_CHARS`.
- **Telemetry**: `optimizationStats` on `ActiveSession` — `batchedObservations`, `batchPromptsSaved`, `totalPromptChars`, `truncatedFields` logged in `SDK_USAGE_SUMMARY`. Bypass lane logs `truncatedFields` per-message at INFO level.

**SDK Token Optimization (Phase 2)**: Generator safety nets + proactive history reset:
- **Centralized Decision**: `generator-action.ts` — `decideGeneratorAction()` pure function with 12 priority-ordered branches. Both `SessionRoutes` and `WorkerService` delegate `.finally()` logic to this function via `executeAction()`/`executeGeneratorAction()`.
- **Safety Nets**: S1 (`totalLifetimeCrashes` cap), S3 (centralized decision), S4 (`session_stuck` SSE), S5 (DB pre-check + `evict()`), S6 (`consecutiveEmptyObservations` telemetry).
- **Layer C**: `shouldProactiveReset()` — dual trigger (message count + token estimate). Checkpoint in SDKAgent `for-await` loop. `proactiveReset` flag → abort → restart with fresh context (no crash counter).
- **Settings**: `CLAUDE_MEM_MAX_HISTORY_LENGTH` (50), `CLAUDE_MEM_MAX_HISTORY_TOKENS` (100000).

**Pool Starvation Defense** (3-layer): `stale-detection.ts` (Layer 1), `pool-cooldown-utils.ts` (Layer 2), `backpressure.ts` (Layer 3). Applied in `SessionRoutes` (cooldown entry + ensureGeneratorRunning bypass), `SessionManager.queueObservation()` (backpressure gate), `worker-service.ts` (cooldown retry timer). Settings: 7 new `CLAUDE_MEM_*` keys validated in `SettingsRoutes`.

**Drain Window**: `deleteSession()` polls `hasPendingSummarize()` every 500ms (max 10s) before aborting, preventing summary loss on session close.
