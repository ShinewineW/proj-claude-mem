/**
 * BypassLane: Parallel REST provider consumer
 *
 * Runs alongside the main Claude SDK channel, claiming observation messages
 * from the same pending_messages queue. Uses Gemini or OpenRouter REST API
 * for one-shot processing (no conversation history).
 *
 * State machine: DISABLED → ACTIVE → TRIPPED → (probe) → ACTIVE
 * Circuit breaker: 3 consecutive failures → cooldown → probe recovery
 *
 * Ownership model: competing consumers (NOT load balancer).
 * Main lane wins most fresh messages; bypass absorbs backlog.
 * See architecture-details.md § Message Ownership Model.
 *
 * Key isolation from main channel:
 * - Does NOT touch session.processingMessageIds (avoids race with main channel)
 * - READS session.conversationHistory via truncateHistory() sliding window
 * - WRITES to session.conversationHistory after successful processing
 * - Uses parseObservations() + storeObservations() + confirmProcessed() directly
 *   instead of processAgentResponse() which modifies shared session state
 */

import { SettingsDefaultsManager } from "../../shared/SettingsDefaultsManager.js";
import { getCredential } from "../../shared/EnvManager.js";
import { USER_SETTINGS_PATH } from "../../shared/paths.js";
import { logger } from "../../utils/logger.js";
import { parseObservations } from "../../sdk/parser.js";
import { buildObservationPrompt } from "../../sdk/prompts.js";
import type { ActiveSession, ConversationMessage } from "../worker-types.js";
import type { PersistentPendingMessage } from "../sqlite/PendingMessageStore.js";
import type { SessionManager } from "./SessionManager.js";
import type { DatabaseManager } from "./DatabaseManager.js";
import { storeBypassObservationsForSession } from "./bypass-observation-store.js";

// API endpoints
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1/models";
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENCODE_API_URL = "https://opencode.ai/zen/go/v1/chat/completions";
// Must be < STALE_PROCESSING_THRESHOLD_MS (60s in PendingMessageStore) to prevent
// the main channel's self-healing from resetting a bypass in-flight message to 'pending',
// which would cause double-processing.
const FETCH_TIMEOUT_MS = 45_000;
// Gemini free tier: 15 RPM = minimum 4s between requests
const GEMINI_RATE_LIMIT_INTERVAL_MS = 4_000;
// Sliding window defaults for bypass conversation history
const DEFAULT_MAX_CONTEXT_MESSAGES = 20;
const DEFAULT_MAX_ESTIMATED_TOKENS = 100_000;
const CHARS_PER_TOKEN_ESTIMATE = 4;

// Tiered cooldowns for failure classification (opencode-driven, applies on opencode path only).
// `transient` reuses the configurable default (`config.cooldownMs`, 20min by default).
// `quota`/`auth` are long-tail failures where a 20min retry is wasteful — set to 6h.
// `client` (HTTP 400 / ModelError) is a code bug, not a provider issue, so it bypasses the breaker entirely.
export const QUOTA_COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const AUTH_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export type BypassFailureCategory = "quota" | "auth" | "transient" | "client";

/**
 * Parse an error response body, handling both error envelope shapes observed
 * in production probes against OpenCode Go:
 *   - Anthropic-style: {type:"error", error:{type, message}}
 *   - OpenAI-style:    {error:{type, code, message, param}}
 * Returns an empty object for unparseable bodies.
 */
export function parseBypassErrorBody(body: string): {
  type?: string;
  code?: string;
  message?: string;
} {
  if (!body) return {};
  try {
    const j = JSON.parse(body) as any;
    // Anthropic-style: outer type:"error", inner error object
    if (j?.type === "error" && j.error && typeof j.error === "object") {
      return {
        type: j.error.type,
        message: j.error.message,
      };
    }
    // OpenAI-style: flat error object with code field
    if (j?.error && typeof j.error === "object") {
      return {
        type: j.error.type,
        code: j.error.code,
        message: j.error.message,
      };
    }
  } catch {
    // fall through
  }
  return {};
}

