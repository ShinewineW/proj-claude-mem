/**
 * ResponseProcessor: Shared response processing for all agent implementations
 *
 * Responsibility:
 * - Parse observations and summaries from agent responses
 * - Execute atomic database transactions
 * - Orchestrate Chroma sync (fire-and-forget)
 * - Broadcast to SSE clients
 * - Clean up processed messages
 *
 * Shared response processing logic for SDKAgent.
 */

import { logger } from '../../../utils/logger.js';
import { parseObservations, parseSummary, type ParsedObservation, type ParsedSummary } from '../../../sdk/parser.js';
import { updateCursorContextForProject } from '../../integrations/CursorHooksInstaller.js';
import { updateFolderClaudeMdFiles } from '../../../utils/claude-md-utils.js';
import { getWorkerPort } from '../../../shared/worker-utils.js';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../shared/paths.js';
import path from 'node:path';
import type { ActiveSession } from '../../worker-types.js';
import type { DatabaseManager } from '../DatabaseManager.js';
import type { SessionManager } from '../SessionManager.js';
import type { WorkerRef, StorageResult } from './types.js';
import { broadcastObservation, broadcastSummary } from './ObservationBroadcaster.js';
import { cleanupProcessedMessages } from './SessionCleanupHelper.js';

/**
 * Process agent response text (parse XML, save to database, sync to Chroma, broadcast SSE)
 *
 * This is the unified response processor that handles:
 * 1. Adding response to conversation history (for provider interop)
 * 2. Parsing observations and summaries from XML
 * 3. Atomic database transaction to store observations + summary
 * 4. Async Chroma sync (fire-and-forget, failures are non-critical)
 * 5. SSE broadcast to web UI clients
 * 6. Session cleanup
 *
 * @param text - Response text from the agent
 * @param session - Active session being processed
 * @param dbManager - Database manager for storage operations
 * @param sessionManager - Session manager for message tracking
 * @param worker - Worker reference for SSE broadcasting (optional)
 * @param discoveryTokens - Token cost delta for this response
 * @param originalTimestamp - Original epoch when message was queued (for accurate timestamps)
 * @param agentName - Name of the agent for logging (e.g., 'SDK', 'Gemini', 'OpenRouter')
 * @param messageType - Type of the message that produced this response ('observation' or 'summarize')
 */
