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
 * Key isolation from main channel:
 * - Does NOT touch session.processingMessageIds (avoids race with main channel)
 * - Does NOT touch session.conversationHistory (one-shot, no context needed)
 * - Uses parseObservations() + storeObservations() + confirmProcessed() directly
 *   instead of processAgentResponse() which modifies shared session state
 */

import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { getCredential } from '../../shared/EnvManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { parseObservations } from '../../sdk/parser.js';
import { buildObservationPrompt } from '../../sdk/prompts.js';
import type { ActiveSession } from '../worker-types.js';
import type { PersistentPendingMessage } from '../sqlite/PendingMessageStore.js';
import type { SessionManager } from './SessionManager.js';
import type { DatabaseManager } from './DatabaseManager.js';

// API endpoints
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1/models';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
// Must be < STALE_PROCESSING_THRESHOLD_MS (60s in PendingMessageStore) to prevent
// the main channel's self-healing from resetting a bypass in-flight message to 'pending',
// which would cause double-processing.
const FETCH_TIMEOUT_MS = 45_000;

export type BypassState = 'DISABLED' | 'ACTIVE' | 'TRIPPED';

interface BypassConfig {
  provider: 'gemini' | 'openrouter';
  apiKey: string;
  model: string;
  cooldownMs: number;
}

export class BypassLane {
  private state: BypassState = 'DISABLED';
  private consecutiveFailures = 0;
  private readonly maxFailures = 3;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private activeConsumers = new Map<number, AbortController>();
  private config: BypassConfig | null = null;

  // Injected after construction (avoids circular dep with WorkerService)
  private sessionManager: SessionManager | null = null;
  private dbManager: DatabaseManager | null = null;

  /** Wire dependencies (called from WorkerService constructor). */
  setDependencies(sessionManager: SessionManager, dbManager: DatabaseManager): void {
    this.sessionManager = sessionManager;
    this.dbManager = dbManager;
  }

  /** Read settings and determine bypass config. Returns null if bypass not applicable. */
  private resolveConfig(): BypassConfig | null {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    const provider = settings.CLAUDE_MEM_PROVIDER;
    if (provider === 'claude' || !provider) return null;

    const cooldownMs = parseInt(settings.CLAUDE_MEM_BYPASS_COOLDOWN_MS) || 1200000;

    if (provider === 'gemini') {
      const apiKey = settings.CLAUDE_MEM_GEMINI_API_KEY || getCredential('GEMINI_API_KEY') || '';
      if (!apiKey) return null;
      const model = settings.CLAUDE_MEM_GEMINI_MODEL || 'gemini-2.5-flash';
      return { provider: 'gemini', apiKey, model, cooldownMs };
    }

    if (provider === 'openrouter') {
      const apiKey = settings.CLAUDE_MEM_OPENROUTER_API_KEY || getCredential('OPENROUTER_API_KEY') || '';
      if (!apiKey) return null;
      const model = settings.CLAUDE_MEM_OPENROUTER_MODEL || 'xiaomi/mimo-v2-flash:free';
      return { provider: 'openrouter', apiKey, model, cooldownMs };
    }

    return null;
  }

  /** Initialize: check conditions, run probe, transition to ACTIVE if successful. */
  async initialize(): Promise<void> {
    this.config = this.resolveConfig();
    if (!this.config) {
      logger.info('BYPASS', 'Bypass lane disabled (provider=claude or no API key)');
      return;
    }

    logger.info('BYPASS', `Probing ${this.config.provider} for bypass lane activation`, {
      model: this.config.model,
    });

    const probeOk = await this.probeProvider();
    if (probeOk) {
      this.state = 'ACTIVE';
      logger.success('BYPASS', `Bypass lane ACTIVE using ${this.config.provider}`, {
        model: this.config.model,
        cooldownMs: this.config.cooldownMs,
      });
    } else {
      logger.warn('BYPASS', 'Bypass lane probe failed, staying DISABLED');
    }
  }

  getState(): BypassState { return this.state; }
  isActive(): boolean { return this.state === 'ACTIVE'; }

  /** Start bypass consumer for a session. No-op if not ACTIVE. */
  startForSession(session: ActiveSession): void {
    if (this.state !== 'ACTIVE') return;
    if (this.activeConsumers.has(session.sessionDbId)) return;

    const ac = new AbortController();
    this.activeConsumers.set(session.sessionDbId, ac);

    this.consumeLoop(session, ac.signal).catch(error => {
      if (!ac.signal.aborted) {
        logger.error('BYPASS', 'Consumer loop error', {
          sessionDbId: session.sessionDbId,
        }, error as Error);
      }
    }).finally(() => {
      this.activeConsumers.delete(session.sessionDbId);
    });
  }