/**
 * Classify a failure given HTTP status + parsed envelope. Envelope hints take
 * priority over status because OpenCode returns 401 for unknown-model errors
 * (a client bug, not auth), so naive status-bucketing would mis-classify.
 */
export function classifyBypassFailure(
  status: number,
  parsed: { type?: string; code?: string },
): BypassFailureCategory {
  // High-confidence envelope signals (don't trust status alone)
  if (parsed.code === "insufficient_quota" || parsed.type === "insufficient_quota") return "quota";
  if (parsed.type === "AuthError") return "auth";
  if (parsed.type === "ModelError") return "client"; // our bug — don't trip breaker
  // Fall back to status code
  if (status === 429 || status === 402) return "quota";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "transient";
  if (status >= 400) return "client"; // 400 = malformed body, our bug
  return "transient";
}

export type BypassState = "DISABLED" | "ACTIVE" | "TRIPPED";

export interface BypassStatus {
  state: BypassState;
  provider: string | null;
  model: string | null;
  activeConsumers: number;
  consecutiveFailures: number;
  totalClaimed: number;
  totalSucceeded: number;
  totalFailed: number;
  totalTrips: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastTripAt: string | null;
  lastProbeAt: string | null;
  lastFailureReason: string | null;
  // OpenCode Go subscription channel evidence: when cost === "0" the call
  // was billed against subscription quota, not pay-per-token balance.
  // Populated only on provider=opencode successful completions.
  lastOpencodeCost: string | null;
  lastOpencodeCostAt: string | null;
  // Count of opencode completions with cost === "0" since worker start.
  // Non-zero confirms subscription channel is in use.
  opencodeFreeCalls: number;
}

interface BypassConfig {
  provider: "gemini" | "openrouter" | "opencode";
  apiKey: string;
  model: string;
  cooldownMs: number;
}

interface ProbeResult {
  ok: boolean;
  failureReason?: string;
}

export class BypassLane {
  private state: BypassState = "DISABLED";
  private consecutiveFailures = 0;
  private readonly maxFailures = 3;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private activeConsumers = new Map<number, AbortController>();
  private config: BypassConfig | null = null;
  private lastGeminiRequestTime = 0;
  private lastFailureReason: string | null = null;
  // In-memory counters — reset on worker restart. Operational diagnostics only.
  private counters = {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    trips: 0,
    lastSuccessAt: null as string | null,
    lastFailureAt: null as string | null,
    lastTripAt: null as string | null,
    lastProbeAt: null as string | null,
    lastOpencodeCost: null as string | null,
    lastOpencodeCostAt: null as string | null,
    opencodeFreeCalls: 0,
  };

  // Injected after construction (avoids circular dep with WorkerService)
  private sessionManager: SessionManager | null = null;
  private dbManager: DatabaseManager | null = null;

  /** Wire dependencies (called from WorkerService constructor). */
  setDependencies(
    sessionManager: SessionManager,
    dbManager: DatabaseManager,
  ): void {
    this.sessionManager = sessionManager;
    this.dbManager = dbManager;
  }