export async function processAgentResponse(
  text: string,
  session: ActiveSession,
  dbManager: DatabaseManager,
  sessionManager: SessionManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  originalTimestamp: number | null,
  agentName: string,
  projectRoot?: string,
  messageType?: 'observation' | 'summarize'
): Promise<void> {
  // Track generator activity for stale detection (Issue #1099)
  session.lastGeneratorActivity = Date.now();

  // Add assistant response to shared conversation history for provider interop
  if (text) {
    session.conversationHistory.push({ role: 'assistant', content: text });
  }

  // Parse observations and summary
  const observations = parseObservations(text, session.contentSessionId);
  const summary = parseSummary(text, session.sessionDbId);

  // Convert nullable fields to empty strings for storeSummary (if summary exists)
  const summaryForStore = normalizeSummaryForStorage(summary);

  // Get session store for atomic transaction (use per-session dbPath if available)
  const sessionStore = dbManager.getSessionStore(session.dbPath);

  // CRITICAL: Must use memorySessionId (not contentSessionId) for FK constraint
  if (!session.memorySessionId) {
    throw new Error('Cannot store observations: memorySessionId not yet captured');
  }

  // SAFETY NET (Issue #846 / Multi-terminal FK fix):
  // The PRIMARY fix is in SDKAgent.ts where ensureMemorySessionIdRegistered() is called
  // immediately when the SDK returns a memory_session_id. This call is a defensive safety net
  // in case the DB was somehow not updated (race condition, crash, etc.).
  // In multi-terminal scenarios, createSDKSession() now resets memory_session_id to NULL
  // for each new generator, ensuring clean isolation.
  sessionStore.ensureMemorySessionIdRegistered(session.sessionDbId, session.memorySessionId);

  // Refresh project from DB if empty (race: observation hook may arrive before SessionStart sets project)
  if (!session.project || session.project.trim() === '') {
    const dbSession = dbManager.getSessionById(session.sessionDbId, session.dbPath);
    if (dbSession.project && dbSession.project.trim() !== '') {
      logger.info('DB', `Project backfilled from database`, {
        sessionId: session.sessionDbId,
        project: dbSession.project
      });
      session.project = dbSession.project;
    } else if (session.dbPath) {
      // Last resort: derive project name from dbPath if it follows standard convention
      // Standard: <project>/.claude/mem.db — env override paths may not follow this
      const parentDir = path.basename(path.dirname(session.dbPath));
      if (parentDir === '.claude' && path.basename(session.dbPath) === 'mem.db') {
        const derived = path.basename(path.dirname(path.dirname(session.dbPath)));
        if (derived && derived !== '.' && derived !== '') {
          logger.info('DB', `Project derived from dbPath`, {
            sessionId: session.sessionDbId,
            project: derived,
            dbPath: session.dbPath
          });
          session.project = derived;
        }
      }
    }
  }

  // Log pre-storage with session ID chain for verification
  logger.info('DB', `STORING | sessionDbId=${session.sessionDbId} | memorySessionId=${session.memorySessionId} | obsCount=${observations.length} | hasSummary=${!!summaryForStore}`, {
    sessionId: session.sessionDbId,
    memorySessionId: session.memorySessionId
  });

  // ATOMIC TRANSACTION: Store observations + summary ONCE
  // Messages are already deleted from queue on claim, so no completion tracking needed
  const result = sessionStore.storeObservations(
    session.memorySessionId,
    session.project,
    observations,
    summaryForStore,
    session.lastPromptNumber,
    discoveryTokens,
    originalTimestamp ?? undefined
  );

  // Log storage result with IDs for end-to-end traceability
  logger.info('DB', `STORED | sessionDbId=${session.sessionDbId} | memorySessionId=${session.memorySessionId} | obsCount=${result.observationIds.length} | obsIds=[${result.observationIds.join(',')}] | summaryId=${result.summaryId || 'none'}`, {
    sessionId: session.sessionDbId,
    memorySessionId: session.memorySessionId
  });

  // ── Empty Observation Detection (context overflow recovery) ──
  // Detect context overflow: stored observation with title=null AND narrative=null.
  // Runs regardless of messageType — messageTypeTracker can be stale when observation
  // and summarize messages are batched (tracker overwrites to 'summarize' before
  // observation responses arrive, causing Check 1 to be skipped entirely).
  // Production evidence: bdo_lua_program session-7, obs #190-193 all bypassed detection.
  {
    const emptyObs = observations.find(obs => obs.title === null && obs.narrative === null);

    if (emptyObs) {
      // Circuit breaker: cap forceInit at 3 consecutive resets to prevent infinite loop.
      const MAX_CONTEXT_RESETS = 3;
      if ((session.contextResetCount ?? 0) >= MAX_CONTEXT_RESETS) {
        logger.error('SDK', `[CONTEXT_RESET] Exhausted — ${session.contextResetCount} consecutive resets without recovery, marking session degraded. Ghost cleanup will reap.`, {
          sessionDbId: session.sessionDbId,
          contextResetCount: session.contextResetCount,
        });
        // Stop further forceInit attempts — let ghost cleanup (2min) or idle reaper (15min) reclaim
        session.forceInit = false;
      } else {
        session.contextResetCount = (session.contextResetCount ?? 0) + 1;
        const historyLength = session.conversationHistory.length;
        session.previousMemorySessionId = session.memorySessionId ?? undefined;
        session.forceInit = true;
        session.conversationHistory = [];
        logger.warn('SDK', `[CONTEXT_RESET] Empty observation detected (title=null AND narrative=null, type=${emptyObs.type}), clearing conversationHistory (${historyLength} messages discarded), forcing fresh SDK session (reset #${session.contextResetCount})`, {
          sessionDbId: session.sessionDbId,
          previousMemorySessionId: session.previousMemorySessionId,
          observationCount: observations.length,
          contextResetCount: session.contextResetCount,
        });
      }
    } else {
      // Reset counter when valid observations are stored (no empty obs in this batch).
      const hasValidObs = observations.some(obs => obs.title !== null || obs.narrative !== null);
      if (hasValidObs) {
        session.contextResetCount = 0;
      }
    }
  }

  // CLAIM-CONFIRM: Now that storage succeeded, confirm all processing messages (delete from queue)
  // This is the critical step that prevents message loss on generator crash
  const pendingStore = sessionManager.getPendingMessageStore(session.dbPath);
  for (const messageId of session.processingMessageIds) {
    pendingStore.confirmProcessed(messageId);
  }
  if (session.processingMessageIds.length > 0) {
    logger.debug('QUEUE', `CONFIRMED_BATCH | sessionDbId=${session.sessionDbId} | count=${session.processingMessageIds.length} | ids=[${session.processingMessageIds.join(',')}]`);
  }
  // Clear the tracking array after confirmation
  session.processingMessageIds = [];

  // AFTER transaction commits - async operations (can fail safely without data loss)
  await syncAndBroadcastObservations(
    observations,
    result,
    session,
    dbManager,
    worker,
    discoveryTokens,
    agentName,
    projectRoot
  );

  // Sync and broadcast summary if present
  await syncAndBroadcastSummary(
    summary,
    summaryForStore,
    result,
    session,
    dbManager,
    worker,
    discoveryTokens,
    agentName
  );

  // Clean up session state
  cleanupProcessedMessages(session, worker);
}

/**
 * Normalize summary for storage (convert null fields to empty strings)
 */
function normalizeSummaryForStorage(summary: ParsedSummary | null): {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string | null;
} | null {
  if (!summary) return null;

  return {
    request: summary.request || '',
    investigated: summary.investigated || '',
    learned: summary.learned || '',
    completed: summary.completed || '',
    next_steps: summary.next_steps || '',
    notes: summary.notes
  };
}

/**
 * Sync observations to Chroma and broadcast to SSE clients
 */
