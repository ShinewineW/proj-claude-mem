# Bypass Lane: REST Provider Parallel Processing

## Problem

Claude-mem processes all messages through a single provider sequentially per session. When the primary provider (Claude SDK subprocess) stalls or the message rate exceeds processing capacity, messages accumulate in `pending_messages`, causing frontend hang indicators and eventual cascade failures (zombie processes, dead letters, pool exhaustion).

Previous fixes addressed symptoms (watchdog timers, pool reclamation, dead letter retry) but not the root cause: **single-provider bottleneck**.

## Solution

Add a **bypass lane** — an independent consumer that processes messages in parallel using a REST-based provider (Gemini or OpenRouter), while the main channel continues using Claude SDK unchanged.

```
Hook → enqueue(sessionDbId, msg) → pending_messages table
                                        ↑ competing consumers
                    ┌───────────────────┤
                    │                   │
          Main channel              Bypass lane
          (Claude SDK)              (REST provider)
          4 pool slots              1 concurrent
          Always runs               Only when configured
          Unchanged                 New
```

## Design Decisions

### D1: Main channel is always Claude SDK

Claude SDK is the most stable provider (paid, no rate limits, subprocess-based). It remains the primary processing path regardless of `CLAUDE_MEM_PROVIDER` setting.

**Semantic change**: `CLAUDE_MEM_PROVIDER` shifts from "select primary provider" to "select bypass provider":
- `claude` (default) = no bypass, SDK-only (current behavior)
- `gemini` = enable Gemini bypass lane
- `openrouter` = enable OpenRouter bypass lane

**Breaking behavioral change**: existing `CLAUDE_MEM_PROVIDER=openrouter` configs will continue to function, but the semantics invert — from "OpenRouter primary + SDK fallback" to "SDK primary + OpenRouter bypass." This is an intentional design choice: free-tier REST providers are unreliable and should not be the primary processing path. Users upgrading will experience improved stability (SDK-first) with optional throughput boost (REST bypass). The setting name is preserved to avoid config migration, but the behavior change must be documented in release notes.

### D2: Bypass lane concurrency = 1, not configurable

REST providers (free tier) are unreliable. One concurrent bypass consumer is sufficient to offload ~25-30% of messages without overwhelming free tier quotas. Hardcoded to 1.

### D3: Main pool stays at 4 slots

No changes to `CLAUDE_MEM_MAX_CONCURRENT_AGENTS` or `ProcessRegistry`. The bypass lane uses REST (no subprocess), so it doesn't interact with the pool at all.

### D4: Competing consumers on same queue

Both main channel and bypass lane call `claimNextMessage(sessionDbId)` on the same `pending_messages` table. The existing atomic claim-confirm pattern (SQLite transaction: SELECT → UPDATE in one tx) naturally prevents duplicate processing. No changes to `PendingMessageStore`.

### D5: Circuit breaker with configurable cooldown

Bypass lane tracks consecutive failures. After N consecutive failures (default: 3), the lane enters **circuit breaker** state:
- Stops consuming messages
- Waits for cooldown period (default: 20 minutes, configurable via `CLAUDE_MEM_BYPASS_COOLDOWN_MS`)
- Sends a single probe request to verify provider health
- Success → resume bypass; Failure → restart cooldown timer

## Activation Conditions

Bypass lane starts only when ALL conditions are met:
1. `CLAUDE_MEM_PROVIDER` is not `'claude'`
2. Corresponding API key is configured (Gemini key or OpenRouter key)
3. Worker startup probe request succeeds (single lightweight API call)

If any condition fails → no bypass, pure SDK processing (graceful degradation).

## Message Flow

### Normal operation (bypass active)

```
1. Hook fires → SessionRoutes enqueues message → pending_messages (status=pending)
2. Main channel generator claims message → claimNextMessage() → processing → SDK
3. Bypass lane claims message → claimNextMessage() → processing → REST provider
   (whichever claims first wins — SQLite transaction ensures no duplicates)
4. Processing complete → confirmProcessed() → message deleted
```

### Bypass failure