  /** Read settings and determine bypass config. Returns null if bypass not applicable. */
  private resolveConfig(): BypassConfig | null {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    const provider = settings.CLAUDE_MEM_PROVIDER;
    if (provider === "claude" || !provider) return null;

    const cooldownMs =
      parseInt(settings.CLAUDE_MEM_BYPASS_COOLDOWN_MS) || 1200000;

    if (provider === "gemini") {
      const apiKey =
        settings.CLAUDE_MEM_GEMINI_API_KEY ||
        getCredential("GEMINI_API_KEY") ||
        "";
      if (!apiKey) return null;
      const model = settings.CLAUDE_MEM_GEMINI_MODEL || "gemini-2.5-flash-lite";
      return { provider: "gemini", apiKey, model, cooldownMs };
    }

    if (provider === "openrouter") {
      const apiKey =
        settings.CLAUDE_MEM_OPENROUTER_API_KEY ||
        getCredential("OPENROUTER_API_KEY") ||
        "";
      if (!apiKey) return null;
      const model =
        settings.CLAUDE_MEM_OPENROUTER_MODEL || "minimax/minimax-m2.5:free";
      return { provider: "openrouter", apiKey, model, cooldownMs };
    }

    if (provider === "opencode") {
      const apiKey =
        settings.CLAUDE_MEM_OPENCODE_API_KEY ||
        getCredential("OPENCODE_API_KEY") ||
        "";
      if (!apiKey) return null;
      const model =
        settings.CLAUDE_MEM_OPENCODE_MODEL || "deepseek-v4-flash";
      return { provider: "opencode", apiKey, model, cooldownMs };
    }

    return null;
  }

  /** Initialize: check conditions, run probe, transition to ACTIVE if successful. */
  async initialize(): Promise<void> {
    this.config = this.resolveConfig();
    if (!this.config) {
      logger.info(
        "BYPASS",
        "Bypass lane disabled (provider=claude or no API key)",
      );
      return;
    }

    logger.info(
      "BYPASS",
      `Probing ${this.config.provider} for bypass lane activation`,
      {
        model: this.config.model,
      },
    );

    const probe = await this.probeProvider();
    if (probe.ok) {
      this.transitionToActive("init");
    } else {
      this.lastFailureReason = probe.failureReason ?? null;
      logger.warn("BYPASS", "Initial probe failed, scheduling retry", {
        provider: this.config.provider,
        reason: probe.failureReason,
      });
      this.scheduleCooldownProbe();
    }
  }

  getState(): BypassState {
    return this.state;
  }
  isActive(): boolean {
    return this.state === "ACTIVE";
  }

  getStatus(): BypassStatus {
    return {
      state: this.state,
      provider: this.config?.provider ?? null,
      model: this.config?.model ?? null,
      activeConsumers: this.activeConsumers.size,
      consecutiveFailures: this.consecutiveFailures,
      totalClaimed: this.counters.claimed,
      totalSucceeded: this.counters.succeeded,
      totalFailed: this.counters.failed,
      totalTrips: this.counters.trips,
      lastSuccessAt: this.counters.lastSuccessAt,
      lastFailureAt: this.counters.lastFailureAt,
      lastTripAt: this.counters.lastTripAt,
      lastProbeAt: this.counters.lastProbeAt,
      lastFailureReason: this.lastFailureReason,
      lastOpencodeCost: this.counters.lastOpencodeCost,
      lastOpencodeCostAt: this.counters.lastOpencodeCostAt,
      opencodeFreeCalls: this.counters.opencodeFreeCalls,
    };
  }

  private transitionToActive(source: "init" | "recovery"): void {
    this.state = "ACTIVE";
    this.consecutiveFailures = 0;
    this.lastFailureReason = null;
    logger.success("BYPASS", `Bypass lane ACTIVE (${source})`, {
      provider: this.config?.provider,
      model: this.config?.model,
    });
    this.restartConsumersForActiveSessions();
  }

  /** Start bypass consumer for a session. No-op if not ACTIVE. */
  startForSession(session: ActiveSession): void {
    if (this.state !== "ACTIVE") return;
    // Check aborted state, not just presence — after stopForSession() aborts the old controller,
    // the map entry persists until .finally() runs. Using has() alone would block the new consumer.
    const existing = this.activeConsumers.get(session.sessionDbId);
    if (existing && !existing.signal.aborted) return;

    const ownAc = new AbortController();
    this.activeConsumers.set(session.sessionDbId, ownAc);

    // P6: Combine bypass's own AbortController with session's AbortController.
    // When SessionRoutes aborts the session, the bypass consumer also stops,
    // even though SessionRoutes has no reference to BypassLane.
    const combinedSignal = AbortSignal.any([
      ownAc.signal,
      session.abortController.signal,
    ]);

    this.consumeLoop(session, combinedSignal)
      .catch((error) => {
        if (!combinedSignal.aborted) {
          logger.error(
            "BYPASS",
            "Consumer loop error",
            {
              sessionDbId: session.sessionDbId,
            },
            error as Error,
          );
        }
      })
      .finally(() => {
        this.activeConsumers.delete(session.sessionDbId);
      });
  }

