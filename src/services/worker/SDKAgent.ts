/**
 * SDKAgent: SDK query loop handler
 *
 * Responsibility:
 * - Spawn Claude subprocess via Agent SDK
 * - Run event-driven query loop (no polling)
 * - Process SDK responses (observations, summaries)
 * - Sync to database and Chroma
 */

import { execSync } from "child_process";
import { homedir } from "os";
import path from "path";
import { DatabaseManager } from "./DatabaseManager.js";
import { SessionManager } from "./SessionManager.js";
import { logger } from "../../utils/logger.js";
import {
  buildInitPrompt,
  buildBatchObservationPrompt,
  buildContinuationPrompt,
  buildSessionHistorySummary,
  type Observation,
} from "../../sdk/prompts.js";
import { SettingsDefaultsManager } from "../../shared/SettingsDefaultsManager.js";
import {
  USER_SETTINGS_PATH,
  OBSERVER_SESSIONS_DIR,
  ensureDir,
} from "../../shared/paths.js";
import {
  buildIsolatedEnv,
  getAuthMethodDescription,
} from "../../shared/EnvManager.js";
import type { ActiveSession, SDKUserMessage } from "../worker-types.js";
import { ModeManager } from "../domain/ModeManager.js";
import { processAgentResponse } from "./agents/ResponseProcessor.js";
import type { WorkerRef } from "./agents/types.js";
import { findClaudeExecutable } from "./claude-exec.js";
import {
  createPidCapturingSpawn,
  getProcessBySession,
  ensureProcessExit,
  waitForSlot,
} from "./ProcessRegistry.js";
import {
  createSDKUsageTotals,
  logSDKUsageSummary,
  recordSDKUsage,
} from "./SDKUsageTelemetry.js";
import { checkProcessStaleness } from "./stale-detection.js";
import { processRegistry } from "./ProcessRegistry.js";
import { shouldProactiveReset } from "./generator-action.js";
import { buildHardenedSdkOptions } from "../../sdk/hardened-options.js";

// Import Agent SDK (assumes it's installed)
// @ts-ignore - Agent SDK types may not be available
import { query } from "@anthropic-ai/claude-agent-sdk";

export function shouldPersistSDKSessionId(
  message: { type?: string; subtype?: string; session_id?: string | null },
  currentMemorySessionId: string | null,
): message is { session_id: string } {
  if (!message.session_id || message.session_id === currentMemorySessionId) {
    return false;
  }

  return !(
    message.type === "system" &&
    typeof message.subtype === "string" &&
    message.subtype.startsWith("hook_")
  );
}

