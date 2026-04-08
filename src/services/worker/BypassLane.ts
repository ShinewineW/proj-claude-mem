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

// API endpoints
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1/models";
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
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
}

interface BypassConfig {
  provider: "gemini" | "openrouter";
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
        settings.CLAUDE_MEM_OPENROUTER_MODEL || "stepfun/step-3.5-flash:free";
      return { provider: "openrouter", apiKey, model, cooldownMs };
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

  private recordFailure(): void {
    this.consecutiveFailures++;
    this.counters.failed++;
    this.counters.lastFailureAt = new Date().toISOString();
    if (this.consecutiveFailures >= this.maxFailures) {
      this.tripCircuitBreaker();
    }
  }

  private tripCircuitBreaker(): void {
    this.state = "TRIPPED";
    this.counters.trips++;
    this.counters.lastTripAt = new Date().toISOString();
    logger.warn(
      "BYPASS",
      `Circuit breaker TRIPPED after ${this.consecutiveFailures} consecutive failures`,
      {
        cooldownMs: this.config?.cooldownMs,
      },
    );
    this.scheduleCooldownProbe();
  }

  private scheduleCooldownProbe(): void {
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    const cooldownMs = this.config?.cooldownMs ?? 1200000;
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
      } else {
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
    const POLL_MS = 2000;

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
        logger.warn("BYPASS", "Processing failed, marking for retry", {
          messageId: message.id,
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
        this.recordFailure();
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

    // Store observations in DB (atomic)
    const sessionStore = this.dbManager.getSessionStore(session.dbPath);
    const result = sessionStore.storeObservations(
      memorySessionId,
      session.project,
      observations, // ParsedObservation already has the exact 8 fields storeObservations expects
      null, // No summary for observation messages
      message.prompt_number || undefined,
      0, // discoveryTokens
      message.created_at_epoch,
    );

    // Chroma sync (fire-and-forget)
    const chromaSync = this.dbManager.getChromaSync(session.dbPath);
    if (chromaSync) {
      for (let i = 0; i < observations.length; i++) {
        const obsId = result.observationIds[i];
        chromaSync
          .syncObservation(
            obsId,
            memorySessionId,
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
    } else {
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
          reasoning: { effort: "low" }, // Observation extraction is structured; minimize reasoning overhead
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
    }
  }
}