  /** Stop bypass consumer for a session. */
  stopForSession(sessionDbId: number): void {
    const ac = this.activeConsumers.get(sessionDbId);
    if (ac) {
      ac.abort();
      // Do NOT delete here — .finally() in startForSession handles cleanup.
      // Eagerly deleting causes a race: if startForSession runs before .finally(),
      // the new entry gets deleted by the old consumer's .finally() callback.
    }
  }

  /** Shutdown: stop all consumers, clear timers. */
  shutdown(): void {
    for (const [, ac] of this.activeConsumers) {
      ac.abort();
    }
    this.activeConsumers.clear();
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    this.state = "DISABLED";
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.counters.succeeded++;
    this.counters.lastSuccessAt = new Date().toISOString();
  }

  private recordFailure(category?: BypassFailureCategory): void {
    // `client` category = our code bug (HTTP 400 / ModelError). Retries won't help
    // and tripping the breaker masks the bug. Don't count toward the breaker.
    if (category === "client") {
      this.counters.failed++;
      this.counters.lastFailureAt = new Date().toISOString();
      return;
    }
    this.consecutiveFailures++;
    this.counters.failed++;
    this.counters.lastFailureAt = new Date().toISOString();
    if (this.consecutiveFailures >= this.maxFailures) {
      this.tripCircuitBreaker(category);
    }
  }

  private tripCircuitBreaker(category?: BypassFailureCategory): void {
    this.state = "TRIPPED";
    this.counters.trips++;
    this.counters.lastTripAt = new Date().toISOString();
    // Pick cooldown based on failure category. Auth/quota are long-tail
    // (config issue / monthly quota), so short 20min retries are wasteful.
    let cooldownMs: number | undefined;
    if (category === "quota") cooldownMs = QUOTA_COOLDOWN_MS;
    else if (category === "auth") cooldownMs = AUTH_COOLDOWN_MS;
    logger.warn(
      "BYPASS",
      `Circuit breaker TRIPPED after ${this.consecutiveFailures} consecutive failures`,
      {
        category: category ?? "unknown",
        cooldownMs: cooldownMs ?? this.config?.cooldownMs,
      },
    );
    this.scheduleCooldownProbe(cooldownMs);
  }