  /** Stop bypass consumer for a session. */
  stopForSession(sessionDbId: number): void {
    const ac = this.activeConsumers.get(sessionDbId);
    if (ac) {
      ac.abort();
      this.activeConsumers.delete(sessionDbId);
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
    this.state = 'DISABLED';
  }

  /** Filter: only process observation messages. */
  private shouldProcessMessage(message: PersistentPendingMessage): boolean {
    return message.message_type === 'observation';
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.maxFailures) {
      this.tripCircuitBreaker();
    }
  }

  private tripCircuitBreaker(): void {
    this.state = 'TRIPPED';
    logger.warn('BYPASS', `Circuit breaker TRIPPED after ${this.consecutiveFailures} consecutive failures`, {
      cooldownMs: this.config?.cooldownMs,
    });
    this.scheduleCooldownProbe();
  }

  private scheduleCooldownProbe(): void {
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    const cooldownMs = this.config?.cooldownMs ?? 1200000;
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      this.attemptRecovery().catch(error => {
        logger.warn('BYPASS', 'Recovery probe error', {}, error as Error);
      });
    }, cooldownMs);
  }

  private async attemptRecovery(): Promise<void> {
    logger.info('BYPASS', 'Attempting recovery probe');
    const probeOk = await this.probeProvider();
    if (probeOk) {
      this.state = 'ACTIVE';
      this.consecutiveFailures = 0;
      logger.success('BYPASS', 'Bypass lane recovered, state → ACTIVE');
    } else {
      logger.warn('BYPASS', 'Recovery probe failed, restarting cooldown');
      this.scheduleCooldownProbe();
    }
  }

  /** Probe provider health with a lightweight API call. */
  private async probeProvider(): Promise<boolean> {
    if (!this.config) return false;

    try {
      const signal = AbortSignal.timeout(15_000);
      if (this.config.provider === 'gemini') {
        const url = `${GEMINI_API_URL}/${this.config.model}:generateContent?key=${this.config.apiKey}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'Reply with OK' }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 10 },
          }),
          signal,
        });
        return response.ok;
      } else {
        const response = await fetch(OPENROUTER_API_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.config.model,
            messages: [{ role: 'user', content: 'Reply with OK' }],
            max_tokens: 10,
          }),
          signal,
        });
        return response.ok;
      }
    } catch {
      return false;
    }
  }

  /** Main consumer loop — claims observation messages, processes via REST API. */
  private async consumeLoop(session: ActiveSession, signal: AbortSignal): Promise<void> {
    if (!this.sessionManager || !this.dbManager) return;

    const pendingStore = this.sessionManager.getPendingMessageStore(session.dbPath);
    const POLL_INTERVAL_MS = 2000;

    while (!signal.aborted && this.state === 'ACTIVE') {
      const message = pendingStore.claimNextMessage(session.sessionDbId);

      if (!message) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, POLL_INTERVAL_MS);
          const onAbort = () => { clearTimeout(timer); resolve(); };
          signal.addEventListener('abort', onAbort, { once: true });
        });
        continue;
      }

      // Skip summarize messages — release back for main channel
      if (!this.shouldProcessMessage(message)) {
        pendingStore.retryMessage(message.id);
        logger.debug('BYPASS', 'Released non-observation message back to pending', {
          messageId: message.id,
          type: message.message_type,
        });
        continue;
      }

      // Wait for main channel to establish memorySessionId before processing.
      // Avoids race where bypass assigns a synthetic ID that gets orphaned.
      if (!session.memorySessionId) {
        pendingStore.retryMessage(message.id);
        logger.debug('BYPASS', 'Skipping — waiting for main channel to establish memorySessionId', {
          messageId: message.id,
          sessionDbId: session.sessionDbId,
        });
        continue;
      }

      // Capture memorySessionId before async call to avoid TOCTOU race
      // (main channel could clear/replace it during the API call)
      const memorySessionId = session.memorySessionId!;

      try {
        await this.processObservation(message, session, memorySessionId, signal);
        this.recordSuccess();
        logger.info('BYPASS', 'Observation processed via bypass lane', {
          messageId: message.id,
          sessionDbId: session.sessionDbId,
          provider: this.config?.provider,
        });
      } catch (error) {
        if (signal.aborted) return;
        logger.warn('BYPASS', 'Bypass processing failed, marking for retry', {
          messageId: message.id,
          error: error instanceof Error ? error.message : String(error),
        });
        pendingStore.markFailed(message.id);
        this.recordFailure();
        if (this.state === 'TRIPPED') return;
      }
    }
  }

  /** Process a single observation message via REST API. */
  private async processObservation(
    message: PersistentPendingMessage,
    session: ActiveSession,
    memorySessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.config || !this.dbManager || !this.sessionManager) {
      throw new Error('BypassLane not configured');
    }

    // Parse tool_input and tool_response from JSON strings
    let toolInput: unknown;
    let toolResponse: unknown;
    try { toolInput = message.tool_input ? JSON.parse(message.tool_input) : undefined; }
    catch { toolInput = message.tool_input; }
    try { toolResponse = message.tool_response ? JSON.parse(message.tool_response) : undefined; }
    catch { toolResponse = message.tool_response; }

    // Build observation prompt (same format as GeminiAgent/OpenRouterAgent)
    const obsPrompt = buildObservationPrompt({
      id: 0,
      tool_name: message.tool_name!,
      tool_input: JSON.stringify(toolInput),
      tool_output: JSON.stringify(toolResponse),
      created_at_epoch: message.created_at_epoch,
      cwd: message.cwd || undefined,
    });

    // System prompt (condensed — bypass is single-turn, no session context needed)
    const systemPrompt =
      'You are a code observation extractor. Analyze the tool usage and output structured observations in XML format. ' +
      'Output ONLY <observation> tags with type, title, subtitle, facts, narrative, concepts, files_read, files_modified.';

    // Call REST API
    const fetchSignal = AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
    const responseText = await this.callRestApi(obsPrompt, systemPrompt, fetchSignal);

    if (!responseText) {
      throw new Error('Empty response from bypass provider');
    }

    // Parse observations from XML response
    const observations = parseObservations(responseText, session.contentSessionId);

    // Store observations in DB (atomic)
    if (observations.length > 0) {
      const sessionStore = this.dbManager.getSessionStore(session.dbPath);
      const result = sessionStore.storeObservations(
        memorySessionId,
        session.project,
        observations.map(obs => ({
          type: obs.type,
          title: obs.title,
          subtitle: obs.subtitle,
          facts: obs.facts,
          narrative: obs.narrative,
          concepts: obs.concepts,
          files_read: obs.files_read,
          files_modified: obs.files_modified,
        })),
        null, // No summary for observation messages
        message.prompt_number || undefined,
        0,    // discoveryTokens
        message.created_at_epoch,
      );

      // Chroma sync (fire-and-forget)
      const chromaSync = this.dbManager.getChromaSync(session.dbPath);
      if (chromaSync) {
        for (let i = 0; i < observations.length; i++) {
          const obsId = result.observationIds[i];
          chromaSync.syncObservation(
            obsId,
            memorySessionId,
            session.project,
            observations[i],
            message.prompt_number || 0,
            result.createdAtEpoch,
          ).catch(() => {}); // Fire-and-forget
        }
      }
    }

    // Confirm message processed (delete from queue)
    const pendingStore = this.sessionManager.getPendingMessageStore(session.dbPath);
    pendingStore.confirmProcessed(message.id);
  }

  /** Call Gemini or OpenRouter REST API. Returns response text. */
  private async callRestApi(
    prompt: string,
    systemPrompt: string,
    signal: AbortSignal,
  ): Promise<string> {
    if (!this.config) throw new Error('BypassLane not configured');

    if (this.config.provider === 'gemini') {
      const url = `${GEMINI_API_URL}/${this.config.model}:generateContent?key=${this.config.apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          systemInstruction: { parts: [{ text: systemPrompt }] },
          generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
        }),
        signal,
      });

      if (!response.ok) {
        // Sanitize error text: Gemini may echo the URL (including API key) in error responses
        const errorText = (await response.text()).replace(/key=[^&\s"]+/g, 'key=REDACTED');
        throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json() as any;
      return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else {
      const response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'HTTP-Referer': 'https://github.com/thedotmack/claude-mem',
          'X-Title': 'claude-mem',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
          temperature: 0.3,
          max_tokens: 4096,
        }),
        signal,
      });

      if (!response.ok) {
        // Truncate error body to prevent accidental credential echo in logs
        const errorText = (await response.text()).substring(0, 500);
        throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json() as any;
      return data?.choices?.[0]?.message?.content || '';
    }
  }
}
