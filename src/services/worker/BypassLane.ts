/**
 * BypassLane: Parallel REST provider consumer
 *
 * Runs alongside the main Claude SDK channel, claiming observation messages
 * from the same pending_messages queue. Uses any OpenAI-compatible provider's
 * REST API for one-shot processing (no conversation history).
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
import { GlobalSemaphore } from "./global-semaphore.js";
import { resolveOpenAICompatibleChatCompletionsUrl } from "../../shared/openai-compatible-base-url.js";
import { probeOpenAICompatible, redactSecret } from "./openai-compatible-probe.js";

// Must be < STALE_PROCESSING_THRESHOLD_MS (60s in PendingMessageStore) to prevent
// the main channel's self-healing from resetting a bypass in-flight message to 'pending',
// which would cause double-processing.
const FETCH_TIMEOUT_MS = 45_000;
// Sliding window defaults for bypass conversation history
const DEFAULT_MAX_CONTEXT_MESSAGES = 20;
const DEFAULT_MAX_ESTIMATED_TOKENS = 100_000;
const CHARS_PER_TOKEN_ESTIMATE = 4;

// Tiered cooldowns for failure classification (applies on the openai path).
// `transient`/`ratelimit` reuse the configurable default (`config.cooldownMs`, 20min by default).
// `quota`/`auth` are long-tail failures where a 20min retry is wasteful.
// `client` (HTTP 400 / ModelError) is a code bug, not a provider issue, so it bypasses the breaker entirely.
export const DEFAULT_QUOTA_COOLDOWN_MS = 30 * 60 * 1000; // 30min default (configurable)
export const DEFAULT_AUTH_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h default (configurable)
export const DEFAULT_MAX_FAILURES = 3;

/**
 * Strict bounded integer read for hand-editable settings (R2-1).
 * Same semantics as SettingsRoutes.validateSettings (Number + isInteger):
 * trailing junk / non-integers / out-of-range all degrade to the default,
 * so a settings.json typo can never wedge the semaphore or the breaker.
 */
export function readIntBounded(raw: string, def: number, lo: number, hi: number): number {
  const n = Number(String(raw ?? "").trim());
  return Number.isInteger(n) && n >= lo && n <= hi ? n : def;
}

export type BypassFailureCategory = "quota" | "auth" | "transient" | "client" | "ratelimit";