export class SDKAgent {
  private static readonly RESPONSE_WATCHDOG_MS = 5 * 60 * 1000; // 5 minutes

  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /**
   * Start SDK agent for a session (event-driven, no polling)
   * @param worker WorkerService reference for spinner control (optional)
   */
  async startSession(
    session: ActiveSession,
    worker?: WorkerRef,
  ): Promise<void> {
    // Track cwd from messages for CLAUDE.md generation (worktree support)
    // Uses mutable object so generator updates are visible in response processing
    const cwdTracker = { lastCwd: undefined as string | undefined };

    // Find Claude executable
    const claudePath = findClaudeExecutable();

    // Get model ID and disallowed tools
    const modelId = this.getModelId();
    // Memory agent is OBSERVER ONLY - no tools allowed. The hardened deny-list
    // (OBSERVER_DISALLOWED_TOOLS) now lives in buildHardenedSdkOptions; the
    // former local const here was orphaned once the options block routes through it.

    // Create message generator (event-driven)
    const messageGenerator = this.createMessageGenerator(session, cwdTracker);

    // CRITICAL: Only resume if:
    // 1. memorySessionId exists (was captured from a previous SDK response)
    // 2. lastPromptNumber > 1 (this is a continuation within the same SDK session)
    // 3. forceInit is NOT set (stale session recovery clears this)
    // On worker restart or crash recovery, memorySessionId may exist from a previous
    // SDK session but we must NOT resume because the SDK context was lost.
    // NEVER use contentSessionId for resume - that would inject messages into the user's transcript!
    const hasRealMemorySessionId = !!session.memorySessionId;
    const shouldResume =
      hasRealMemorySessionId &&
      session.lastPromptNumber > 1 &&
      !session.forceInit &&
      !session.proactiveReset;  // Layer C: proactive reset prevents resume

    // Clear forceInit after using it
    if (session.forceInit) {
      logger.info("SDK", "forceInit flag set, starting fresh SDK session", {
        sessionDbId: session.sessionDbId,
        previousMemorySessionId: session.memorySessionId,
      });
      session.forceInit = false;
    }

    // Layer C: clear proactiveReset flag after use (same pattern as forceInit)
    if (session.proactiveReset) {
      logger.info("SDK", "[PROACTIVE_RESET] Starting fresh SDK session (Layer C)", {
        sessionDbId: session.sessionDbId,
      });
      session.proactiveReset = false;
    }

    // Wait for agent pool slot (configurable via CLAUDE_MEM_MAX_CONCURRENT_AGENTS)
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const maxConcurrent =
      parseInt(settings.CLAUDE_MEM_MAX_CONCURRENT_AGENTS, 10) || 4;

    // Active reclamation callback: detect zombie processes occupying pool slots.
    // Uses dbPath (stored on TrackedProcess) for O(1) composite key lookup,
    // preventing cross-project session collisions (B6 architecture).
    const staleResponseThresholdMs =
      parseInt(settings.CLAUDE_MEM_STALE_RESPONSE_THRESHOLD_MS, 10) || 180000;
    const staleInitThresholdMs =
      parseInt(settings.CLAUDE_MEM_STALE_INIT_THRESHOLD_MS, 10) || 120000;

    const isProcessStale = (
      pid: number,
      sessionDbId: number,
      dbPath?: string,
    ): boolean => {
      const occupantSession = this.sessionManager.getSession(sessionDbId, dbPath);
      const trackedProcess = processRegistry.get(pid);
      return checkProcessStaleness(
        occupantSession,
        trackedProcess,
        staleResponseThresholdMs,
        staleInitThresholdMs,
      );
    };

    await waitForSlot(maxConcurrent, undefined, isProcessStale);

    // Build isolated environment from ~/.claude-mem/.env
    // This prevents Issue #733: random ANTHROPIC_API_KEY from project .env files
    // being used instead of the configured auth method (CLI subscription or explicit API key)
    const isolatedEnv = buildIsolatedEnv();
    const authMethod = getAuthMethodDescription();

    logger.info("SDK", "Starting SDK query", {
      sessionDbId: session.sessionDbId,
      contentSessionId: session.contentSessionId,
      memorySessionId: session.memorySessionId,
      hasRealMemorySessionId,
      shouldResume,
      resume_parameter: shouldResume
        ? session.memorySessionId
        : "(none - fresh start)",
      lastPromptNumber: session.lastPromptNumber,
      authMethod,
    });

    // Debug-level alignment logs for detailed tracing
    if (session.lastPromptNumber > 1) {
      logger.debug(
        "SDK",
        `[ALIGNMENT] Resume Decision | contentSessionId=${session.contentSessionId} | memorySessionId=${session.memorySessionId} | prompt#=${session.lastPromptNumber} | hasRealMemorySessionId=${hasRealMemorySessionId} | shouldResume=${shouldResume} | resumeWith=${shouldResume ? session.memorySessionId : "NONE"}`,
      );
    } else {
      // INIT prompt - never resume even if memorySessionId exists (stale from previous session)
      const hasStaleMemoryId = hasRealMemorySessionId;
      logger.debug(
        "SDK",
        `[ALIGNMENT] First Prompt (INIT) | contentSessionId=${session.contentSessionId} | prompt#=${session.lastPromptNumber} | hasStaleMemoryId=${hasStaleMemoryId} | action=START_FRESH | Will capture new memorySessionId from SDK response`,
      );
      if (hasStaleMemoryId) {
        logger.warn(
          "SDK",
          `Skipping resume for INIT prompt despite existing memorySessionId=${session.memorySessionId} - SDK context was lost (worker restart or crash recovery)`,
        );
      }
    }

    // Run Agent SDK query loop
    // Only resume if we have a captured memory session ID
    // Use custom spawn to capture PIDs for zombie process cleanup (Issue #737)
    // Use dedicated cwd to isolate observer sessions from user's `claude --resume` list
    ensureDir(OBSERVER_SESSIONS_DIR);
    // CRITICAL: Pass isolated env to prevent Issue #733 (API key pollution from project .env files)
    // Hardened, no-tools SDK options (defense-in-depth) — single source of
    // truth shared with fresh-summarize so the lockdown can't drift. cwd jail
    // (OBSERVER_SESSIONS_DIR) and PID-capturing spawn preserved.
    const queryResult = query({
      prompt: messageGenerator,
      options: buildHardenedSdkOptions({
        source: 'Observer',
        sessionDbId: session.sessionDbId,
        contentSessionId: session.contentSessionId,
        model: modelId,
        cwd: OBSERVER_SESSIONS_DIR,
        // Only resume if shouldResume is true (memorySessionId exists, not first prompt, not forceInit)
        ...(shouldResume ? { resume: session.memorySessionId } : {}),
        abortController: session.abortController,
        pathToClaudeCodeExecutable: claudePath,
        // Custom spawn function captures PIDs to fix zombie process accumulation
        spawnClaudeCodeProcess: createPidCapturingSpawn(
          session.sessionDbId,
          session.dbPath,
        ),
        env: isolatedEnv, // isolated credentials from ~/.claude-mem/.env
      }),
    });

    // Process SDK messages — cleanup in finally ensures subprocess termination
    // even if the loop throws (e.g., context overflow, invalid API key)
    //
    // WATCHDOG: The for-await loop has no built-in timeout on the response side.
    // If the subprocess hangs mid-API-call, this loop blocks forever, preventing
    // ensureProcessExit() from running and permanently occupying a pool slot.
    // The watchdog timer aborts the session after 5 minutes of no response.
    //
    // ABORT GUARANTEE: Even if SDK's query() iterator doesn't check AbortSignal
    // internally, the abort chain still works because:
    //   1. spawn() receives `signal` option — OS sends SIGTERM to subprocess
    //   2. Subprocess death closes stdin/stdout pipes → for-await loop ends
    //   3. ensureProcessExit() in finally sends SIGKILL after 5s as last resort
    const watchdogMs =
      parseInt(settings.CLAUDE_MEM_RESPONSE_WATCHDOG_MS, 10) ||
      SDKAgent.RESPONSE_WATCHDOG_MS;
    let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
    let watchdogFiredCount = 0;
    const runUsageTotals = createSDKUsageTotals();

    const resetWatchdog = () => {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      watchdogTimer = setTimeout(() => {
        watchdogFiredCount++;
        logger.error(
          "SDK",
          `Response watchdog timeout (fire #${watchdogFiredCount}) — subprocess hung, aborting`,
          {
            sessionDbId: session.sessionDbId,
            watchdogMs,
            watchdogFiredCount,
            lastActivity: new Date(session.lastGeneratorActivity).toISOString(),
          },
        );
        session.abortController.abort();
      }, watchdogMs);
    };

    try {
      resetWatchdog();
      for await (const message of queryResult) {
        resetWatchdog();
        session.lastResponseAt = Date.now();
        // Capture or update memory session ID from SDK message
        // IMPORTANT: The SDK may return a DIFFERENT session_id on resume than what we sent!
        // We must always sync the DB to match what the SDK actually uses.
        //
        // MULTI-TERMINAL COLLISION FIX (FK constraint bug):
        // Use ensureMemorySessionIdRegistered() instead of updateMemorySessionId() because:
        // 1. It's idempotent - safe to call multiple times
        // 2. It verifies the update happened (SELECT before UPDATE)
        // 3. Consistent with ResponseProcessor's usage pattern
        // This ensures FK constraint compliance BEFORE any observations are stored.
        // Skip the entire `system:hook_*` subtype family — every hook_* message
        // (hook_started, hook_response, ...) carries a per-run ephemeral session_id.
        // The canonical resumed id arrives on `system:init`. Persisting an ephemeral
        // id triggers ON UPDATE CASCADE on observations and opens a ~200ms
        // FK-violation window for parallel consumers (bypass lane).
        if (shouldPersistSDKSessionId(message, session.memorySessionId)) {
          const previousId = session.memorySessionId;
          session.memorySessionId = message.session_id;
          // Persist to database IMMEDIATELY for FK constraint compliance
          // This must happen BEFORE any observations referencing this ID are stored
          this.dbManager
            .getSessionStore(session.dbPath)
            .ensureMemorySessionIdRegistered(
              session.sessionDbId,
              message.session_id,
            );
          // Verify the update by reading back from DB
          const verification = this.dbManager
            .getSessionStore(session.dbPath)
            .getSessionById(session.sessionDbId);
          const dbVerified =
            verification?.memory_session_id === message.session_id;
          const msgType = (message as { type?: string }).type ?? "unknown";
          const msgSubtype = (message as { subtype?: string }).subtype ?? "";
          const typeTag = msgSubtype ? `${msgType}:${msgSubtype}` : msgType;
          const logMessage = previousId
            ? `MEMORY_ID_CHANGED | sessionDbId=${session.sessionDbId} | from=${previousId} | to=${message.session_id} | dbVerified=${dbVerified} | msgType=${typeTag}`
            : `MEMORY_ID_CAPTURED | sessionDbId=${session.sessionDbId} | memorySessionId=${message.session_id} | dbVerified=${dbVerified} | msgType=${typeTag}`;
          logger.info("SESSION", logMessage, {
            sessionId: session.sessionDbId,
            memorySessionId: message.session_id,
            previousId,
            msgType: typeTag,
          });
          if (!dbVerified) {
            logger.error(
              "SESSION",
              `MEMORY_ID_MISMATCH | sessionDbId=${session.sessionDbId} | expected=${message.session_id} | got=${verification?.memory_session_id}`,
              {
                sessionId: session.sessionDbId,
              },
            );
          }
          // Debug-level alignment log for detailed tracing
          logger.debug(
            "SDK",
            `[ALIGNMENT] ${previousId ? "Updated" : "Captured"} | contentSessionId=${session.contentSessionId} → memorySessionId=${message.session_id} | Future prompts will resume with this ID`,
          );
        }

        // Handle assistant messages
        if (message.type === "assistant") {
          const content = message.message.content;
          const textContent = Array.isArray(content)
            ? content
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text)
                .join("\n")
            : typeof content === "string"
              ? content
              : "";

          // Check for context overflow - prevents infinite retry loops
          if (
            textContent.toLowerCase().includes("prompt is too long") ||
            textContent.toLowerCase().includes("context window")
          ) {
            logger.error(
              "SDK",
              "Context overflow detected - terminating session and forcing fresh start",
              { sessionDbId: session.sessionDbId },
            );
            // Resuming this SDK session would overflow forever. Null the memory
            // session id and force a fresh init so the next spawn drains the
            // remaining pending messages successfully (#2088). Complementary to
            // Layer-C proactive reset (which fires preemptively by thresholds).
            this.dbManager
              .getSessionStore(session.dbPath)
              .updateMemorySessionId(session.sessionDbId, null);
            session.memorySessionId = null;
            session.forceInit = true;
            session.abortController.abort();
            return;
          }

          const responseSize = textContent.length;

          // Extract and track token usage
          const usage = message.message.usage;
          const discoveryTokens = usage
            ? recordSDKUsage({
                session,
                promptNumber:
                  session.currentSDKPromptNumber ?? session.lastPromptNumber,
                messageKind: session.currentSDKMessageKind ?? "unknown",
                usage,
                usageTotals: runUsageTotals,
              })
            : 0;

          // Process response (empty or not) and mark messages as processed
          // Capture earliest timestamp BEFORE processing (will be cleared after)
          const originalTimestamp = session.earliestPendingTimestamp;

          if (responseSize > 0) {
            const truncatedResponse =
              responseSize > 100
                ? textContent.substring(0, 100) + "..."
                : textContent;
            logger.dataOut(
              "SDK",
              `Response received (${responseSize} chars)`,
              {
                sessionId: session.sessionDbId,
                promptNumber: session.lastPromptNumber,
              },
              truncatedResponse,
            );
          }

          // Detect invalid API key — SDK returns this as response text, not an error.
          // Throw so it surfaces in health endpoint and prevents silent failures.
          if (textContent.includes("Invalid API key")) {
            throw new Error(
              "Invalid API key: check your API key configuration in ~/.claude-mem/settings.json or ~/.claude-mem/.env",
            );
          }

          // Parse and process response using shared ResponseProcessor
          await processAgentResponse(
            textContent,
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            discoveryTokens,
            originalTimestamp,
            "SDK",
            cwdTracker.lastCwd,
          );

          // Layer C: Proactive history reset checkpoint
          // Check AFTER response is fully processed (zero message loss)
          if (shouldProactiveReset(
            session.conversationHistory.length,
            session.conversationHistory,
            parseInt(settings.CLAUDE_MEM_MAX_HISTORY_LENGTH, 10) || 50,
            parseInt(settings.CLAUDE_MEM_MAX_HISTORY_TOKENS, 10) || 100000,
          )) {
            logger.info('SDK', '[PROACTIVE_RESET] History threshold reached', {
              sessionDbId: session.sessionDbId,
              historyLength: session.conversationHistory.length,
              estimatedTokens: session.conversationHistory.reduce(
                (sum: number, msg: any) => sum + Math.ceil((msg.content?.length || 0) / 4), 0
              ),
            });
            session.proactiveReset = true;
            session.conversationHistory = [];
            session.previousMemorySessionId = session.memorySessionId ?? undefined;
            session.abortController.abort();
            return;
          }
        }

        // Log result messages
        if (message.type === "result" && message.subtype === "success") {
          // Usage telemetry is captured at SDK level
        }
      }
    } finally {
      // Clear watchdog timer
      if (watchdogTimer) clearTimeout(watchdogTimer);

      // Ensure subprocess is terminated after query completes (or on error)
      const tracked = getProcessBySession(session.sessionDbId, session.dbPath);
      if (tracked && tracked.process.exitCode === null) {
        await ensureProcessExit(tracked, 5000);
      }

      logSDKUsageSummary({
        session,
        summaryType: "run",
        usageTotals: runUsageTotals,
      });
    }