```
1. Bypass claims message → REST call fails
2. Message status reset to 'pending' (existing retryOrFail mechanism)
3. Main channel claims it on next iteration
4. If consecutive failures >= 3 → circuit breaker trips → bypass stops
5. After 20min cooldown → probe → success? resume : restart cooldown
```

### Bypass disabled

```
All messages → Main channel only (identical to current behavior)
```

## New Components

### `BypassLane` class (`src/services/worker/BypassLane.ts`)

Responsibilities:
- Manage bypass consumer lifecycle (start/stop)
- Track consecutive failures, trigger circuit breaker
- Manage cooldown timer and probe recovery
- Select bypass agent based on `CLAUDE_MEM_PROVIDER` setting

Interface:
```typescript
class BypassLane {
  constructor(geminiAgent: GeminiAgent, openRouterAgent: OpenRouterAgent, dbManager: DatabaseManager)

  /** Start bypass consumer for a session. No-op if bypass not available. */
  startForSession(session: ActiveSession): void

  /** Stop bypass consumer for a session. */
  stopForSession(sessionDbId: number): void

  /** Whether bypass is currently active (not in circuit breaker). */
  isActive(): boolean

  /** Shutdown: stop all consumers, clear timers. */
  shutdown(): void
}
```

State machine:
```
DISABLED ──(conditions met)──→ ACTIVE ──(N failures)──→ TRIPPED
    ↑                            ↑                         │
    │                            └────(probe success)──────┘
    │                                                      │
    └──────────────────(probe failure, conditions unmet)───┘
                                    (cooldown wait)
```

## Settings Changes

| Setting | Default | Description |
|---------|---------|-------------|
| `CLAUDE_MEM_BYPASS_COOLDOWN_MS` | `1200000` (20min) | Cooldown period before retrying tripped bypass |

Existing settings with changed semantics:

| Setting | Old meaning | New meaning |
|---------|-------------|-------------|
| `CLAUDE_MEM_PROVIDER` | Select primary provider | Select bypass provider (`claude` = no bypass) |

## Files Changed

| File | Change | Size |
|------|--------|------|
| **New** `src/services/worker/BypassLane.ts` | Bypass lane class | ~120-150 lines |
| `src/services/worker-service.ts` | Initialize BypassLane; `getActiveAgent()` always returns SDK | ~20 lines changed |
| `src/services/worker/http/routes/SessionRoutes.ts` | `getActiveAgent()` always returns SDK | ~10 lines changed |
| `src/shared/SettingsDefaultsManager.ts` | Add `CLAUDE_MEM_BYPASS_COOLDOWN_MS` | ~5 lines |
| **New** `tests/worker/bypass-lane.test.ts` | Unit tests for BypassLane | ~100-150 lines |

**Not changed**: `PendingMessageStore.ts`, `ProcessRegistry.ts`, `SessionQueueProcessor.ts`, `SessionManager.ts`

## Testing Strategy

1. **Unit tests** (`bypass-lane.test.ts`):
   - Bypass activates only when provider + API key configured
   - Bypass disabled when `CLAUDE_MEM_PROVIDER=claude`
   - Circuit breaker trips after N consecutive failures
   - Cooldown timer fires and triggers probe
   - Probe success resumes bypass; probe failure restarts cooldown
   - Competing claim: two consumers don't process same message

2. **Integration verification**:
   - Existing 1355 tests must pass unchanged (bypass is additive)
   - Manual: set `CLAUDE_MEM_PROVIDER=gemini`, observe bypass lane in logs

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Bypass consumer and main channel race on same message | SQLite atomic claim-confirm prevents duplicates; already battle-tested |
| REST provider returns garbage responses | ResponseProcessor validates output; malformed responses trigger failure path |
| Bypass lane leaks resources on shutdown | `shutdown()` clears all timers and abort controllers; called from WorkerService shutdown |
| Free tier quota exhausted mid-session | Circuit breaker stops bypass; messages fall through to main channel |
| Probe requests leak API keys in logs | Probe logs only record success/failure status, never request/response bodies or API keys. API keys injected at request time only, never stored in BypassLane state beyond agent reference |