/**
 * Parse an error response body, handling both error envelope shapes observed
 * in production probes against OpenAI-compatible providers:
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
 * priority over status because some providers return 401 for unknown-model errors
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
  if (status === 429) return "ratelimit"; // bare rate-limit — short cooldown, self-heals in minutes
  if (status === 402) return "quota";     // payment required — real quota
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "transient";
  if (status >= 400) return "client"; // 400 = malformed body, our bug
  return "transient";
}

export type BypassState = "DISABLED" | "ACTIVE" | "TRIPPED";

export interface BypassStatus {
  state: BypassState;
  endpoint: string | null;  // host derived from baseUrl, e.g. "api.deepseek.com"
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
}

interface BypassConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  cooldownMs: number;
  quotaCooldownMs: number;
  authCooldownMs: number;
  maxFailures: number;
}

interface ProbeResult {
  ok: boolean;
  failureReason?: string;
}

export class BypassLane {
  private state: BypassState = "DISABLED";
  private consecutiveFailures = 0;
  private maxFailures = DEFAULT_MAX_FAILURES;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private activeConsumers = new Map<number, AbortController>();
  private config: BypassConfig | null = null;
  private lastFailureReason: string | null = null;
  // Global cap on concurrent bypass REST calls across all sessions.
  // loadFromFile has its own 5s TTL cache (SettingsDefaultsManager P3),
  // so reading per-acquire is cheap — no extra caching layer here.
  // R1-4c/R2-1: strict bounded read [1,64] — validateSettings only guards the
  // UI path; a hand-edited settings.json with "-1" would otherwise make
  // limitFn return -1 and every acquire() park forever, and an over-large
  // typo would remove the global cap entirely.
  private globalSemaphore = new GlobalSemaphore(() => {
    const s = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    return readIntBounded(s.CLAUDE_MEM_BYPASS_MAX_CONSUMERS, 6, 1, 64);
  });
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
    if (settings.CLAUDE_MEM_PROVIDER !== "openai") return null;

    // R3-1: pre-existing cooldown key reads through the same strict bounded
    // parser as the new keys, with COMPATIBILITY bounds [1s, 24h] — looser
    // floor than the new keys' 1min because legacy installs and test fixtures
    // legitimately use short values (e.g. 5000).
    const cooldownMs =
      readIntBounded(settings.CLAUDE_MEM_BYPASS_COOLDOWN_MS, 1200000, 1000, 86400000);
    const quotaCooldownMs =
      readIntBounded(settings.CLAUDE_MEM_BYPASS_QUOTA_COOLDOWN_MS, DEFAULT_QUOTA_COOLDOWN_MS, 60000, 86400000);
    const authCooldownMs =
      readIntBounded(settings.CLAUDE_MEM_BYPASS_AUTH_COOLDOWN_MS, DEFAULT_AUTH_COOLDOWN_MS, 60000, 86400000);
    const maxFailures =
      readIntBounded(settings.CLAUDE_MEM_BYPASS_MAX_FAILURES, DEFAULT_MAX_FAILURES, 1, 20);
    const apiKey = settings.CLAUDE_MEM_OPENAI_API_KEY || getCredential("OPENAI_API_KEY") || "";
    const baseUrl = (settings.CLAUDE_MEM_OPENAI_BASE_URL || "").trim();
    const model = settings.CLAUDE_MEM_OPENAI_MODEL || "";
    if (!apiKey || !baseUrl || !model) return null;
    if (!resolveOpenAICompatibleChatCompletionsUrl(baseUrl)) return null; // reject malformed early
    return { baseUrl, apiKey, model, cooldownMs, quotaCooldownMs, authCooldownMs, maxFailures };
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
    this.maxFailures = this.config.maxFailures;

    logger.info(
      "BYPASS",
      `Probing ${new URL(this.config.baseUrl).host} for bypass lane activation`,
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
        endpoint: this.config ? new URL(this.config.baseUrl).host : null,
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
      endpoint: this.config ? new URL(this.config.baseUrl).host : null,
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
    };
  }

  private transitionToActive(source: "init" | "recovery"): void {
    this.state = "ACTIVE";
    this.consecutiveFailures = 0;
    this.lastFailureReason = null;
    logger.success("BYPASS", `Bypass lane ACTIVE (${source})`, {
      endpoint: this.config ? new URL(this.config.baseUrl).host : null,
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

    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    // R2-1: strict bounded read [1,16], same semantics as validateSettings —
    // a hand-edited typo must not spawn an unbounded number of loops.
    const concurrency = readIntBounded(settings.CLAUDE_MEM_BYPASS_CONCURRENCY, 1, 1, 16);

    let running = concurrency;
    const onLoopDone = () => {
      running--;
      // M1: only delete when ALL loops exited AND the map still points to THIS ownAc.
      // A stop+restart can install a NEW ownAc before this batch drains; an unconditional
      // delete would clobber the newer controller (the race the original comment in
      // stopForSession warns of).
      if (running <= 0 && this.activeConsumers.get(session.sessionDbId) === ownAc) {
        this.activeConsumers.delete(session.sessionDbId);
      }
    };

    for (let i = 0; i < concurrency; i++) {
      this.consumeLoop(session, combinedSignal)
        .catch((error) => {
          if (!combinedSignal.aborted) {
            logger.error(
              "BYPASS",
              "Consumer loop error",
              { sessionDbId: session.sessionDbId, worker: i },
              error as Error,
            );
          }
        })
        .finally(onLoopDone);
    }
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
    if (category === "quota") cooldownMs = this.config?.quotaCooldownMs;
    else if (category === "auth") cooldownMs = this.config?.authCooldownMs;
    // ratelimit / transient fall through to config.cooldownMs via scheduleCooldownProbe
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
    const r = await probeOpenAICompatible(
      { baseUrl: this.config.baseUrl, apiKey: this.config.apiKey, model: this.config.model },
    );
    if (r.ok) return { ok: true };
    return { ok: false, failureReason: r.status ? `HTTP ${r.status} ${r.message ?? ''}`.trim() : (r.message ?? 'probe failed') };
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
      // M2: gate on memorySessionId BEFORE claiming — rows stay 'pending' untouched
      // until the main channel seeds the id; no claim→retry spin during INIT.
      if (!session.memorySessionId) {
        await this.abortableSleep(POLL_MS, signal);
        continue;
      }

      // H1: acquire a global slot BEFORE claiming, so a claimed row's 'processing'
      // window spans only the REST call (< FETCH_TIMEOUT_MS 45s < 60s self-heal),
      // never the semaphore wait.
      try {
        await this.globalSemaphore.acquire(signal);
      } catch {
        continue; // acquire rejects only on abort; the while condition exits the loop
      }

      let outcome: "processed" | "empty" | "failed" = "empty";
      try {
        // Re-check after a possibly long semaphore wait — don't claim into a
        // tripped breaker or an aborted session.
        if (signal.aborted || this.state !== "ACTIVE") break; // finally releases

        // Observation-only claim (never summarize, no self-healing — main channel handles that)
        const message = pendingStore.claimNextObservation(session.sessionDbId);
        if (message) {
          this.counters.claimed++;
          // Re-capture: main channel could clear memorySessionId between the gate and here.
          const memorySessionId = session.memorySessionId;
          if (!memorySessionId) {
            pendingStore.retryMessage(message.id); // return the row for a later round
            this.sessionManager!.notifyMessageAvailable(session.sessionDbId, session.dbPath);
            // outcome stays "empty" → POLL_MS backoff below (matches pre-rewrite timing)
          } else {
            try {
              const obsStats = await this.processObservation(message, session, memorySessionId, signal);
              this.recordSuccess();
              logger.info("BYPASS", "Observation processed", {
                messageId: message.id,
                sessionDbId: session.sessionDbId,
                endpoint: this.config ? new URL(this.config.baseUrl).host : null,
                truncatedFields: obsStats.truncatedFields,
              });
              outcome = "processed";
            } catch (error) {
              if (signal.aborted) return; // finally releases
              outcome = "failed";
              // Extract bypassCategory if attached by callRestApi.
              const category = (error as { bypassCategory?: BypassFailureCategory })
                ?.bypassCategory;
              logger.warn("BYPASS", "Processing failed, marking for retry", {
                messageId: message.id,
                category: category ?? "unknown",
                error: error instanceof Error ? error.message : String(error),
              });
              pendingStore.markFailed(message.id);
              this.sessionManager!.notifyMessageAvailable(session.sessionDbId, session.dbPath);
              this.lastFailureReason = (
                error instanceof Error ? error.message : String(error)
              ).slice(0, 200);
              this.recordFailure(category);
              if (this.state === "TRIPPED") return; // finally releases
            }
          }
        }
      } finally {
        this.globalSemaphore.release();
      }

      // Backoff AFTER the semaphore is released — never sleep holding a slot.
      // Timings match the pre-rewrite loop exactly: failure → 1000ms,
      // empty queue / memSession fallback → POLL_MS (500ms), success → immediate next claim.
      if (outcome === "failed") {
        await this.abortableSleep(1000, signal);
      } else if (outcome === "empty") {
        await this.abortableSleep(POLL_MS, signal);
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
    const parsedObservations = parseObservations(
      responseText,
      session.contentSessionId,
    );

    // Ghost filter (parity with the main Claude SDK channel, ResponseProcessor.ts):
    // drop observations whose every content field is null/empty. A true ghost is a
    // context-overflow artifact (<observation><type>X</type></observation>) that would
    // otherwise store as an "Untitled" row. Observations with ANY content are kept.
    // Intentionally reuses ResponseProcessor's stricter predicate (also checks subtitle,
    // files_read, files_modified) rather than upstream's narrower title+narrative+facts+concepts
    // check — this is a conscious fork choice for tighter ghost rejection.
    const observations = parsedObservations.filter(
      (obs) =>
        obs.title !== null ||
        obs.narrative !== null ||
        obs.subtitle !== null ||
        obs.facts.length > 0 ||
        obs.concepts.length > 0 ||
        obs.files_read.length > 0 ||
        obs.files_modified.length > 0,
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

  /** Call the OpenAI-compatible REST API. Returns response text. */
  private async callRestApi(
    prompt: string,
    systemPrompt: string,
    signal: AbortSignal,
    history: ConversationMessage[] = [],
  ): Promise<string> {
    if (!this.config) throw new Error("BypassLane not configured");
    const url = resolveOpenAICompatibleChatCompletionsUrl(this.config.baseUrl);
    if (!url) throw new Error("BypassLane base URL invalid");
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: "system", content: systemPrompt },
          ...history.map((m) => ({ role: m.role, content: m.content })),
          { role: "user", content: prompt },
        ],
        temperature: 0.3,
        // 16384 (2x default): reasoning models truncate long observations at 8192
        // (finish_reason=length), leaving unclosed <observation> tags.
        max_tokens: 16384,
        // Hardcoded: deepseek-v4-flash etc. emit CoT-only empty content without it.
        // FOOTGUN: providers that reject unknown fields (vanilla OpenAI/Groq) will 400 —
        // the Test button surfaces that. If a non-thinking provider is ever needed,
        // promote this to a CLAUDE_MEM_OPENAI_DISABLE_THINKING toggle (YAGNI for now).
        thinking: { type: "disabled" },
      }),
      signal,
    });
    if (!response.ok) {
      const rawText = (await response.text()).substring(0, 500);
      const parsed = parseBypassErrorBody(rawText);
      const category = classifyBypassFailure(response.status, parsed);
      // Redact the configured key before it lands in the thrown error / logs / lastFailureReason.
      const errorText = redactSecret(rawText, this.config.apiKey);
      const err = new Error(`OpenAI-compatible API error: ${response.status} - ${errorText}`) as Error & { bypassCategory: BypassFailureCategory };
      err.bypassCategory = category;
      throw err;
    }
    const data = (await response.json()) as any;
    return data?.choices?.[0]?.message?.content || "";
  }
}
