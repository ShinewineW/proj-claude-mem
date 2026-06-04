/**
 * Summarize Handler - Stop
 *
 * Extracted from summary-hook.ts - sends summary request to worker.
 * Transcript parsing stays in the hook because only the hook has access to
 * the transcript file path.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, getWorkerPort, fetchWithTimeout } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { extractLastMessage } from '../../shared/transcript-parser.js';
import { stripMemoryTagsFromPrompt } from '../../utils/tag-stripping.js';
import { HOOK_EXIT_CODES, HOOK_TIMEOUTS, getTimeout } from '../../shared/hook-constants.js';
import { resolveProjectContext } from '../../shared/project-allowlist.js';
import { writeFallbackEntry } from '../../shared/fallback-queue.js';

const SUMMARIZE_TIMEOUT_MS = getTimeout(HOOK_TIMEOUTS.DEFAULT);
const RESOLVE_PROMPT_TIMEOUT_MS = 2000;

/**
 * Ask the worker for the current `prompt_number` for this contentSessionId.
 * Returns `null` when the worker can't resolve (no user_prompts row yet,
 * HTTP error, timeout). Callers must treat `null` as "write fallback without
 * prompt_number and let replay resolve at that time" to preserve the
 * durability contract (CodeX-P1).
 */
async function resolvePromptNumber(
  port: number,
  contentSessionId: string,
  dbPath: string,
): Promise<number | null> {
  try {
    const url = `http://127.0.0.1:${port}/api/sessions/resolve-prompt-number`
      + `?contentSessionId=${encodeURIComponent(contentSessionId)}`
      + `&dbPath=${encodeURIComponent(dbPath)}`;
    const res = await fetchWithTimeout(url, { method: 'GET' }, RESOLVE_PROMPT_TIMEOUT_MS);
    if (!res.ok) return null;
    const body = await res.json() as { prompt_number?: unknown };
    const pn = body.prompt_number;
    return typeof pn === 'number' && Number.isFinite(pn) && pn > 0 ? pn : null;
  } catch {
    return null;
  }
}

export const summarizeHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Ensure worker is running before any other logic
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) {
      // Worker not available — parse transcript NOW, then write to fallback queue.
      // extractLastMessage returns '' on missing/unreadable transcript (never throws).
      // Without parsing here, replay would get null and produce an empty summary.
      // prompt_number is deliberately NOT written: replay resolves at that time
      // (see worker-service.replayFallbackEntries).
      const ctx = input._projectContext ?? resolveProjectContext(input.cwd);
      if (ctx) {
        // Strip privacy tags (<private> etc.) — the transcript parser only
        // removes <system-reminder>, so <private> would otherwise reach the summary.
        const lastAssistantMessage = stripMemoryTagsFromPrompt(
          input.transcriptPath
            ? extractLastMessage(input.transcriptPath, 'assistant', true)
            : ''
        );
        writeFallbackEntry({
          type: 'summarize', sessionId: input.sessionId, cwd: input.cwd, dbPath: ctx.dbPath,
          timestamp: Date.now(),
          payload: { last_assistant_message: lastAssistantMessage }
        });
      }
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const { sessionId, cwd, transcriptPath } = input;

    const ctx = input._projectContext ?? resolveProjectContext(cwd);
    if (!ctx) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }
    const { dbPath } = ctx;
    const port = getWorkerPort();

    // Validate required fields before processing
    if (!transcriptPath) {
      // No transcript available - skip summary gracefully (not an error)
      logger.debug('HOOK', `No transcriptPath in Stop hook input for session ${sessionId} - skipping summary`);
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    // Extract last assistant message from transcript (the work Claude did)
    // Note: "user" messages in transcripts are mostly tool_results, not actual user input.
    // The user's original request is already stored in user_prompts table.
    // Strip privacy tags before this value flows into the summarize POST / fallback.
    // extractLastMessage only removes <system-reminder>; <private> must be stripped here.
    const lastAssistantMessage = stripMemoryTagsFromPrompt(
      extractLastMessage(transcriptPath, 'assistant', true)
    );

    // F5 — hook-side prompt_number resolution. Ask the worker before POSTing
    // summarize so the turn key is authoritative at enqueue time. Older
    // clients may still omit prompt_number and rely on SessionRoutes'
    // server-side fallback, but this hook path writes a fallback entry if
    // pre-resolution fails to avoid mis-binding the summary to a later turn.
    const promptNumber = await resolvePromptNumber(port, sessionId, dbPath);
    if (promptNumber === null) {
      logger.warn('HOOK', 'Summarize prompt-number resolve failed, writing fallback', {
        sessionId,
        dbPath,
      });
      writeFallbackEntry({
        type: 'summarize', sessionId, cwd, dbPath,
        timestamp: Date.now(),
        payload: { last_assistant_message: lastAssistantMessage }
      });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    logger.dataIn('HOOK', 'Stop: Requesting summary', {
      workerPort: port,
      hasLastAssistantMessage: !!lastAssistantMessage,
      promptNumber,
    });

    // Send to worker - worker handles privacy check and database operations
    try {
      const body = {
        contentSessionId: sessionId,
        last_assistant_message: lastAssistantMessage,
        prompt_number: promptNumber,
        dbPath,
      };
      const response = await fetchWithTimeout(
        `http://127.0.0.1:${port}/api/sessions/summarize`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        SUMMARIZE_TIMEOUT_MS
      );

      if (!response.ok) {
        logger.warn('HOOK', 'Summarize storage failed, writing fallback', { status: response.status });
        // Durability contract (CodeX-P1): omit prompt_number when writing
        // fallback; replay resolves from user_prompts at replay time.
        writeFallbackEntry({
          type: 'summarize', sessionId, cwd, dbPath,
          timestamp: Date.now(),
          payload: { last_assistant_message: lastAssistantMessage }
        });
        return { continue: true, suppressOutput: true };
      }

      logger.debug('HOOK', 'Summary request sent successfully');
    } catch (error) {
      logger.warn('HOOK', 'Summarize fetch error, writing fallback', { error: error instanceof Error ? error.message : String(error) });
      writeFallbackEntry({
        type: 'summarize', sessionId, cwd, dbPath,
        timestamp: Date.now(),
        payload: { last_assistant_message: lastAssistantMessage }
      });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    return { continue: true, suppressOutput: true };
  }
};
