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

**Multi-Provider**: Shared `conversationHistory` on `ActiveSession` enables switching providers mid-session. Fallback: Gemini/OpenRouter → Claude on API failure.

**Drain Window**: `deleteSession()` polls `hasPendingSummarize()` every 500ms (max 10s) before aborting, preventing summary loss on session close.