async function syncAndBroadcastObservations(
  observations: ParsedObservation[],
  result: StorageResult,
  session: ActiveSession,
  dbManager: DatabaseManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  agentName: string,
  projectRoot?: string
): Promise<void> {
  for (let i = 0; i < observations.length; i++) {
    const obsId = result.observationIds[i];
    const obs = observations[i];
    const chromaStart = Date.now();

    // Sync to Chroma (fire-and-forget, skipped if Chroma is disabled)
    dbManager.getChromaSync(session.dbPath)?.syncObservation(
      obsId,
      session.contentSessionId,
      session.project,
      obs,
      session.lastPromptNumber,
      result.createdAtEpoch,
      discoveryTokens
    ).then(() => {
      const chromaDuration = Date.now() - chromaStart;
      logger.debug('CHROMA', 'Observation synced', {
        obsId,
        duration: `${chromaDuration}ms`,
        type: obs.type,
        title: obs.title || '(untitled)'
      });
    }).catch((error) => {
      logger.error('CHROMA', `${agentName} chroma sync failed, continuing without vector search`, {
        obsId,
        type: obs.type,
        title: obs.title || '(untitled)'
      }, error);
    });

    // Broadcast to SSE clients (for web UI)
    // BUGFIX: Use obs.files_read and obs.files_modified (not obs.files)
    broadcastObservation(worker, {
      id: obsId,
      memory_session_id: session.memorySessionId,
      session_id: session.contentSessionId,
      type: obs.type,
      title: obs.title,
      subtitle: obs.subtitle,
      text: null,  // text field is not in ParsedObservation
      narrative: obs.narrative || null,
      facts: JSON.stringify(obs.facts),
      concepts: JSON.stringify(obs.concepts),
      files_read: JSON.stringify(obs.files_read),
      files_modified: JSON.stringify(obs.files_modified),
      project: session.project,
      prompt_number: session.lastPromptNumber,
      created_at: new Date(result.createdAtEpoch).toISOString(),
      created_at_epoch: result.createdAtEpoch
    });
  }

  // Update folder CLAUDE.md files for touched folders (fire-and-forget)
  // This runs per-observation batch to ensure folders are updated as work happens
  // Only runs if CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED is true (default: false)
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  // Handle both string 'true' and boolean true from JSON settings
  const settingValue = settings.CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED;
  const folderClaudeMdEnabled = settingValue === 'true' || settingValue === true;

  if (folderClaudeMdEnabled) {
    const allFilePaths: string[] = [];
    for (const obs of observations) {
      allFilePaths.push(...obs.files_modified);
      allFilePaths.push(...obs.files_read);
    }

    if (allFilePaths.length > 0) {
      updateFolderClaudeMdFiles(
        allFilePaths,
        session.project,
        getWorkerPort(),
        projectRoot
      ).catch(error => {
        logger.warn('FOLDER_INDEX', 'CLAUDE.md update failed (non-critical)', { project: session.project }, error as Error);
      });
    }
  }
}

/**
 * Sync summary to Chroma and broadcast to SSE clients
 */
async function syncAndBroadcastSummary(
  summary: ParsedSummary | null,
  summaryForStore: { request: string; investigated: string; learned: string; completed: string; next_steps: string; notes: string | null } | null,
  result: StorageResult,
  session: ActiveSession,
  dbManager: DatabaseManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  agentName: string
): Promise<void> {
  if (!summaryForStore || !result.summaryId) {
    return;
  }

  const chromaStart = Date.now();

  // Sync to Chroma (fire-and-forget, skipped if Chroma is disabled)
  dbManager.getChromaSync(session.dbPath)?.syncSummary(
    result.summaryId,
    session.contentSessionId,
    session.project,
    summaryForStore,
    session.lastPromptNumber,
    result.createdAtEpoch,
    discoveryTokens
  ).then(() => {
    const chromaDuration = Date.now() - chromaStart;
    logger.debug('CHROMA', 'Summary synced', {
      summaryId: result.summaryId,
      duration: `${chromaDuration}ms`,
      request: summaryForStore.request || '(no request)'
    });
  }).catch((error) => {
    logger.error('CHROMA', `${agentName} chroma sync failed, continuing without vector search`, {
      summaryId: result.summaryId,
      request: summaryForStore.request || '(no request)'
    }, error);
  });

  // Broadcast to SSE clients (for web UI)
  broadcastSummary(worker, {
    id: result.summaryId,
    session_id: session.contentSessionId,
    request: summary!.request,
    investigated: summary!.investigated,
    learned: summary!.learned,
    completed: summary!.completed,
    next_steps: summary!.next_steps,
    notes: summary!.notes,
    project: session.project,
    prompt_number: session.lastPromptNumber,
    created_at_epoch: result.createdAtEpoch
  });

  // Update Cursor context file for registered projects (fire-and-forget)
  updateCursorContextForProject(session.project, getWorkerPort()).catch(error => {
    logger.warn('CURSOR', 'Context update failed (non-critical)', { project: session.project }, error as Error);
  });
}
