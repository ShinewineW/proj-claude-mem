# Worker Service Subsystem

## Core Components

| File | Purpose |
|------|---------|
| `SessionManager.ts` | Session lifecycle, event-driven message queuing, drain window, orphan cleanup |
| `DatabaseManager.ts` | Adapter over `DbConnectionPool` — `getSessionStore(dbPath?)`, `getChromaSync(dbPath?)` |
| `SDKAgent.ts` | Claude subprocess via Agent SDK, observer-only, PID tracking |
| `SearchManager.ts` | Search orchestration (Chroma → SQLite fallback) |
| `ProcessRegistry.ts` | Track spawned subprocess PIDs for zombie cleanup |
| `BypassLane.ts` | Parallel REST consumer for observations (Gemini/OpenCode Go), circuit breaker, competing consumer on same queue |
| `SummaryLane.ts` | Global single consumer for `pending_messages.summarize` rows — drains observations, runs fresh SDK query, atomic store + Chroma sync + cursor context + SSE |
| `SummaryLaneTelemetry.ts` | 4-layer telemetry for SummaryLane (counters / per-message timing / queue-depth alarm / hourly `SUMLANE_USAGE_SUMMARY`) |
| `fresh-summarize.ts` | Fresh `query()` summarize path (no resume, no observer history) — bypasses observer-session role conditioning; all boundaries injected via `FreshSummarizeDeps` |
| `fresh-summarize-store.ts` | Atomic store helper — re-reads `memory_session_id` inside a transaction before INSERT (FK race), turn-key dedup |
| `fresh-summarize-deps.ts` | Single source of truth for `FreshSummarizeDeps` construction (AbortSignal → AbortController shutdown plumbing) |

## Subdirectories

| Dir | Purpose |
|-----|---------|
| `agents/` | `ResponseProcessor` (response parsing), `ObservationBroadcaster` (SSE), `FallbackErrorHandler` (provider error classification), `SessionCleanupHelper` (abandon/fail coordination), `types.ts` |
| `http/routes/` | `SessionRoutes`, `SearchRoutes`, `DataRoutes`, `MemoryRoutes`, `SettingsRoutes`, `LogsRoutes`, `ViewerRoutes`, `observation-filter.ts` (Layer A pattern filter), `observation-utils.ts`, `pool-cooldown-utils.ts` |
| `search/` | shared types (`SEARCH_CONSTANTS`) |
| `events/` | `SessionEventBroadcaster` |
| `validation/` | `PrivacyCheckValidator` |

## Key Patterns

**Per-Project Isolation**: Every session has `dbPath` field. Routes extract from request → pass to DB methods. 3-step fallback: explicit → default → lastActive → throw.

**Event-Driven Queuing**: `EventEmitter` per session for zero-latency notifications. `PendingMessageStore` persists to DB first (crash-safe). Subprocess idle timeout (3min, no new messages) triggers abort; session reaper (15min, no generator activity) triggers proactive summarize then reap.

**Three-Consumer Split** (shared `pending_messages` queue): (1) Observer — main Claude SDK, observation-only via `claimNextObservationBatch()`; (2) Bypass lane (`BypassLane.ts`) — parallel direct REST for observations when `CLAUDE_MEM_PROVIDER != 'claude'`; (3) Summary lane (`SummaryLane.ts`) — global single consumer for summarize rows via `claimNextSummarize()`, runs on a fresh SDK subprocess. Terminated sessions: `markAllSessionMessagesAbandoned` → cleanup. No fallback agents.

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

**Session close & drain**: `deleteSession()` is immediate-finalize (`closeSession()` + `finalizeSession()`); the legacy drain was removed when `SummaryLane` took over the summarize lifecycle — pending `summarize` rows stay in `pending_messages` and are consumed async. The only drain now lives in `SummaryLane`: it polls every 500ms (`DRAIN_POLL_MS`) up to a 30s timeout (`DRAIN_TIMEOUT_MS`) for outstanding observation rows before running the fresh summarize (accept-loss-on-timeout).