  private scheduleCooldownProbe(cooldownOverrideMs?: number): void {
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    const cooldownMs =
      cooldownOverrideMs ?? this.config?.cooldownMs ?? 1200000;
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      this.attemptRecovery().catch((error) => {
        logger.warn("BYPASS", "Recovery probe error", {}, error as Error);
      });
    }, cooldownMs);
  }

  private async attemptRecovery(): Promise<void> {
    logger.info("BYPASS", "Attempting recovery probe");
    const probe = await this.probeProvider();
    if (probe.ok) {
      this.transitionToActive("recovery");
    } else {
      this.lastFailureReason = probe.failureReason ?? null;
      logger.warn("BYPASS", "Recovery probe failed, restarting cooldown", {
        reason: probe.failureReason,
      });
      this.scheduleCooldownProbe();
    }
  }

  /** Restart bypass consumers for all active sessions (after circuit breaker recovery). */
  private restartConsumersForActiveSessions(): void {
    if (!this.sessionManager) return;
    let count = 0;
    for (const session of this.sessionManager.getActiveSessions()) {
      if (!this.activeConsumers.has(session.sessionDbId)) {
        this.startForSession(session);
        count++;
      }
    }
    if (count > 0) {
      logger.info(
        "BYPASS",
        `Restarted consumers for ${count} active session(s) after recovery`,
      );
    }
  }

  /** Probe provider health with a lightweight API call. */
  private async probeProvider(): Promise<ProbeResult> {
    if (!this.config) return { ok: false, failureReason: "no config" };
    this.counters.lastProbeAt = new Date().toISOString();

    try {
      const signal = AbortSignal.timeout(15_000);
      let response: Response;

      if (this.config.provider === "gemini") {
        const url = `${GEMINI_API_URL}/${this.config.model}:generateContent?key=${this.config.apiKey}`;
        response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "Reply with OK" }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 10 },
          }),
          signal,
        });
      } else if (this.config.provider === "openrouter") {
        // Must include HTTP-Referer — some upstream providers (e.g. StepFun behind Alibaba WAF)
        // reject requests without it, causing the probe to always fail and bypass to stay DISABLED.
        response = await fetch(OPENROUTER_API_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "HTTP-Referer": "https://github.com/ShinewineW/proj-claude-mem",
            "X-Title": "claude-mem",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.config.model,
            messages: [{ role: "user", content: "Reply with OK" }],
            max_tokens: 10,
          }),
          signal,
        });
      } else {
        // OpenCode Go: OpenAI-compatible probe. Must include `thinking:disabled`,
        // otherwise reasoning models burn max_tokens=10 on internal CoT and emit
        // empty content → probe fails. Skip OpenRouter-specific headers.
        response = await fetch(OPENCODE_API_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.config.model,
            messages: [{ role: "user", content: "Reply with OK" }],
            max_tokens: 10,
            thinking: { type: "disabled" },
          }),
          signal,
        });
      }

      if (response.ok) return { ok: true };
      return {
        ok: false,
        failureReason: `HTTP ${response.status} ${response.statusText}`,
      };
    } catch (error) {
      // DOMException with name 'AbortError' or 'TimeoutError' indicates probe timeout
      const isTimeout =
        error instanceof DOMException &&
        (error.name === "AbortError" || error.name === "TimeoutError");
      if (isTimeout) {
        return { ok: false, failureReason: "timeout (15s)" };
      }
      const reason = error instanceof Error ? error.message : "unknown error";
      const sanitized = reason.replace(/key=[^&\s]+/g, "key=***").slice(0, 200);
      return { ok: false, failureReason: sanitized };
    }
  }

  /** Abort-aware sleep: resolves on timeout OR signal abort (whichever first). */
  private abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  /** Truncate conversation history to fit within message count and token limits. */
  private truncateHistory(
    history: ConversationMessage[],
  ): ConversationMessage[] {
    if (history.length === 0) return [];

    // BypassLane history budget is fixed at module-level constants.
    // CLAUDE_MEM_BYPASS_MAX_* env vars were never wired through SettingsDefaultsManager
    // (not in DEFAULTS → applyEnvOverrides skips them). Removed 2026-04-08 to eliminate
    // misleading dead code. If you need tunable limits, file a feature ticket and add
    // the keys to SettingsDefaults properly with validation + viewer UI.
    const maxMessages = DEFAULT_MAX_CONTEXT_MESSAGES;
    const maxTokens = DEFAULT_MAX_ESTIMATED_TOKENS;

    // Quick exit: within both limits (return copy to avoid shared reference mutation)
    const totalTokens = history.reduce(
      (sum, m) => sum + Math.ceil(m.content.length / CHARS_PER_TOKEN_ESTIMATE),
      0,
    );
    if (history.length <= maxMessages && totalTokens <= maxTokens) {
      return history.slice();
    }

    // Sliding window: iterate from most recent backward
    const truncated: ConversationMessage[] = [];
    let tokenCount = 0;

    for (let i = history.length - 1; i >= 0; i--) {
      const msgTokens = Math.ceil(
        history[i].content.length / CHARS_PER_TOKEN_ESTIMATE,
      );
      if (truncated.length >= maxMessages) break;
      if (tokenCount + msgTokens > maxTokens) break;
      truncated.unshift(history[i]);
      tokenCount += msgTokens;
    }

    // Fallback: always include at least the most recent message, even if it exceeds the budget.
    // This prevents silently degrading to zero-context one-shot when a single message is large.
    if (truncated.length === 0 && history.length > 0) {
      truncated.push(history[history.length - 1]);
      logger.warn(
        "BYPASS",
        `Most recent history message exceeds token budget, including as last resort`,
      );
    } else if (truncated.length < history.length) {
      logger.debug(
        "BYPASS",
        `History truncated: ${history.length} → ${truncated.length} messages, ~${tokenCount} tokens`,
      );
    }

    return truncated;
  }

  /** Main consumer loop — claims observation messages, processes via REST API. */
  private async consumeLoop(
    session: ActiveSession,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.sessionManager || !this.dbManager) return;

    const pendingStore = this.sessionManager.getPendingMessageStore(
      session.dbPath,
    );
    const POLL_MS = 500;

    while (!signal.aborted && this.state === "ACTIVE") {
      // Observation-only claim (never summarize, no self-healing — main channel handles that)
      const message = pendingStore.claimNextObservation(session.sessionDbId);

      if (!message) {
        await this.abortableSleep(POLL_MS, signal);
        continue;
      }

      this.counters.claimed++;

      // Wait for main channel to establish memorySessionId (avoid orphaned synthetic IDs)
      if (!session.memorySessionId) {
        pendingStore.retryMessage(message.id);
        this.sessionManager!.notifyMessageAvailable(
          session.sessionDbId,
          session.dbPath,
        );
        logger.debug("BYPASS", "Waiting for memorySessionId", {
          messageId: message.id,
        });
        await this.abortableSleep(POLL_MS, signal);
        continue;
      }

      // Capture before async call — main channel could clear/replace it mid-flight
      const memorySessionId = session.memorySessionId!;

      try {
        const obsStats = await this.processObservation(
          message,
          session,
          memorySessionId,
          signal,
        );
        this.recordSuccess();
        logger.info("BYPASS", "Observation processed", {
          messageId: message.id,
          sessionDbId: session.sessionDbId,
          provider: this.config?.provider,
          truncatedFields: obsStats.truncatedFields,
        });

        // F5 fix: Rate limiting for Gemini free tier (15 RPM = 4s interval)
        if (this.config?.provider === "gemini") {
          const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
          if (settings.CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED === "true") {
            const now = Date.now();
            const elapsed = now - this.lastGeminiRequestTime;
            this.lastGeminiRequestTime = now;
            // Math.min caps delay to prevent unbounded sleep on clock skew
            const delay = Math.min(
              GEMINI_RATE_LIMIT_INTERVAL_MS,
              Math.max(0, GEMINI_RATE_LIMIT_INTERVAL_MS - elapsed),
            );
            if (delay > 0) {
              await this.abortableSleep(delay, signal);
            }
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        // Extract bypassCategory if attached by callRestApi (opencode path only).
        const category = (error as { bypassCategory?: BypassFailureCategory })
          ?.bypassCategory;
        logger.warn("BYPASS", "Processing failed, marking for retry", {
          messageId: message.id,
          category: category ?? "unknown",
          error: error instanceof Error ? error.message : String(error),
        });
        pendingStore.markFailed(message.id);
        this.sessionManager!.notifyMessageAvailable(
          session.sessionDbId,
          session.dbPath,
        );
        this.lastFailureReason = (
          error instanceof Error ? error.message : String(error)
        ).slice(0, 200);
        this.recordFailure(category);
        await this.abortableSleep(1000, signal);
        if (this.state === "TRIPPED") return;
      }
    }
  }

  /** Process a single observation message via REST API. */
  private async processObservation(
    message: PersistentPendingMessage,
    session: ActiveSession,
    memorySessionId: string,
    signal: AbortSignal,
  ): Promise<{ truncatedFields: number }> {
    if (!this.config || !this.dbManager || !this.sessionManager) {
      throw new Error("BypassLane not configured");
    }

    // tool_input/tool_response are already JSON strings from PendingMessageStore.enqueue(),
    // and buildObservationPrompt internally JSON.parses them — pass through directly.
    const bypassSettings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const obsMaxFieldChars =
      parseInt(bypassSettings.CLAUDE_MEM_OBS_MAX_FIELD_CHARS, 10) || 8000;
    const { prompt: obsPrompt, truncatedFields } = buildObservationPrompt(
      {
        id: 0,
        tool_name: message.tool_name!,
        tool_input: message.tool_input || "{}",
        tool_output: message.tool_response || "{}",
        created_at_epoch: message.created_at_epoch,
        cwd: message.cwd || undefined,
      },
      obsMaxFieldChars,
    );

    // System prompt — MUST include valid type list to prevent parser fallback
    const systemPrompt =
      "You are a code observation extractor. Analyze the tool usage and output structured observations in XML format. " +
      "Output ONLY <observation> tags. Valid type values: discovery, bugfix, feature, change, refactor, decision. " +
      "Fields: type, title, subtitle, facts (with <fact> children), narrative, concepts (with <concept> children), " +
      "files_read (with <file> children), files_modified (with <file> children).";

    // Read conversation history with sliding window truncation
    // NOTE: previousMemorySessionId summary injection is handled by SDKAgent only.
    // Bypass relies on truncateHistory for context; having it also consume
    // previousMemorySessionId would race with SDKAgent (HIGH finding from audit).
    const truncatedHistory = this.truncateHistory(
      session.conversationHistory || [],
    );

    // Call REST API with conversation history context
    const fetchSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(FETCH_TIMEOUT_MS),
    ]);
    const responseText = await this.callRestApi(
      obsPrompt,
      systemPrompt,
      fetchSignal,
      truncatedHistory,
    );

    if (!responseText) {
      throw new Error("Empty response from bypass provider");
    }

    // Parse observations from XML response
    const observations = parseObservations(
      responseText,
      session.contentSessionId,
    );

    // F1 fix: Throw on empty observations — consumeLoop catch calls markFailed + recordFailure.
    // After 3 failures, circuit breaker trips and main channel takes over.
    if (observations.length === 0) {
      throw new Error("No observations parsed from bypass response");
    }

    // Store observations in DB (atomic).
    // Re-reads memory_session_id from sdk_sessions inside the transaction —
    // see bypass-observation-store.ts for the FK-race motivation. The
    // captured `memorySessionId` above may be stale if PROACTIVE_RESET rotated
    // it while the bypass LLM call was in flight.
    const sessionStore = this.dbManager.getSessionStore(session.dbPath);
    const result = storeBypassObservationsForSession(
      sessionStore,
      session.sessionDbId,
      observations,
      {
        promptNumber: message.prompt_number || undefined,
        overrideTimestampEpoch: message.created_at_epoch,
        contentSessionId: session.contentSessionId,
      },
    );

    if (!result) {
      // sdk_sessions row gone or memory_session_id not yet set —
      // treat as transient, let consumeLoop's catch path mark for retry.
      throw new Error(
        "Bypass observation insert skipped: sdk_sessions row missing or memory_session_id unset",
      );
    }

    // Use the memory_session_id actually committed (which may differ from the
    // T0 capture if observer rotated it mid-flight), for Chroma sync coherence.
    const committedMemorySessionId = result.memorySessionId;

    // Chroma sync (fire-and-forget)
    const chromaSync = this.dbManager.getChromaSync(session.dbPath);
    if (chromaSync) {
      for (let i = 0; i < observations.length; i++) {
        const obsId = result.observationIds[i];
        chromaSync
          .syncObservation(
            obsId,
            committedMemorySessionId,
            session.project,
            observations[i],
            message.prompt_number || 0,
            result.createdAtEpoch,
          )
          .catch(() => {}); // Fire-and-forget
      }
    }

    // Confirm message processed (delete from queue)
    const pendingStore = this.sessionManager.getPendingMessageStore(
      session.dbPath,
    );
    pendingStore.confirmProcessed(message.id);

    // Write back to shared conversation history (bypass contributes to union history)
    if (session.conversationHistory) {
      session.conversationHistory.push({ role: "user", content: obsPrompt });
      session.conversationHistory.push({
        role: "assistant",
        content: responseText,
      });
    }

    return { truncatedFields };
  }

  /** Call Gemini or OpenRouter REST API. Returns response text. */
  private async callRestApi(
    prompt: string,
    systemPrompt: string,
    signal: AbortSignal,
    history: ConversationMessage[] = [],
  ): Promise<string> {
    if (!this.config) throw new Error("BypassLane not configured");

    if (this.config.provider === "gemini") {
      const url = `${GEMINI_API_URL}/${this.config.model}:generateContent?key=${this.config.apiKey}`;
      // Build contents with history context (Gemini uses 'model' for assistant role)
      const contents = [
        ...history.map((m) => ({
          role: m.role === "assistant" ? ("model" as const) : ("user" as const),
          parts: [{ text: m.content }],
        })),
        { role: "user" as const, parts: [{ text: prompt }] },
      ];
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: systemPrompt }] },
          generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
        }),
        signal,
      });

      if (!response.ok) {
        // Sanitize error text: Gemini may echo the URL (including API key) in error responses
        const errorText = (await response.text()).replace(
          /key=[^&\s"]+/g,
          "key=REDACTED",
        );
        throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
      }

      const data = (await response.json()) as any;
      return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    } else if (this.config.provider === "openrouter") {
      const response = await fetch(OPENROUTER_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "HTTP-Referer": "https://github.com/ShinewineW/proj-claude-mem",
          "X-Title": "claude-mem",
          "Content-Type": "application/json",
        },
        // Build messages array with history context
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: "system", content: systemPrompt },
            ...history.map((m) => ({ role: m.role, content: m.content })),
            { role: "user", content: prompt },
          ],
          temperature: 0.3,
          max_tokens: 8192,
        }),
        signal,
      });

      if (!response.ok) {
        // Truncate error body to prevent accidental credential echo in logs
        const errorText = (await response.text()).substring(0, 500);
        throw new Error(
          `OpenRouter API error: ${response.status} - ${errorText}`,
        );
      }

      const data = (await response.json()) as any;
      return data?.choices?.[0]?.message?.content || "";
    } else {
      // OpenCode Go: OpenAI-compatible. Send thinking:disabled to keep reasoning
      // models (deepseek-v4-flash etc.) emitting content instead of CoT-only output.
      const response = await fetch(OPENCODE_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: "system", content: systemPrompt },
            ...history.map((m) => ({ role: m.role, content: m.content })),
            { role: "user", content: prompt },
          ],
          temperature: 0.3,
          max_tokens: 8192,
          thinking: { type: "disabled" },
        }),
        signal,
      });

      if (!response.ok) {
        // Truncate to prevent accidental credential echo
        const errorText = (await response.text()).substring(0, 500);
        const parsed = parseBypassErrorBody(errorText);
        const category = classifyBypassFailure(response.status, parsed);
        const err = new Error(
          `OpenCode API error: ${response.status} - ${errorText}`,
        ) as Error & { bypassCategory: BypassFailureCategory };
        err.bypassCategory = category;
        throw err;
      }

      const data = (await response.json()) as any;
      // OpenCode Go reports `cost` as a string ("0" for subscription-billed
      // calls, positive USD for balance-fallback). Capture it so the viewer
      // can display evidence of the subscription channel in use.
      if (typeof data?.cost === "string") {
        this.counters.lastOpencodeCost = data.cost;
        this.counters.lastOpencodeCostAt = new Date().toISOString();
        if (data.cost === "0") this.counters.opencodeFreeCalls++;
      }
      return data?.choices?.[0]?.message?.content || "";
    }
  }
}
