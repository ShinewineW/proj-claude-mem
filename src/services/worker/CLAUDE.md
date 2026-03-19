# Worker Service Subsystem

## Core Components

| File | Purpose |
|------|---------|
| `SessionManager.ts` | Session lifecycle, event-driven message queuing, drain window, orphan cleanup |
| `DatabaseManager.ts` | Adapter over `DbConnectionPool` — `getSessionStore(dbPath?)`, `getChromaSync(dbPath?)` |
| `SDKAgent.ts` | Claude subprocess via Agent SDK, observer-only, PID tracking |
| `GeminiAgent.ts` | Gemini REST API, rate limiting, fallback to Claude |
| `OpenRouterAgent.ts` | OpenRouter API, 100+ models, shared conversation history |
| `SearchManager.ts` | Search orchestration (Chroma → SQLite fallback) |
| `ProcessRegistry.ts` | Track spawned subprocess PIDs for zombie cleanup |
| `BypassLane.ts` | Parallel REST consumer for observations (Gemini/OpenRouter), circuit breaker, competing consumer on same queue |

## Subdirectories

| Dir | Purpose |
|-----|---------|
| `agents/` | `ResponseProcessor` (shared response parsing), `ObservationBroadcaster` (SSE) |
| `http/routes/` | `SessionRoutes`, `SearchRoutes`, `DataRoutes`, `MemoryRoutes`, `SettingsRoutes` |
| `search/` | `SearchOrchestrator`, strategies (Chroma/SQLite/Hybrid), filters |
| `events/` | `SessionEventBroadcaster` |
| `validation/` | `PrivacyCheckValidator` |

## Key Patterns

**Per-Project Isolation**: Every session has `dbPath` field. Routes extract from request → pass to DB methods. 3-step fallback: explicit → default → lastActive → throw.

**Event-Driven Queuing**: `EventEmitter` per session for zero-latency notifications. `PendingMessageStore` persists to DB first (crash-safe). Idle timeout (5min) triggers subprocess abort.

**Dual-Channel Processing**: Main channel always uses Claude SDK. Bypass lane (`BypassLane.ts`) processes observations in parallel via REST (Gemini/OpenRouter) when `CLAUDE_MEM_PROVIDER != 'claude'`. Competing consumers on same `pending_messages` queue via atomic `claimNextMessage()`. Fallback path: Gemini → OpenRouter → abandon (only on SDK process termination).

**Drain Window**: `deleteSession()` polls `hasPendingSummarize()` every 500ms (max 10s) before aborting, preventing summary loss on session close.