    // Mark session complete
    const sessionDuration = Date.now() - session.startTime;
    logger.success("SDK", "Agent completed", {
      sessionId: session.sessionDbId,
      duration: `${(sessionDuration / 1000).toFixed(1)}s`,
      runResponses: runUsageTotals.totalResponses,
      runDiscoveryTokens: runUsageTotals.totalDiscoveryTokens,
      sessionDiscoveryTokens:
        session.cumulativeSDKUsage?.totalDiscoveryTokens ?? 0,
    });
  }

  /**
   * Create event-driven message generator (yields messages from SessionManager)
   *
   * CRITICAL: CONTINUATION PROMPT LOGIC
   * ====================================
   * This is where NEW hook's dual-purpose nature comes together:
   *
   * - Prompt #1 (lastPromptNumber === 1): buildInitPrompt
   *   - Full initialization prompt with instructions
   *   - Sets up the SDK agent's context
   *
   * - Prompt #2+ (lastPromptNumber > 1): buildContinuationPrompt
   *   - Continuation prompt for same session
   *   - Includes session context and prompt number
   *
   * BOTH prompts receive session.contentSessionId:
   * - This comes from the hook's session_id (see new-hook.ts)
   * - Same session_id used by SAVE hook to store observations
   * - This is how everything stays connected in one unified session
   *
   * NO SESSION EXISTENCE CHECKS NEEDED:
   * - SessionManager.initializeSession already fetched this from database
   * - Database row was created by new-hook's createSDKSession call
   * - We just use the session_id we're given - simple and reliable
   *
   * SHARED CONVERSATION HISTORY:
   * - Each user message is added to session.conversationHistory
   * - This allows provider switching (Claude→Gemini) with full context
   * - SDK manages its own internal state, but we mirror it for interop
   *
   * CWD TRACKING:
   * - cwdTracker is a mutable object shared with startSession
   * - As messages with cwd are processed, cwdTracker.lastCwd is updated
   * - This enables processAgentResponse to use the correct cwd for CLAUDE.md
   */
  private async *createMessageGenerator(
    session: ActiveSession,
    cwdTracker: { lastCwd: string | undefined },
  ): AsyncIterableIterator<SDKUserMessage> {
    // Load settings once per generator (Phase 1: changes apply on next generator start)
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const batchMaxSize = parseInt(settings.CLAUDE_MEM_BATCH_MAX_SIZE, 10) || 5;
    const obsMaxFieldChars =
      parseInt(settings.CLAUDE_MEM_OBS_MAX_FIELD_CHARS, 10) || 8000;

    // Load active mode
    const mode = ModeManager.getInstance().getActiveMode();

    // Build initial prompt
    const isInitPrompt = session.lastPromptNumber === 1;
    logger.info("SDK", "Creating message generator", {
      sessionDbId: session.sessionDbId,
      contentSessionId: session.contentSessionId,
      lastPromptNumber: session.lastPromptNumber,
      isInitPrompt,
      promptType: isInitPrompt ? "INIT" : "CONTINUATION",
    });

    let initPrompt = isInitPrompt
      ? buildInitPrompt(
          session.project,
          session.contentSessionId,
          session.userPrompt,
          mode,
        )
      : buildContinuationPrompt(
          session.userPrompt,
          session.lastPromptNumber,
          session.contentSessionId,
          mode,
        );

    // Inject session history summary after forceInit (context overflow recovery)
    if (session.previousMemorySessionId) {
      const prevId = session.previousMemorySessionId;
      // Clear immediately — one-shot, prevents re-query on subsequent restarts
      session.previousMemorySessionId = undefined;
      const sessionStore = this.dbManager.getSessionStore(session.dbPath);
      const priorObservations = sessionStore.getObservationsForSession(prevId);
      const summaryBlock = buildSessionHistorySummary(priorObservations);
      if (summaryBlock) {
        initPrompt = summaryBlock + "\n\n" + initPrompt;
        logger.info(
          "SDK",
          `[CONTEXT_RESET] Injected session history summary (${priorObservations.length} prior observations)`,
          {
            sessionDbId: session.sessionDbId,
            previousMemorySessionId: prevId,
          },
        );
      }
    }

    // Add to shared conversation history for provider interop
    session.conversationHistory.push({ role: "user", content: initPrompt });
    session.currentSDKMessageKind = isInitPrompt ? "init" : "continuation";
    session.currentSDKPromptNumber = session.lastPromptNumber;

    // Yield initial user prompt with context (or continuation if prompt #2+)
    // CRITICAL: Both paths use session.contentSessionId from the hook
    yield {
      type: "user",
      message: {
        role: "user",
        content: initPrompt,
      },
      session_id: session.contentSessionId,
      parent_tool_use_id: null,
      isSynthetic: true,
    };

    // Consume pending messages from SessionManager (event-driven, no polling)
    for await (const message of this.sessionManager.getMessageIterator(
      session.sessionDbId,
      session.dbPath,
    )) {
      // CLAIM-CONFIRM: Track message ID for confirmProcessed() after successful storage
      // The message is now in 'processing' status in DB until ResponseProcessor calls confirmProcessed()
      session.processingMessageIds.push(message._persistentId);

      // Capture cwd from each message for worktree support
      if (message.cwd) {
        cwdTracker.lastCwd = message.cwd;
      }

      if (message.type === "observation") {
        // Update last prompt number
        if (message.prompt_number !== undefined) {
          session.lastPromptNumber = message.prompt_number;
        }

        const batchPromptNumber = message.prompt_number;
        let batchOriginalTimestamp = message._originalTimestamp || Date.now();

        // Build batch: start with this iterator-delivered message
        const batchObservations: Observation[] = [
          {
            id: 0,
            tool_name: message.tool_name!,
            tool_input: (message.tool_input as string) || "{}",
            tool_output: (message.tool_response as string) || "{}",
            created_at_epoch: batchOriginalTimestamp,
            cwd: message.cwd,
          },
        ];

        // Phase 1 safe batching: claim only FIFO-contiguous same-prompt observation tails
        if (batchMaxSize > 1 && batchPromptNumber !== undefined) {
          const pendingStore = this.sessionManager.getPendingMessageStore(
            session.dbPath,
          );
          const morePersistent = pendingStore.claimNextObservationBatch(
            session.sessionDbId,
            batchPromptNumber,
            batchMaxSize - 1,
          );
          for (const p of morePersistent) {
            // Track each claimed message for CLAIM-CONFIRM lifecycle
            session.processingMessageIds.push(p.id);
            batchOriginalTimestamp = Math.min(
              batchOriginalTimestamp,
              p.created_at_epoch || batchOriginalTimestamp,
            );
            session.earliestPendingTimestamp =
              session.earliestPendingTimestamp === null
                ? batchOriginalTimestamp
                : Math.min(
                    session.earliestPendingTimestamp,
                    batchOriginalTimestamp,
                  );
            batchObservations.push({
              id: 0,
              tool_name: p.tool_name!,
              tool_input: p.tool_input || "{}",
              tool_output: p.tool_response || "{}",
              created_at_epoch: p.created_at_epoch,
              cwd: p.cwd || undefined,
            });
          }
        }

        // Build prompt (single or batch format — buildBatchObservationPrompt delegates for length=1)
        const { prompt: obsPrompt, truncatedFields } =
          buildBatchObservationPrompt(batchObservations, obsMaxFieldChars);

        // Track optimization stats
        if (!session.optimizationStats) {
          session.optimizationStats = {
            batchedObservations: 0,
            batchPromptsSaved: 0,
            totalPromptChars: 0,
            truncatedFields: 0,
          };
        }
        session.optimizationStats.totalPromptChars += obsPrompt.length;
        session.optimizationStats.truncatedFields += truncatedFields;
        if (batchObservations.length > 1) {
          session.optimizationStats.batchedObservations +=
            batchObservations.length;
          session.optimizationStats.batchPromptsSaved +=
            batchObservations.length - 1;
          logger.info(
            "SDK",
            `BATCH | sessionDbId=${session.sessionDbId} | count=${batchObservations.length} | promptNumber=${batchPromptNumber}`,
          );
        }

        // Add to shared conversation history for provider interop
        session.conversationHistory.push({ role: "user", content: obsPrompt });
        session.currentSDKMessageKind = "observation";
        session.currentSDKPromptNumber = session.lastPromptNumber;

        yield {
          type: "user",
          message: {
            role: "user",
            content: obsPrompt,
          },
          session_id: session.contentSessionId,
          parent_tool_use_id: null,
          isSynthetic: true,
        };
      }
    }
  }

  // ============================================================================
  // Configuration Helpers
  // ============================================================================

  /**
   * Get model ID from settings or environment
   */
  private getModelId(): string {
    const settingsPath = path.join(homedir(), ".claude-mem", "settings.json");
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    return settings.CLAUDE_MEM_MODEL;
  }
}
