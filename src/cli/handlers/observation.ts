/**
 * Observation Handler - PostToolUse
 *
 * Extracted from save-hook.ts - sends tool usage to worker for storage.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { getWorkerPort, fetchWithTimeout } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { isProjectExcluded } from '../../utils/project-filter.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { resolveProjectContext } from '../../shared/project-allowlist.js';
import { writeFallbackEntry } from '../../shared/fallback-queue.js';

export const observationHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId, cwd, toolName, toolInput, toolResponse } = input;

    // 1. Quick exit if no tool name
    if (!toolName) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    // 2. cwd validation (ctx depends on cwd)
    if (!cwd) {
      throw new Error(`Missing cwd in PostToolUse hook input for session ${sessionId}, tool ${toolName}`);
    }

    // 3. Project context resolution (must be before worker check — fallback needs dbPath)
    const ctx = input._projectContext ?? resolveProjectContext(cwd);
    if (!ctx) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }
    const { dbPath } = ctx;

    // 4. Exclusion check
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    if (isProjectExcluded(cwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS)) {
      logger.debug('HOOK', 'Project excluded from tracking, skipping observation', { cwd, toolName });
      return { continue: true, suppressOutput: true };
    }

    // 5. No pre-flight health check — fetchWithTimeout catch handles worker-down (P2)

    // 6. Main path: log + POST to worker
    const port = getWorkerPort();
    const toolStr = logger.formatTool(toolName, toolInput);
    logger.dataIn('HOOK', `PostToolUse: ${toolStr}`, { workerPort: port });

    // Send to worker - worker handles privacy check and database operations
    try {
      const response = await fetchWithTimeout(
        `http://127.0.0.1:${port}/api/sessions/observations`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contentSessionId: sessionId,
            tool_name: toolName,
            tool_input: toolInput,
            tool_response: toolResponse,
            cwd,
            dbPath
          })
        },
        10_000
      );

      if (!response.ok) {
        logger.warn('HOOK', 'Observation storage failed, writing fallback', { status: response.status, toolName });
        writeFallbackEntry({
          type: 'observation', sessionId, cwd, dbPath,
          timestamp: Date.now(),
          payload: { tool_name: toolName, tool_input: toolInput, tool_response: toolResponse }
        });
        return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
      }

      logger.debug('HOOK', 'Observation sent successfully', { toolName });
    } catch (error) {
      logger.warn('HOOK', 'Observation fetch error, writing fallback', { error: error instanceof Error ? error.message : String(error) });
      writeFallbackEntry({
        type: 'observation', sessionId, cwd, dbPath,
        timestamp: Date.now(),
        payload: { tool_name: toolName, tool_input: toolInput, tool_response: toolResponse }
      });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    return { continue: true, suppressOutput: true };
  }
};
